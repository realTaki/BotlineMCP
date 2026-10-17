import {hash,nonce,requireThat,signedHeaders} from './security.js';
import {getAgent} from './agents.js';
import {telegramHumanAllowed,telegramSenderAllowed} from './telegram-policy.js';

export const DOT_INBOX_POLICY={payloadTtl:86400000,maxMessages:512,pageSize:50,maxPageSize:100,wakeCooldown:30000,wakeLease:30000,maxAttempts:8};
// Logical routing under the existing shared instance authority, not a new account.
// A Cursor-configured recipient always retains its existing delivery path.
export const isDotInboxAgent=agent=>agent?.handle==='dot'&&!agent.grokbot_agent_name&&!agent.grokbotAgentName;
const identity=p=>({kind:p.kind,id:p.id,...(p.handle?{handle:p.handle}:{})});
const publicMessage=data=>({message_id:data.message_id,sender:identity(data.sender),text:data.text,...(data.confirmation?{confirmation:data.confirmation}:{}),...(data.reply_to_message_id?{reply_to_message_id:data.reply_to_message_id}:{})});
export class DotInbox {
 constructor(app){this.app=app;this.store=app.store;}
 async actor(p,store=this.store){
  requireThat(p?.agentId&&await this.app.ownerActive(p.owner),'Authentication required',403);
  const actor=await getAgent({store},p.owner,p.agentId);
  requireThat(isDotInboxAgent(actor),'Inbox is available only to the selected dot recipient',403);return actor;
 }
 async enqueue(tx,owner,event,agentId){
  const messages=(await tx.list('dot_inbox',owner)).filter(d=>d.agentId===agentId);
  requireThat(messages.length<DOT_INBOX_POLICY.maxMessages,'Dot inbox capacity reached; retry after ACK or expiry',503);
  const wake=await tx.get('dot_wake',agentId),sequence=(wake?.sequence??0)+1;
  await tx.insert('dot_inbox',hash(`${event.eventId}:${agentId}`),{owner,agentId,event,sequence,expires:Date.now()+DOT_INBOX_POLICY.payloadTtl});
  // New traffic reopens exhausted retries, but does not defeat burst coalescing.
  await tx.put('dot_wake',agentId,{...wake,owner,agentId,sequence,wakeId:null,attempts:0,next:!messages.length||wake?.exhausted?0:wake?.next??0,exhausted:false});
 }
 async allowed(d,store=this.store){
  if(d.expires<=Date.now()||!await this.app.ownerActive(d.owner))return false;
  const tg=d.event.data.telegram;
  if(!tg)return isDotInboxAgent(await getAgent({store},d.owner,d.agentId));
  const s=await store.telegramReactionSnapshot(tg.bot_id,d.owner,d.agentId,'');
  const sender=d.event.data.sender,b=s.bot,route=s.route;
  return s.agent?.owner===d.owner&&isDotInboxAgent(s.agent)&&b?.owner===d.owner&&b.active&&route?.owner===d.owner&&route.agentId===d.agentId&&route.bindingId===tg.binding_id&&
   (!sender.handle||sender.kind!=='human'||s.humans.some(h=>h.handle===sender.handle&&h.telegram_user_id===sender.id))&&
   telegramHumanAllowed(s.humans,tg.chat_id)&&telegramSenderAllowed({from:{id:sender.id,is_bot:sender.is_bot??false},chat:{id:tg.chat_id,type:'private'}},s.humans);
 }
 async list(p,args={}){
  requireThat(Object.keys(args).every(k=>['cursor','limit'].includes(k)),'Invalid inbox arguments');
  const limit=args.limit??DOT_INBOX_POLICY.pageSize,cursor=args.cursor??0;
  requireThat(Number.isInteger(limit)&&limit>=1&&limit<=DOT_INBOX_POLICY.maxPageSize,'Invalid limit');
  requireThat(Number.isSafeInteger(cursor)&&cursor>=0,'Invalid cursor');
  return this.store.withLock('dms:'+p.owner,async tx=>{
   await this.actor(p,tx);await tx.pruneGroupTransport();
   const rows=(await tx.list('dot_inbox',p.owner)).filter(d=>d.agentId===p.agentId&&d.sequence>cursor).sort((a,b)=>a.sequence-b.sequence),visible=[];
   for(const d of rows)if(await this.allowed(d,tx))visible.push(d);
   const page=visible.slice(0,limit);
   if(!visible.length&&cursor===0){const wake=await tx.get('dot_wake',p.agentId);if(wake)await tx.put('dot_wake',p.agentId,{...wake,next:0});}
   return {messages:page.map(d=>publicMessage(d.event.data)),next_cursor:visible.length>limit?page.at(-1).sequence:null};
  });
 }
 async ack(p,args={}){
  requireThat(Object.keys(args).every(k=>k==='message_ids')&&Array.isArray(args.message_ids)&&args.message_ids.length>0&&args.message_ids.length<=100&&args.message_ids.every(id=>typeof id==='string'&&/^[\w-]{1,128}$/.test(id)),'Invalid message_ids');
  const result=await this.store.withLock('dms:'+p.owner,async tx=>{
   await this.actor(p,tx);await tx.pruneGroupTransport();
   const acknowledged=[];
   for(const messageId of new Set(args.message_ids)){
    const id=hash(`${messageId}:${p.agentId}`),d=await tx.get('dot_inbox',id);
    // Missing/expired/already-ACKed IDs are the same successful no-op. Never
    // reveal whether an ID belongs to another recipient, or delete their row.
    if(d){requireThat(d.owner===p.owner&&d.agentId===p.agentId&&await this.allowed(d,tx),'Inbox message is no longer authorized',403);await tx.delete('dot_inbox',id);}
    acknowledged.push(messageId);
   }
   const wake=await tx.get('dot_wake',p.agentId);
   if(wake)await tx.put('dot_wake',p.agentId,{...wake,next:0,attempts:0,exhausted:false});
   return {acknowledged};
  });
  // Wake any concurrently arrived, unacknowledged messages after committing ACK.
  // Notification failure cannot turn a committed ACK into a destructive retry.
  try{await this.dispatch(p.owner,id=>hash(JSON.stringify([id,'chat.created',null])));}catch{}
  return result;
 }
 async dispatch(owner,inboxId){
  const candidates=(await this.store.list('dot_wake',owner));
  let attempted=0;const deadline=Date.now()+20000;
  for(const candidate of candidates){
   if(attempted>=16||Date.now()>=deadline)break;
   const reservation=await this.store.withLock('dms:'+owner,async tx=>{
    const wake=await tx.get('dot_wake',candidate.agentId),now=Date.now();
    if(!wake||wake.next>now||wake.leaseUntil>now||wake.exhausted)return;
    if(!isDotInboxAgent(await getAgent({store:tx},owner,candidate.agentId)))return;
    const sub=await tx.get('group_subscription',inboxId(candidate.agentId));
    if(!sub||sub.owner!==owner||sub.agentId!==candidate.agentId||sub.expires<=now)return;
    const rows=(await tx.list('dot_inbox',owner)).filter(d=>d.agentId===candidate.agentId);
    let ready=false;for(const d of rows)if(await this.allowed(d,tx)){ready=true;break;}
    if(!ready)return;
    const token=nonce(),wakeId=wake.wakeId??'inbox_'+nonce();await tx.put('dot_wake',candidate.agentId,{...wake,wakeId,token,leaseUntil:now+DOT_INBOX_POLICY.wakeLease});
    return {wake:{...wake,wakeId},sub,token};
   });
   if(!reservation)continue;attempted++;
   const {wake,sub,token}=reservation,id=inboxId(candidate.agentId);
   const eventId=wake.wakeId,body=JSON.stringify({eventId,name:'agent.notification',timestamp:new Date().toISOString(),data:{type:'inbox.ready'},cursor:null});
   let status=0;
   try{const headers=signedHeaders(this.app.decrypt(sub.secret),id,eventId,body);if(sub.oldSecret&&sub.rotateUntil>Date.now())headers['webhook-signature']+=' '+signedHeaders(this.app.decrypt(sub.oldSecret),id,eventId,body,Number(headers['webhook-timestamp']))['webhook-signature'];status=(await this.app.post(sub.url,headers,body)).status;}catch{}
   const changedDuringWake=await this.store.withLock('dms:'+owner,async tx=>{
    const current=await tx.get('dot_wake',candidate.agentId);if(current?.token!==token)return;
    const drained=!(await tx.list('dot_inbox',owner)).some(d=>d.agentId===candidate.agentId&&d.expires>Date.now());
    const changed=current.sequence!==wake.sequence,accepted=status>=200&&status<300,attempts=changed?0:(current.attempts??0)+1;
    await tx.put('dot_wake',candidate.agentId,{...current,token:null,wakeId:accepted||changed?null:current.wakeId,leaseUntil:0,attempts:accepted?0:attempts,lastStatus:status,exhausted:!accepted&&!changed&&attempts>=DOT_INBOX_POLICY.maxAttempts,next:changed||drained?0:Date.now()+(accepted?DOT_INBOX_POLICY.wakeCooldown:Math.min(300000,1000*2**attempts))});return changed;
   });
   if(changedDuringWake)candidates.push(candidate);
  }
 }
 async refresh(owner,agentId){
  await this.store.withLock('dms:'+owner,async tx=>{const wake=await tx.get('dot_wake',agentId);if(wake)await tx.put('dot_wake',agentId,{...wake,wakeId:null,attempts:0,exhausted:false,next:0});});
 }
}
