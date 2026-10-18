import {hash,requireThat} from './security.js';
import {getAgent} from './agents.js';
import {telegramHumanAllowed,telegramSenderAllowed} from './telegram-policy.js';

// Inbox for `muse` bot-type agents (e.g. Muse instances on outbound-only VMs).
// Same poll pattern as the dot inbox, but without webhook wake hints: muse
// agents cannot receive inbound callbacks, so they poll messages_inbox on a
// schedule and ACK after processing. Telegram payloads retain the same
// current-human and binding-generation checks as the dot inbox.
export const MUSE_INBOX_POLICY={payloadTtl:86400000,maxMessages:512,pageSize:50,maxPageSize:100};
export const isMuseAgent=agent=>agent?.botType==='muse'||agent?.bot_type==='muse';
const identity=p=>({kind:p.kind,id:p.id,...(p.handle?{handle:p.handle}:{})});
const publicMessage=data=>({message_id:data.message_id,sender:identity(data.sender),text:data.text,...(data.confirmation?{confirmation:data.confirmation}:{}),...(data.reply_to_message_id?{reply_to_message_id:data.reply_to_message_id}:{})});
export class MuseInbox {
 constructor(app){this.app=app;this.store=app.store;}
 async actor(p,store=this.store){
  requireThat(p?.agentId&&await this.app.ownerActive(p.owner),'Authentication required',403);
  const actor=await getAgent({store},p.owner,p.agentId);
  requireThat(isMuseAgent(actor),'Inbox is available only to muse agents',403);return actor;
 }
 async enqueue(tx,owner,event,agentId){
  const messages=await tx.listAgentInbox(owner,agentId);
  requireThat(messages.length<MUSE_INBOX_POLICY.maxMessages,'Muse inbox capacity reached; retry after ACK or expiry',503);
  const seq=await tx.get('muse_seq',agentId),sequence=(seq?.sequence??0)+1;
  await tx.put('muse_seq',agentId,{owner,agentId,sequence});
  await tx.insert('muse_inbox',hash(`${event.eventId}:${agentId}`),{owner,agentId,event,sequence,expires:Date.now()+MUSE_INBOX_POLICY.payloadTtl});
 }
 async allowed(d,store=this.store){
  if(d.expires<=Date.now()||!await this.app.ownerActive(d.owner))return false;
  const tg=d.event.data.telegram;
  if(!tg)return isMuseAgent(await getAgent({store},d.owner,d.agentId));
  const s=await store.telegramReactionSnapshot(tg.bot_id,d.owner,d.agentId,'');
  const sender=d.event.data.sender,b=s.bot,route=s.route;
  return s.agent?.owner===d.owner&&isMuseAgent(s.agent)&&b?.owner===d.owner&&b.active&&route?.owner===d.owner&&route.agentId===d.agentId&&route.bindingId===tg.binding_id&&
   (!sender.handle||sender.kind!=='human'||s.humans.some(h=>h.handle===sender.handle&&h.telegram_user_id===sender.id))&&
   telegramHumanAllowed(s.humans,tg.chat_id)&&telegramSenderAllowed({from:{id:sender.id,is_bot:sender.is_bot??false},chat:{id:tg.chat_id,type:'private'}},s.humans);
 }
 async list(p,args={}){
  requireThat(Object.keys(args).every(k=>['cursor','limit'].includes(k)),'Invalid inbox arguments');
  const limit=args.limit??MUSE_INBOX_POLICY.pageSize,cursor=args.cursor??0;
  requireThat(Number.isInteger(limit)&&limit>=1&&limit<=MUSE_INBOX_POLICY.maxPageSize,'Invalid limit');
  requireThat(Number.isSafeInteger(cursor)&&cursor>=0,'Invalid cursor');
  return this.store.withLock('dms:'+p.owner,async tx=>{
   await this.actor(p,tx);await tx.pruneGroupTransport();
   const rows=(await tx.listAgentInbox(p.owner,p.agentId)).filter(d=>d.sequence>cursor).sort((a,b)=>a.sequence-b.sequence),visible=[];
   for(const d of rows)if(await this.allowed(d,tx))visible.push(d);
   const page=visible.slice(0,limit);
   return {messages:page.map(d=>publicMessage(d.event.data)),next_cursor:visible.length>limit?page.at(-1).sequence:null};
  });
 }
 async ack(p,args={}){
  requireThat(Object.keys(args).every(k=>k==='message_ids')&&Array.isArray(args.message_ids)&&args.message_ids.length>0&&args.message_ids.length<=100&&args.message_ids.every(id=>typeof id==='string'&&/^[\w-]{1,128}$/.test(id)),'Invalid message_ids');
  return this.store.withLock('dms:'+p.owner,async tx=>{
   await this.actor(p,tx);await tx.pruneGroupTransport();
   const acknowledged=[];
   for(const messageId of new Set(args.message_ids)){
    const id=hash(`${messageId}:${p.agentId}`),d=await tx.get('muse_inbox',id);
    // Missing/expired/already-ACKed IDs are the same successful no-op. Never
    // reveal whether an ID belongs to another recipient, or delete their row.
    if(d){requireThat(d.owner===p.owner&&d.agentId===p.agentId&&await this.allowed(d,tx),'Inbox message is no longer authorized',403);await tx.delete('muse_inbox',id);}
    acknowledged.push(messageId);
   }
   return {acknowledged};
  });
 }
}
