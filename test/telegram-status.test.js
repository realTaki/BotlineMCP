import test from 'node:test';
import assert from 'node:assert/strict';
import {TelegramStatus,TELEGRAM_STATUS_TEXT} from '../src/telegram-status.js';
import {hash} from '../src/security.js';
const owner='asp:admin',agentId='agent-status',chatId='chat-status';
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
 await store.put('bot','123',{owner,id:'123',active:true,token:'synthetic-encrypted'});
 await store.put('group_bot','123',{owner,agentId,bindingId:'generation-1'});
 await store.put('human','synthetic-human',{owner,type:'human',handle:'human',telegram_user_id:'42'});
 await store.put('chat',chatId,{id:chatId,owner,title:'Group',custom:'preserved',type:'telegram',agent_ids:[agentId],telegram:{bot_id:'123',chat_id:'42',binding_id:'generation-1'}});
 return {store,app,sent,status:new TelegramStatus(app)};
}
async function listener(f,patch={}){await f.store.put('group_subscription',hash(JSON.stringify([agentId,'message.created',chatId])),{owner,agentId,name:'message.created',chatId,expires:Date.now()+60000,url:'https://synthetic.example/callback',secret:'synthetic-encrypted-secret',...patch});}

test('fixed status texts only and attempted marker is durable before Telegram',async()=>{
 const f=await fixture();f.app.telegram=async(token,method,args)=>{const chat=await f.store.get('chat',chatId);assert.equal(chat.status_notices.connecting.status,'uncertain');assert.equal(method,'sendMessage');f.sent.push(args);return {message_id:1};};
 assert.deepEqual(await f.status.notify(chatId,'connecting'),{kind:'connecting',status:'sent'});
 assert.deepEqual(f.sent,[{chat_id:'42',text:'正在连接 agent，请稍候。'}]);assert.equal((await f.store.get('chat',chatId)).custom,'preserved');
 await assert.rejects(f.status.notify(chatId,'arbitrary text'),/Invalid Telegram status kind/);
 assert.equal(TELEGRAM_STATUS_TEXT.ready,'已连接，可以开始聊天。');assert.equal(TELEGRAM_STATUS_TEXT.queued,'消息已暂存，连接后投递。');
});
test('concurrent duplicates send each status at most once for the binding generation',async()=>{
 const f=await fixture();const results=await Promise.all([f.status.notify(chatId,'connecting'),f.status.notify(chatId,'connecting')]);assert.equal(results.filter(r=>r.status==='sent').length,1);assert.equal(f.sent.length,1);
 assert.equal((await f.status.notify(chatId,'queued')).status,'sent');assert.equal((await f.status.notify(chatId,'queued')).reason,'already_attempted');assert.equal(f.sent.length,2);
});
test('valid active listener permits ready and suppresses connecting and queued',async()=>{
 const f=await fixture();assert.equal((await f.status.notify(chatId,'ready')).reason,'listener_unavailable');await listener(f);
 assert.equal((await f.status.notify(chatId,'connecting')).reason,'listener_active');assert.equal((await f.status.notify(chatId,'queued')).reason,'listener_active');assert.equal((await f.status.notify(chatId,'ready')).status,'sent');assert.equal(f.sent.length,1);
 await listener(f,{expires:0});assert.equal((await f.status.notify(chatId,'connecting')).reason,'ready_already_attempted');
});
test('expired or mismatched subscriptions never trigger ready',async()=>{
 for(const patch of [{expires:0},{owner:'foreign'},{agentId:'other'},{chatId:'other'},{name:'chat.created'},{secret:''},{url:''}]){const f=await fixture();await listener(f,patch);assert.equal((await f.status.notify(chatId,'ready')).reason,'listener_unavailable');assert.equal(f.sent.length,0);}
});
test('missing mappings, revoked grants, inactive bots and stale generations never send',async()=>{
 const changes=[f=>f.store.data.delete('chat:'+chatId),f=>f.store.data.delete('agent:'+agentId),f=>f.store.data.delete('group_bot:123'),f=>f.store.data.get('bot:123').active=false,f=>f.store.data.get('human:synthetic-human').telegram_user_id='43',f=>f.store.data.get('group_bot:123').bindingId='new-generation',f=>f.store.data.get('group_bot:123').owner='foreign',f=>f.store.data.get('chat:'+chatId).agent_ids=['other']];
 for(const change of changes){const f=await fixture();change(f);assert.equal((await f.status.notify(chatId,'connecting')).status,'skipped');assert.equal(f.sent.length,0);}
});
test('uncertain and definitive transport failures are consumed without retries or error disclosure',async()=>{
 for(const outcome of ['failed','uncertain']){const f=await fixture();let attempts=0;f.app.telegram=async()=>{attempts++;throw Object.assign(Error('synthetic secret must not escape'),{telegramOutcome:outcome});};
  assert.deepEqual(await f.status.notify(chatId,'connecting'),{kind:'connecting',status:outcome});assert.equal((await f.status.notify(chatId,'connecting')).reason,'already_attempted');assert.equal(attempts,1);assert.equal((await f.store.get('chat',chatId)).status_notices.connecting.status,outcome);
 }
});
test('persistence errors propagate and never reopen an uncertain send',async()=>{
 const f=await fixture(),put=f.store.put.bind(f.store);let n=0;
 f.store.put=async(...args)=>{if(args[0]==='chat'&&++n===1)throw Error('synthetic persistence failed');return put(...args);};
 await assert.rejects(f.status.notify(chatId,'connecting'),/persistence failed/);assert.equal(f.sent.length,0);
 f.store.put=async(...args)=>{if(args[0]==='chat'&&++n===3)throw Error('synthetic final write failed');return put(...args);};
 await assert.rejects(f.status.notify(chatId,'connecting'),/final write failed/);assert.equal(f.sent.length,1);assert.equal((await f.store.get('chat',chatId)).status_notices.connecting.status,'uncertain');
 assert.equal((await f.status.notify(chatId,'connecting')).reason,'already_attempted');assert.equal(f.sent.length,1);
});
test('binding serialization rechecks eligibility after waiting and preserves concurrent metadata',async()=>{
 const f=await fixture();await f.store.withBotLock('bot-binding:'+owner,async()=>{const bot=await f.store.get('bot','123');bot.active=false;await f.store.put('bot','123',bot);});
 assert.equal((await f.status.notify(chatId,'connecting')).status,'skipped');assert.equal(f.sent.length,0);
 const g=await fixture();g.app.telegram=async()=>{const c=await g.store.get('chat',chatId);c.extra='added-in-flight';await g.store.put('chat',chatId,c);return {message_id:1};};
 await g.status.notify(chatId,'connecting');assert.equal((await g.store.get('chat',chatId)).extra,'added-in-flight');
});
