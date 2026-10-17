import test from 'node:test';
import assert from 'node:assert/strict';
import {TelegramStatus,TELEGRAM_STATUS_TEXT} from '../src/telegram-status.js';
import {hash} from '../src/security.js';
const owner='mcp:admin',agentId='agent-status',botId='123',telegramUserId='42';
class MemoryStore{
 constructor(){this.data=new Map();this.tail=Promise.resolve();this.writes=[];}
 async get(k,id){return structuredClone(this.data.get(k+':'+id));}
 async put(k,id,v){this.writes.push({k,id,v:structuredClone(v)});this.data.set(k+':'+id,structuredClone(v));}
 async list(k,owner){return [...this.data].filter(([id,v])=>id.startsWith(k+':')&&v.owner===owner).map(([,v])=>structuredClone(v));}
 async withBotLock(key,fn){const previous=this.tail;let release;this.tail=new Promise(resolve=>{release=resolve;});await previous;try{return await fn(this);}finally{release();}}
}
async function fixture(){
 const store=new MemoryStore(),sent=[];const app={store,decrypt:()=> 'synthetic-token',telegram:async(token,method,args)=>{assert.equal(token,'synthetic-token');assert.equal(method,'sendMessage');sent.push(args);return {message_id:1};}};
 await store.put('agent',agentId,{owner,agentId,handle:'agent',displayName:'Agent'});
 await store.put('bot',botId,{owner,id:botId,active:true,token:'synthetic-encrypted'});
 await store.put('group_bot',botId,{owner,agentId,bindingId:'generation-1'});
 await store.put('human','synthetic-human',{owner,type:'human',handle:'human',telegram_user_id:telegramUserId});
 return {store,app,sent,status:new TelegramStatus(app)};
}
async function inbox(f,patch={}){await f.store.put('group_subscription',hash(JSON.stringify([agentId,'chat.created',null])),{owner,agentId,name:'agent.notification',chatId:null,expires:Date.now()+60000,url:'https://synthetic.example/callback',secret:'synthetic-encrypted-secret',...patch});}

