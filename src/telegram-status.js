import {hash,requireThat} from './security.js';
import {getAgent} from './agents.js';
import {listHumans} from './telegram-owner.js';
import {telegramHumanAllowed} from './telegram-policy.js';

export const TELEGRAM_STATUS_TEXT=Object.freeze({connecting:'正在连接 agent，请稍候。',ready:'已连接，可以开始聊天。',queued:'消息已暂存，连接后投递。'});
export class TelegramStatus {
 constructor(app){this.app=app;}
 async notify(chatId,kind){
  requireThat(Object.hasOwn(TELEGRAM_STATUS_TEXT,kind),'Invalid Telegram status kind');
  const initial=typeof chatId==='string'?await this.app.store.get('chat',chatId):null;
  const skip=reason=>({kind,status:'skipped',reason});
  if(!initial?.owner||!initial.telegram)return skip('unmapped_chat');
  return this.app.store.withBotLock('bot-binding:'+initial.owner,async store=>{
   const app=Object.assign(Object.create(Object.getPrototypeOf(this.app)),this.app,{store});
   const chat=await store.get('chat',chatId);if(chat?.owner!==initial.owner||!chat.telegram)return skip('unmapped_chat');
   const bot=await store.get('bot',chat.telegram.bot_id),route=await store.get('group_bot',chat.telegram.bot_id);
   if(!bot?.active||bot.owner!==chat.owner||!bot.token||route?.owner!==chat.owner||typeof route.bindingId!=='string'||route.bindingId!==chat.telegram.binding_id||!chat.agent_ids?.includes(route.agentId)||!await getAgent(app,chat.owner,route.agentId)||!telegramHumanAllowed(await listHumans(app,chat.owner),chat.telegram.chat_id))return skip('unauthorized_chat');
   if(chat.status_notices?.[kind])return skip('already_attempted');
   const id=hash(JSON.stringify([route.agentId,'message.created',chatId])),sub=await store.get('group_subscription',id);
   const listening=sub?.owner===chat.owner&&sub.agentId===route.agentId&&['message.created','agent.notification'].includes(sub.name)&&sub.chatId===chatId&&Number.isFinite(sub.expires)&&sub.expires>Date.now()&&typeof sub.url==='string'&&sub.url.length>0&&typeof sub.secret==='string'&&sub.secret.length>0;
   if(kind==='ready'&&!listening)return skip('listener_unavailable');
   if(kind!=='ready'&&listening)return skip('listener_active');
   if(kind==='connecting'&&chat.status_notices?.ready)return skip('ready_already_attempted');
   // The binding lock is autocommit, not a transaction: this marker must survive
   // transport errors and crashes. A possibly sent status is never retried.
   const notice={status:'uncertain',attempted_at:new Date().toISOString()};
   chat.status_notices={...chat.status_notices,[kind]:notice};
   await store.put('chat',chatId,chat);
   let timer;try{await Promise.race([app.telegram(app.decrypt(bot.token),'sendMessage',{chat_id:chat.telegram.chat_id,text:TELEGRAM_STATUS_TEXT[kind]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Status delivery deadline reached')),2000);})]);notice.status='sent';}
   catch(error){notice.status=error?.telegramOutcome==='failed'?'failed':'uncertain';}finally{clearTimeout(timer);}
   // Re-read to preserve unrelated metadata changed while the request was in
   // flight. A persistence failure propagates; the consumed marker stays safe.
   const latest=await store.get('chat',chatId);
   requireThat(latest?.owner===chat.owner&&latest.telegram?.bot_id===chat.telegram.bot_id&&latest.telegram?.binding_id===chat.telegram.binding_id,'Chat changed while recording status',409);
   await store.put('chat',chatId,{...latest,status_notices:{...latest.status_notices,[kind]:notice}});
   return {kind,status:notice.status};
  });
 }
}
