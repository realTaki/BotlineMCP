import {hash,nonce,signedHeaders,requireThat} from './security.js';
import {getAgent} from './agents.js';
import {listHumans} from './telegram-owner.js';
import {telegramHumanAllowed} from './telegram-policy.js';

const CATALOG=Object.freeze({
 telegram_reaction_failed:{message:'BotlineMCP accepted the message, but its received reaction could not be confirmed.',action:'Message relay continues. Check whether Telegram allows the bot to react with the eyes emoji in this chat. Do not resend the original message or blindly retry an uncertain reaction.',retryable:false},
 reconnect_required:{message:'This OAuth connection needs to be reconnected before a logical identity can be registered.',action:'Ask the user to reconnect this MCP connection through its normal OAuth flow, then retry agent_register in that same connection. Do not bypass verification or create a duplicate identity.',retryable:false},
 binding_setup_failed:{message:'Telegram binding setup did not complete.',action:'Read the returned binding state and telegram_bot_get. If retry_existing_bot_id is true, retry the same existing_bot_id after correcting the reported setup issue; never expose the stored token or force takeover of another webhook.',retryable:true},
 invalid_parameters:{message:'Request parameters were rejected.',action:'Check the tool schema and correct the parameters before retrying.',retryable:false},
 authentication_required:{message:'Authentication is required.',action:'Reconnect the authorized client, then retry. Never include credentials in an error report.',retryable:false},
 forbidden:{message:'This operation is not permitted.',action:'Check the selected agent, recipient handle and owner-approved Telegram access. Do not expand access without approval.',retryable:false},
 not_found:{message:'The requested resource was not found.',action:'Verify the current agent and recipient handle before retrying.',retryable:false},
 rate_limited:{message:'The relay is temporarily rate limited.',action:'Wait before retrying with the same request ID.',retryable:true},
 relay_delivery_failed:{message:'An event could not be delivered to its agent listener.',action:'Check and renew the agent.notification inbox subscription. Do not resend uncertain Telegram messages with a new request ID.',retryable:true},
 grokbot_delivery_failed:{message:'The private DM could not be delivered to the Grok Bot.',action:'Confirm grokbot_agent_name is registered and a Cursor API key is stored. Retry with the same request_id.',retryable:true},
 cursor_key_unreadable:{message:'The stored Cursor API key is missing or could not be decrypted.',action:'Call cursor_key_set or agent_register with cursor_api_key. Rotating ASP_API_KEY makes previously stored keys unreadable.',retryable:false},
 subscription_failed:{message:'The agent listener could not be established.',action:'Check the callback verification response, delivery URL and subscription configuration, then subscribe again.',retryable:true},
 queue_full:{message:'The relay delivery queue is full.',action:'Restore the affected listeners and let pending events drain before retrying with the same request ID. For dot, process messages_inbox and explicitly ACK processed IDs, or wait for payload expiry.',retryable:true},
 internal_error:{message:'The relay could not complete the operation.',action:'Check the operation state before retrying; do not repeat an uncertain send. If diagnosis needs human input, contact the user in your own agent product with this error ID and sanitized details.',retryable:false}
});
export const RELAY_ERROR_POLICY=Object.freeze({ttl:86400000,maxRecords:128,dedupWindow:60000,maxAttempts:8,maxBatch:4,dispatchMs:10000,requestMs:2000});
export function relayErrorDetails(code){const selected=Object.hasOwn(CATALOG,code)?code:'internal_error';return {code:selected,...CATALOG[selected]};}
const publicError=record=>({error_id:record.error_id,...relayErrorDetails(record.code),notification:{agent:record.agent.state,telegram:record.telegram.state}});
async function bounded(promise,ms){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Delivery deadline reached')),ms);})]);}finally{clearTimeout(timer);}}
export class RelayErrors {
 constructor(app){this.app=app;}
 async report({owner,agentId,chatId,code}={}){
  requireThat(typeof owner==='string'&&owner.length>0,'Error owner required');
  const details=relayErrorDetails(code),now=Date.now();
  const selectedAgent=typeof agentId==='string'&&agentId.length<=256?agentId:null,selectedChat=typeof chatId==='string'&&chatId.length<=256?chatId:null;
  const id=hash(JSON.stringify([owner,selectedAgent,selectedChat,details.code,Math.floor(now/RELAY_ERROR_POLICY.dedupWindow)]));
  const result=await this.app.store.withLock('relay-errors:'+owner,async store=>{
   const records=await store.list('relay_error',owner);for(const record of records)if(record.expires<=now)await store.delete('relay_error',record.id);
   const old=await store.get('relay_error',id);if(old)return {id,record:old};
   const record={owner,agentId:selectedAgent,chatId:selectedChat,code:details.code,error_id:'err_'+nonce(),created:now,expires:now+RELAY_ERROR_POLICY.ttl,leaseUntil:0,agent:{state:'pending',attempts:0,next:0},telegram:{state:details.code==='telegram_reaction_failed'?'not_applicable':'unavailable'}};
   if(records.filter(record=>record.expires>now).length>=RELAY_ERROR_POLICY.maxRecords)return {record:{...record,agent:{state:'capacity_limited'},telegram:{state:'capacity_limited'}}};
   await store.put('relay_error',id,record);return {id,record};
  });
  await this.dispatch(owner);
  if(result.id){result.record=await this.app.store.get('relay_error',result.id)??result.record;}
  return publicError(result.record);
 }
 async dispatch(owner){
  const deadline=Date.now()+RELAY_ERROR_POLICY.dispatchMs;
  const records=await this.app.store.list('relay_error',owner);let attempted=0;
  for(const candidate of records){
   if(candidate.expires<=Date.now()){await this.app.store.delete('relay_error',candidate.id);continue;}
   if(Date.now()>=deadline||attempted>=RELAY_ERROR_POLICY.maxBatch)break;
   if(candidate.agent.state!=='pending'&&candidate.telegram.state!=='unavailable')continue;
   const record=await this.app.store.lease('relay_error',candidate.id,120000);if(!record||record.expires<=Date.now())continue;
   const id=candidate.id;
   try{
    const active=typeof this.app.ownerActive!=='function'||await this.app.ownerActive(owner);
    if(!active)continue;
    let didAttempt=false;
    if(record.agent.state==='pending'&&record.agent.attempts>=RELAY_ERROR_POLICY.maxAttempts){record.agent.state='failed';await this.app.store.put('relay_error',id,record);}
    if(record.agent.state==='pending'&&record.agent.next<=Date.now()&&record.agent.attempts<RELAY_ERROR_POLICY.maxAttempts&&record.agentId&&await getAgent(this.app,owner,record.agentId)){
     const sid=hash(JSON.stringify([record.agentId,'chat.created',null])),sub=await this.app.store.get('group_subscription',sid);
     // Old chat.created listeners cannot interpret relay.error payloads.
     if(sub?.owner===owner&&sub.agentId===record.agentId&&sub.name==='agent.notification'&&sub.chatId==null&&sub.expires>Date.now()&&typeof sub.url==='string'&&typeof sub.secret==='string'){
      const remaining=Math.min(RELAY_ERROR_POLICY.requestMs,deadline-Date.now());
      if(remaining>0){
       didAttempt=true;record.agent.attempts++;record.agent.next=Date.now()+Math.min(300000,1000*2**record.agent.attempts);
       await this.app.store.put('relay_error',id,record);
       const event={eventId:record.error_id,name:'agent.notification',timestamp:new Date(record.created).toISOString(),data:{type:'relay.error',error:{error_id:record.error_id,...relayErrorDetails(record.code)},...(record.chatId?{chat_id:record.chatId}:{})},cursor:null};
       const body=JSON.stringify(event);let status=0;
       try{const headers=signedHeaders(this.app.decrypt(sub.secret),sub.publicId??sid,record.error_id,body);if(sub.oldSecret&&sub.rotateUntil>Date.now())headers['webhook-signature']+=' '+signedHeaders(this.app.decrypt(sub.oldSecret),sub.publicId??sid,record.error_id,body,Number(headers['webhook-timestamp']))['webhook-signature'];status=(await bounded(this.app.post(sub.url,headers,body),remaining)).status;}catch{}
       record.agent.state=status>=200&&status<300?'sent':(status>=400&&status<500&&status!==429)||record.agent.attempts>=RELAY_ERROR_POLICY.maxAttempts?'failed':'pending';
       await this.app.store.put('relay_error',id,record);
      }
     }
    }
    if(record.telegram.state==='unavailable'&&record.chatId&&Date.now()<deadline){
     const sent=await this.telegram(id,record,deadline);didAttempt=sent||didAttempt;
    }
    if(didAttempt)attempted++;
   }finally{
    const latest=await this.app.store.get('relay_error',id);if(latest)await this.app.store.put('relay_error',id,{...latest,leaseUntil:0});
   }
  }
 }
 async telegram(id,record,deadline){
  return this.app.store.withBotLock('bot-binding:'+record.owner,async store=>{
   const current=await store.get('relay_error',id);if(!current||current.expires<=Date.now()||current.telegram.state!=='unavailable'||Date.now()>=deadline)return false;
   const chat=await store.get('chat',record.chatId);if(chat?.owner!==record.owner||!chat.telegram||!chat.agent_ids?.includes(record.agentId))return false;
   const bot=await store.get('bot',chat.telegram.bot_id),route=await store.get('group_bot',chat.telegram.bot_id),app=Object.assign(Object.create(Object.getPrototypeOf(this.app)),this.app,{store});
   if(!bot?.active||bot.owner!==record.owner||!bot.token||route?.owner!==record.owner||route.agentId!==record.agentId||typeof route.bindingId!=='string'||route.bindingId!==chat.telegram.binding_id||!await getAgent(app,record.owner,record.agentId)||!telegramHumanAllowed(await listHumans(app,record.owner),chat.telegram.chat_id))return false;
   current.telegram={state:'uncertain',attempted_at:Date.now()};await store.put('relay_error',id,current);
   try{await bounded(app.telegram(app.decrypt(bot.token),'sendMessage',{chat_id:chat.telegram.chat_id,text:`服务暂时遇到问题（${record.error_id}），请让 agent 根据错误编号排查。`}),Math.max(1,Math.min(RELAY_ERROR_POLICY.requestMs,deadline-Date.now())));current.telegram.state='sent';}
   catch(error){current.telegram.state=error?.telegramOutcome==='failed'?'failed':'uncertain';}
   await store.put('relay_error',id,current);return true;
  });
 }
}

