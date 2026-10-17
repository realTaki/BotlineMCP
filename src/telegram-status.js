import {hash,requireThat} from './security.js';
import {getAgent} from './agents.js';
import {listHumans} from './telegram-owner.js';
import {telegramHumanAllowed} from './telegram-policy.js';

export const TELEGRAM_STATUS_TEXT=Object.freeze({connecting:'正在连接 agent，请稍候。',ready:'已连接，可以开始聊天。',queued:'消息已暂存，连接后投递。'});
const noticeId=(botId,telegramUserId)=>`${botId}:${telegramUserId}`;
const inboxId=agentId=>hash(JSON.stringify([agentId,'chat.created',null]));
export class TelegramStatus {
 constructor(app){this.app=app;}
 async notify(botId,telegramUserId,kind){
  requireThat(Object.hasOwn(TELEGRAM_STATUS_TEXT,kind),'Invalid Telegram status kind');
  requireThat(typeof botId==='string'&&typeof telegramUserId==='string','Invalid Telegram status target');
  const initial=typeof botId==='string'?await this.app.store.get('bot',botId):null;
  const skip=reason=>({kind,status:'skipped',reason});
  if(!initial?.owner||!initial.token)return skip('unmapped_dm');
  return this.app.store.withBotLock('bot-binding:'+initial.owner,async store=>{
   const app=Object.assign(Object.create(Object.getPrototypeOf(this.app)),this.app,{store});
   const bot=await store.get('bot',botId),route=await store.get('group_bot',botId);
   if(!bot?.active||bot.owner!==initial.owner||!bot.token||route?.owner!==bot.owner||typeof route.bindingId!=='string'||!await getAgent(app,bot.owner,route.agentId)||!telegramHumanAllowed(await listHumans(app,bot.owner),telegramUserId))return skip('unauthorized_dm');
   const id=noticeId(botId,telegramUserId);
   const record=(await store.get('dm_status',id))??{owner:bot.owner,botId,telegram_user_id:telegramUserId};
   if(record.status_notices?.[kind])return skip('already_attempted');
   const sub=await store.get('group_subscription',inboxId(route.agentId));
   const listening=sub?.owner===bot.owner&&sub.agentId===route.agentId&&sub.name==='agent.notification'&&sub.chatId==null&&Number.isFinite(sub.expires)&&sub.expires>Date.now()&&typeof sub.url==='string'&&sub.url.length>0&&typeof sub.secret==='string'&&sub.secret.length>0;
   if(kind==='ready'&&!listening)return skip('listener_unavailable');
   if(kind!=='ready'&&listening)return skip('listener_active');
   if(kind==='connecting'&&record.status_notices?.ready)return skip('ready_already_attempted');
   // The binding lock is autocommit, not a transaction: this marker must survive
   // transport errors and crashes. A possibly sent status is never retried.
   const notice={status:'uncertain',attempted_at:new Date().toISOString()};
   record.status_notices={...record.status_notices,[kind]:notice};
   await store.put('dm_status',id,record);
   let timer;try{await Promise.race([app.telegram(app.decrypt(bot.token),'sendMessage',{chat_id:telegramUserId,text:TELEGRAM_STATUS_TEXT[kind]}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Status delivery deadline reached')),2000);})]);notice.status='sent';}
   catch(error){notice.status=error?.telegramOutcome==='failed'?'failed':'uncertain';}finally{clearTimeout(timer);}
   // Re-read to preserve unrelated metadata changed while the request was in
   // flight. A persistence failure propagates; the consumed marker stays safe.
   const latest=await store.get('dm_status',id);
   requireThat(latest?.owner===bot.owner&&latest.botId===botId&&latest.telegram_user_id===telegramUserId,'DM status changed while recording',409);
   await store.put('dm_status',id,{...latest,status_notices:{...latest.status_notices,[kind]:notice}});
   return {kind,status:notice.status};
  });
 }
}
