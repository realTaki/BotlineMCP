import {hash,requireThat} from './security.js';
// Routing metadata only: no message text, credentials, or recoverable history.
export const REPLY_POLICY={ttl:7*86400000,maxEntries:512};
export const replyScope=(owner,botId,bindingId,agentId,chatId,humanHandle)=>({owner,botId,bindingId:bindingId??null,agentId,chatId:String(chatId),humanHandle});
export const replyScopeKey=s=>hash(JSON.stringify([s.owner,s.botId,s.bindingId,s.agentId,s.chatId,s.humanHandle]));
export async function findReply(store,scope,{canonicalId,telegramId}){
 const row=await store.get('telegram_replies',replyScopeKey(scope));
 if(!row||row.expires<=Date.now())return;
 return row.entries.find(e=>e.expires>Date.now()&&(canonicalId!==undefined?e.canonicalId===canonicalId:e.telegramId===telegramId));
}
// Caller serializes writes with the existing dms:<owner> lock. Outgoing code
// already holding a pool connection must use withHeldConnectionLock.
export async function rememberReply(store,scope,canonicalId,telegramId,direction){
 requireThat(Number.isSafeInteger(telegramId)&&telegramId>0,'Invalid Telegram reply mapping',502);
 const id=replyScopeKey(scope),old=await store.get('telegram_replies',id),now=Date.now();
 const entries=(old?.entries??[]).filter(e=>e.expires>now);
 const existing=entries.find(e=>e.canonicalId===canonicalId||e.telegramId===telegramId);
 if(existing){requireThat(existing.canonicalId===canonicalId&&existing.telegramId===telegramId&&existing.direction===direction,'Telegram reply mapping conflict',409);return;}
 entries.push({canonicalId,telegramId,direction,expires:now+REPLY_POLICY.ttl});
 await store.put('telegram_replies',id,{...scope,entries:entries.slice(-REPLY_POLICY.maxEntries),expires:now+REPLY_POLICY.ttl});
}
