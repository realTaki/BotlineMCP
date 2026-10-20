import {hash,requireThat} from './security.js';
import {grokbotSession,grokbotMessage} from './grokbot-api.js';
import {messageText} from './message-text.js';

export function grokbotDeliveryId(eventId,agentId){return 'gbd_'+hash(`grokbot:${eventId}:${agentId}`).slice(0,48);}
export function grokbotMessageId(deliveryId){return deliveryId;}

export function grokbotText(event){
 return messageText(event);
}

export function normalizeCursorApiKey(value){
 requireThat(typeof value==='string','cursor_api_key must be a string');
 const key=value.trim();
 requireThat(key.length>=16&&key.length<=512,'cursor_api_key must be 16–512 characters');
 requireThat(!/[\u0000-\u001f\u007f]/.test(key),'cursor_api_key is invalid');
 return key;
}

const cursorKeyUnreadable=()=>Object.assign(new Error('Stored Cursor API key is unreadable; call cursor_key_set or agent_register with cursor_api_key'),{status:409,relayCode:'cursor_key_unreadable'});
const cursorKeyRequired=()=>Object.assign(new Error('This instance has no stored Cursor API key. Omit cursor_api_key until the server returns this error, then ask the owner and pass it to cursor_key_set or agent_register.'),{status:409,relayCode:'cursor_key_required'});

export async function storeCursorKey(store,app,owner,key){
 await store.put('cursor_key',owner,{owner,secret:app.encrypt(key),updated:new Date().toISOString()});
}

export async function hasCursorKey(app,owner){
 const record=await app.store.get('cursor_key',owner);
 return !!(record?.secret&&record.owner===owner);
}

export async function readCursorKey(app,owner){
 const record=await app.store.get('cursor_key',owner);
 if(!record?.secret||record.owner!==owner)throw cursorKeyRequired();
 try{return app.decrypt(record.secret);}catch{throw cursorKeyUnreadable();}
}

export async function resolveGrokbotSession(app,owner,name){
 return (await grokbotSession(await readCursorKey(app,owner),name,{fetchImpl:app.grokbotFetch})).id;
}

async function clearCachedSessions(store,owner){
 for(const listed of await store.list('agent',owner)){
  const current=await store.get('agent',listed.agentId);
  if(!current?.grokbotSessionId)continue;
  const {grokbotSessionId,...rest}=current;
  await store.put('agent',current.agentId,rest);
 }
}

export async function setCursorKey(app,principal,args={}){
 requireThat(principal&&typeof principal.owner==='string','Authentication required',401);
 const key=normalizeCursorApiKey(args.cursor_api_key);
 await app.store.withLock('human:'+principal.owner,async store=>{
  await storeCursorKey(store,app,principal.owner,key);
  await clearCachedSessions(store,principal.owner);
 });
 return {ok:true};
}

export async function clearCursorKey(app,principal){
 requireThat(principal&&typeof principal.owner==='string','Authentication required',401);
 await app.store.withLock('human:'+principal.owner,async store=>{
  await store.delete('cursor_key',principal.owner);
  await clearCachedSessions(store,principal.owner);
 });
 return {ok:true};
}

async function cacheGrokbotSession(app,agent,sessionId){
 await app.store.withLock('human:'+agent.owner,async store=>{
  const current=await store.get('agent',agent.agentId);
  if(!current||current.owner!==agent.owner||current.grokbotSessionId===sessionId)return;
  await store.put('agent',current.agentId,{...current,grokbotSessionId:sessionId});
 });
}

export async function grokbotDeliver(app,agent,text,deliveryId){
 const apiKey=await readCursorKey(app,agent.owner);
 let sessionId=agent.grokbotSessionId;
 if(!sessionId){
  requireThat(typeof agent.grokbotAgentName==='string'&&agent.grokbotAgentName.length>0,'Grok Bot name is not registered',404);
  sessionId=await resolveGrokbotSession(app,agent.owner,agent.grokbotAgentName);
  await cacheGrokbotSession(app,agent,sessionId);
 }
 return grokbotMessage(apiKey,sessionId,text,grokbotMessageId(deliveryId),{fetchImpl:app.grokbotFetch});
}