test('fixed status texts only and attempted marker is durable before Telegram',async()=>{
 const f=await fixture();f.app.telegram=async(token,method,args)=>{const notice=await f.store.get('dm_status',botId+':'+telegramUserId);assert.equal(notice.status_notices.connecting.status,'uncertain');assert.equal(method,'sendMessage');f.sent.push(args);return {message_id:1};};
 assert.deepEqual(await f.status.notify(botId,telegramUserId,'connecting'),{kind:'connecting',status:'sent'});
 assert.deepEqual(f.sent,[{chat_id:telegramUserId,text:'正在连接 agent，请稍候。'}]);
 await f.store.put('dm_status',botId+':'+telegramUserId,{...(await f.store.get('dm_status',botId+':'+telegramUserId)),custom:'preserved'});
 await f.status.notify(botId,telegramUserId,'queued');
 assert.equal((await f.store.get('dm_status',botId+':'+telegramUserId)).custom,'preserved');
 await assert.rejects(f.status.notify(botId,telegramUserId,'arbitrary text'),/Invalid Telegram status kind/);
 assert.equal(TELEGRAM_STATUS_TEXT.ready,'已连接，可以开始聊天。');assert.equal(TELEGRAM_STATUS_TEXT.queued,'消息已暂存，连接后投递。');
});
test('concurrent duplicates send each status at most once for the binding generation',async()=>{
 const f=await fixture();const results=await Promise.all([f.status.notify(botId,telegramUserId,'connecting'),f.status.notify(botId,telegramUserId,'connecting')]);assert.equal(results.filter(r=>r.status==='sent').length,1);assert.equal(f.sent.length,1);
 assert.equal((await f.status.notify(botId,telegramUserId,'queued')).status,'sent');assert.equal((await f.status.notify(botId,telegramUserId,'queued')).reason,'already_attempted');assert.equal(f.sent.length,2);
});
test('valid main inbox listener permits ready and suppresses connecting and queued',async()=>{
 const f=await fixture();assert.equal((await f.status.notify(botId,telegramUserId,'ready')).reason,'listener_unavailable');await inbox(f);
 assert.equal((await f.status.notify(botId,telegramUserId,'connecting')).reason,'listener_active');assert.equal((await f.status.notify(botId,telegramUserId,'queued')).reason,'listener_active');assert.equal((await f.status.notify(botId,telegramUserId,'ready')).status,'sent');assert.equal(f.sent.length,1);
 await inbox(f,{expires:0});assert.equal((await f.status.notify(botId,telegramUserId,'connecting')).reason,'ready_already_attempted');
});
test('expired or mismatched inbox subscriptions never trigger ready',async()=>{
 for(const patch of [{expires:0},{owner:'foreign'},{agentId:'other'},{chatId:'some-chat'},{name:'message.created'},{secret:''},{url:''}]){const f=await fixture();await inbox(f,patch);assert.equal((await f.status.notify(botId,telegramUserId,'ready')).reason,'listener_unavailable');assert.equal(f.sent.length,0);}
});
test('missing mappings, revoked grants, inactive bots and unregistered humans never send',async()=>{
 const changes=[f=>f.store.data.delete('bot:'+botId),f=>f.store.data.delete('agent:'+agentId),f=>f.store.data.delete('group_bot:'+botId),f=>f.store.data.get('bot:'+botId).active=false,f=>f.store.data.get('human:synthetic-human').telegram_user_id='43',f=>f.store.data.get('group_bot:'+botId).owner='foreign'];
 for(const change of changes){const f=await fixture();change(f);assert.equal((await f.status.notify(botId,telegramUserId,'connecting')).status,'skipped');assert.equal(f.sent.length,0);}
});
test('uncertain and definitive transport failures are consumed without retries or error disclosure',async()=>{
 for(const outcome of ['failed','uncertain']){const f=await fixture();let attempts=0;f.app.telegram=async()=>{attempts++;throw Object.assign(Error('synthetic secret must not escape'),{telegramOutcome:outcome});};
  assert.deepEqual(await f.status.notify(botId,telegramUserId,'connecting'),{kind:'connecting',status:outcome});assert.equal((await f.status.notify(botId,telegramUserId,'connecting')).reason,'already_attempted');assert.equal(attempts,1);assert.equal((await f.store.get('dm_status',botId+':'+telegramUserId)).status_notices.connecting.status,outcome);
 }
});
test('persistence errors propagate and never reopen an uncertain send',async()=>{
 const f=await fixture(),put=f.store.put.bind(f.store);let n=0;
 f.store.put=async(...args)=>{if(args[0]==='dm_status'&&++n===1)throw Error('synthetic persistence failed');return put(...args);};
 await assert.rejects(f.status.notify(botId,telegramUserId,'connecting'),/persistence failed/);assert.equal(f.sent.length,0);
 f.store.put=async(...args)=>{if(args[0]==='dm_status'&&++n===3)throw Error('synthetic final write failed');return put(...args);};
 await assert.rejects(f.status.notify(botId,telegramUserId,'connecting'),/final write failed/);assert.equal(f.sent.length,1);assert.equal((await f.store.get('dm_status',botId+':'+telegramUserId)).status_notices.connecting.status,'uncertain');
 assert.equal((await f.status.notify(botId,telegramUserId,'connecting')).reason,'already_attempted');assert.equal(f.sent.length,1);
});
test('binding serialization rechecks eligibility after waiting and preserves concurrent metadata',async()=>{
 const f=await fixture();await f.store.withBotLock('bot-binding:'+owner,async()=>{const bot=await f.store.get('bot',botId);bot.active=false;await f.store.put('bot',botId,bot);});
 assert.equal((await f.status.notify(botId,telegramUserId,'connecting')).status,'skipped');assert.equal(f.sent.length,0);
 const g=await fixture();g.app.telegram=async()=>{const c=await g.store.get('dm_status',botId+':'+telegramUserId);c.extra='added-in-flight';await g.store.put('dm_status',botId+':'+telegramUserId,c);return {message_id:1};};
 await g.status.notify(botId,telegramUserId,'connecting');assert.equal((await g.store.get('dm_status',botId+':'+telegramUserId)).extra,'added-in-flight');
});
test('group chat records and per-chat listeners are not used',async()=>{
 const f=await fixture();await f.store.put('chat','group-chat',{id:'group-chat',owner,type:'telegram',telegram:{bot_id:botId,chat_id:'-100',binding_id:'generation-1'}});
 await f.store.put('group_subscription',hash(JSON.stringify([agentId,'message.created','group-chat'])),{owner,agentId,name:'message.created',chatId:'group-chat',expires:Date.now()+60000,url:'https://synthetic.example/callback',secret:'synthetic-encrypted-secret'});
 assert.equal((await f.status.notify(botId,telegramUserId,'ready')).reason,'listener_unavailable');
 assert.equal((await f.status.notify(botId,'-100','connecting')).reason,'unauthorized_dm');
 assert.equal(f.sent.length,0);
});
