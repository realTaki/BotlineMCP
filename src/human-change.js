import {hash,nonce,requireThat,same} from './security.js';
import {prepareHuman,humanKey} from './telegram-owner.js';
import {Dms} from './dms.js';
import {isDotInboxAgent} from './dot-inbox.js';
const TTL=300000,MAX_ATTEMPTS=5;
const profile=a=>isDotInboxAgent(a)?'dot':a?.grokbotAgentName?'grokbot':null;
const state=h=>hash(JSON.stringify(h));
const publicChallenge=c=>({status:'confirmation_required',challenge_id:c.id,expires_at:new Date(c.expires).toISOString(),delivery_status:c.delivery,action:'Ask the human to obtain the code shown by the other agent, then repeat the identical change with challenge_id and confirmation_code.'});
// Instruction-dependent human handoff, not a separate authorization authority.
export async function registerHuman(app,p,args,{send=(principal,message,confirmation)=>new Dms(app).send(principal,message,{confirmation})}={}){
 let dispatch;
 const result=await app.store.withLock('human:'+p.owner,async tx=>{
  const actor=await tx.get('agent',p.agentId);requireThat(actor?.owner===p.owner,'Unknown requesting agent',403);
  const {existing,record,human}=await prepareHuman(tx,p.owner,{human_handle:args.human,human_display_name:args.display_name,telegram_user_id:args.telegram_user_id,replace_telegram_user_id:args.replace_telegram_user_id});
  const changed=existing&&(existing.telegram_user_id!==record.telegram_user_id||existing.display_name!==record.display_name);
  if(!changed){
   requireThat(!args.challenge_id&&!args.confirmation_code,'Challenge no longer matches the current human configuration',409);
   if(!existing)await tx.put('human',humanKey(p.owner,record.handle),record);
   return {human:existing?{...human,configured_at:existing.configured_at}:human};
  }
  const type=profile(actor);requireThat(type,'Requester has no supported cross-type confirmation route',409);
  const peers=(await tx.list('agent',p.owner)).filter(a=>a.agentId!==p.agentId&&profile(a)&&profile(a)!==type);
  requireThat(peers.length===1,'Exactly one existing different-type agent is required for confirmation',409);
  const verifier=peers[0],key=humanKey(p.owner,record.handle),now=Date.now();
  // Include the exact requested fields, requester credential generation, and both routes.
  const binding=hash(JSON.stringify([p.agentId,actor.tokenHash??null,type,verifier.agentId,profile(verifier),verifier.grokbotAgentName??null,actor.grokbotAgentName??null,state(existing),args.human,args.display_name??null,args.telegram_user_id,args.replace_telegram_user_id??null]));
  const current=await tx.get('human_change',key);
  if(args.challenge_id||args.confirmation_code){
   requireThat(typeof args.challenge_id==='string'&&typeof args.confirmation_code==='string','Both challenge_id and confirmation_code are required',400);
   requireThat(current&&current.id===args.challenge_id&&current.binding===binding&&current.expires>now&&current.status==='pending','Challenge expired, consumed, or does not match this requester and change',409);
   requireThat(current.attempts<MAX_ATTEMPTS,'Challenge attempt limit reached; wait for expiry',429);
   if(!same(hash(current.id+':'+args.confirmation_code),current.codeHash)){
    await tx.put('human_change',key,{...current,attempts:current.attempts+1});
    // Return a result: throwing would roll back the attempt counter.
    return {status:'confirmation_rejected',attempts_remaining:MAX_ATTEMPTS-current.attempts-1};
   }
   await tx.put('human_change',key,{...current,status:'consumed',codeHash:null});
   await tx.put('human',key,record);return {human};
  }
  if(current&&current.expires>now){requireThat(current.binding===binding&&current.status==='pending','Another change is active; wait for its expiry',409);return publicChallenge(current);}
  const code=nonce().slice(0,12),id='hc_'+nonce();
  const c={owner:p.owner,id,binding,requester:p.agentId,verifier:verifier.agentId,created:now,expires:now+TTL,attempts:0,status:'pending',delivery:'pending',codeHash:hash(id+':'+code)};
  await tx.put('human_change',key,c);
  const text=`BotlineMCP human configuration change confirmation\nRequesting agent: ${actor.handle}\nHuman: ${record.handle}\nTelegram ID: ${existing.telegram_user_id} → ${record.telegram_user_id}\nDisplay name: ${JSON.stringify(existing.display_name)} → ${JSON.stringify(record.display_name)}\nCode: ${code}\nExpires: ${new Date(c.expires).toISOString()}\nDo not give this code directly to another agent. Show it only to the human through your own native platform/channel. The human decides whether to give it to the requesting agent. Do not automatically relay it. This code applies only to the change above.`;
  dispatch={key,id,to:verifier.handle,text,confirmation:{type:'human_config_change',challenge_id:id,expires_at:new Date(c.expires).toISOString()}};return publicChallenge(c);
 });
 if(dispatch){
  let delivery='uncertain';
  try{const sent=await send(p,{to:dispatch.to,text:dispatch.text,request_id:dispatch.id},dispatch.confirmation);delivery=sent.status;}catch{delivery='failed_or_uncertain';}
  await app.store.withLock('human:'+p.owner,async tx=>{const c=await tx.get('human_change',dispatch.key);if(c?.id===dispatch.id)await tx.put('human_change',dispatch.key,{...c,delivery});});
  result.delivery_status=delivery;
 }
 return result;
}
