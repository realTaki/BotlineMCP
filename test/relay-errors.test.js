import test from 'node:test';
import assert from 'node:assert/strict';
import {RelayErrors,relayErrorDetails,RELAY_ERROR_POLICY} from '../src/relay-errors.js';
import {hash} from '../src/security.js';
const owner='asp:admin',agentId='agent-errors',chatId='chat-errors',secret='whsec_'+Buffer.alloc(32,8).toString('base64');
class MemoryStore{
 constructor(){this.data=new Map();this.locks=new Map();}
 async get(k,id){return structuredClone(this.data.get(k+':'+id));}
 async put(k,id,v){this.data.set(k+':'+id,structuredClone(v));}
 async delete(k,id){this.data.delete(k+':'+id);}
 async list(k,owner){return [...this.data].filter(([id,v])=>id.startsWith(k+':')&&v.owner===owner).map(([id,v])=>({...structuredClone(v),id:id.slice(k.length+1)}));}
 async withLock(key,fn){return this.withBotLock(key,fn);}
 async withBotLock(key,fn){const previous=this.locks.get(key)??Promise.resolve();let release;const current=new Promise(resolve=>{release=resolve;});this.locks.set(key,current);await previous;try{return await fn(this);}finally{release();if(this.locks.get(key)===current)this.locks.delete(key);}}
 async lease(k,id,ttl=30000){const key=k+':'+id,record=this.data.get(key);if(!record||record.leaseUntil>Date.now())return;record.leaseUntil=Date.now()+ttl;return structuredClone(record);}
}
async function fixture({listener=true,telegram=true}={}){
 const store=new MemoryStore(),callbacks=[],sent=[];const app={store,ownerActive:async id=>id===owner,decrypt:v=>v==='encrypted-secret'?secret:'synthetic-token',post:async(url,headers,body)=>{callbacks.push({url,headers,event:JSON.parse(body)});return {status:200};},telegram:async(token,method,args)=>{assert.equal(token,'synthetic-token');assert.equal(method,'sendMessage');sent.push(args);return {message_id:1};}};
 await store.put('agent',agentId,{owner,agentId,handle:'assistant',displayName:'Assistant'});
 if(listener)await addListener(store);
 if(telegram){await store.put('chat',chatId,{owner,id:chatId,agent_ids:[agentId],telegram:{bot_id:'123',chat_id:'42',binding_id:'generation'}});await store.put('bot','123',{owner,id:'123',active:true,token:'encrypted-token'});await store.put('group_bot','123',{owner,agentId,bindingId:'generation'});await store.put('human','fixture-human',{owner,handle:'human',telegram_user_id:'42'});}
 return {store,app,callbacks,sent,errors:new RelayErrors(app)};
}
async function addListener(store,name='agent.notification'){await store.put('group_subscription',hash(JSON.stringify([agentId,'chat.created',null])),{owner,agentId,name,chatId:null,expires:Date.now()+60000,url:'https://synthetic.example/main',secret:'encrypted-secret'});}
const report=f=>f.errors.report({owner,agentId,chatId,code:'relay_delivery_failed'});

test('catalog sanitizes unknown inputs and reports fixed actionable details through both channels',async()=>{
 const f=await fixture(),result=await f.errors.report({owner,agentId,chatId,code:'unknown secret-token',message:'raw-secret',stack:'private-stack'});
 assert.equal(result.code,'internal_error');assert.match(result.error_id,/^err_[A-Za-z0-9_-]+$/);assert.deepEqual(result.notification,{agent:'sent',telegram:'sent'});
 const callback=f.callbacks[0];assert.equal(callback.event.name,'agent.notification');assert.equal(callback.event.data.type,'relay.error');assert.equal(callback.event.data.error.error_id,result.error_id);assert.equal(callback.event.data.chat_id,chatId);assert.match(callback.headers['webhook-signature'],/^v1,/);
 assert.equal(f.sent[0].chat_id,'42');assert(f.sent[0].text.includes(result.error_id));assert(f.sent[0].text.includes('agent'));
 assert(!JSON.stringify([result,f.callbacks,f.sent,await f.store.list('relay_error',owner)]).includes('raw-secret'));assert(!JSON.stringify(result).includes('secret-token'));
 assert.equal(relayErrorDetails('queue_full').retryable,true);assert.equal(relayErrorDetails(undefined).code,'internal_error');
});
test('same-minute reports deduplicate opaque IDs and concurrent channel attempts',async()=>{
 const f=await fixture();const results=await Promise.all([report(f),report(f),report(f)]);assert.equal(new Set(results.map(r=>r.error_id)).size,1);assert.equal(f.sent.length,1);assert.equal(f.callbacks.length,1);assert.equal((await f.store.list('relay_error',owner)).length,1);
});
test('legacy chat.created listener is not given error payloads and later agent.notification resumes pending',async()=>{
 const f=await fixture({telegram:false});await addListener(f.store,'chat.created');const result=await report(f);assert.deepEqual(result.notification,{agent:'pending',telegram:'unavailable'});assert.equal(f.callbacks.length,0);
 await addListener(f.store);await f.errors.dispatch(owner);assert.equal(f.callbacks.length,1);assert.equal(f.callbacks[0].event.eventId,result.error_id);
});
test('unavailable channels retain pending error and each channel can succeed independently later',async()=>{
 const f=await fixture({listener:false}),result=await report(f);assert.deepEqual(result.notification,{agent:'pending',telegram:'sent'});await addListener(f.store);await f.errors.dispatch(owner);assert.equal(f.callbacks.length,1);assert.equal(f.sent.length,1);
 const g=await fixture({telegram:false});assert.deepEqual((await report(g)).notification,{agent:'sent',telegram:'unavailable'});const [record]=await g.store.list('relay_error',owner);assert(record.expires>Date.now());
});
test('callback backoff, stable event IDs and eight-attempt cap are enforced without recursive reports',async()=>{
 const f=await fixture({telegram:false});f.app.post=async(url,headers,body)=>{f.callbacks.push(JSON.parse(body));return {status:503};};const result=await report(f);
 assert.equal(result.notification.agent,'pending');assert.equal(f.callbacks.length,1);await f.errors.dispatch(owner);assert.equal(f.callbacks.length,1);
 for(let n=1;n<8;n++){const [record]=await f.store.list('relay_error',owner);record.agent.next=0;await f.store.put('relay_error',record.id,record);await f.errors.dispatch(owner);}
 assert.equal(f.callbacks.length,8);assert.equal(new Set(f.callbacks.map(event=>event.eventId)).size,1);assert.equal((await f.store.list('relay_error',owner))[0].agent.state,'failed');assert.equal((await f.store.list('relay_error',owner)).length,1);await f.errors.dispatch(owner);assert.equal(f.callbacks.length,8);
});
test('definitive callback rejection becomes failed while rate limits stay retryable',async()=>{
 for(const [status,state] of [[400,'failed'],[403,'failed'],[429,'pending']]){const f=await fixture({telegram:false});f.app.post=async()=>({status});assert.equal((await report(f)).notification.agent,state);}
});
test('Telegram attempts are durably consumed before network call and uncertain results never retry',async()=>{
 const f=await fixture();let calls=0;f.app.telegram=async()=>{calls++;const [record]=await f.store.list('relay_error',owner);assert.equal(record.telegram.state,'uncertain');throw Error('sensitive-network-detail');};
 const result=await report(f);assert.equal(result.notification.telegram,'uncertain');assert(!JSON.stringify(result).includes('sensitive-network-detail'));await report(f);await f.errors.dispatch(owner);assert.equal(calls,1);
});
test('foreign, revoked, unbound or stale-generation Telegram mappings never get notices',async()=>{
 const changes=[f=>f.store.data.get('chat:'+chatId).owner='foreign',f=>f.store.data.get('chat:'+chatId).agent_ids=['other-agent'],f=>f.store.data.get('bot:123').active=false,f=>f.store.data.get('group_bot:123').bindingId='different',f=>f.store.data.delete('group_bot:123'),f=>f.store.data.get('human:fixture-human').telegram_user_id='43'];
 for(const change of changes){const f=await fixture();change(f);assert.equal((await report(f)).notification.telegram,'unavailable');assert.equal(f.sent.length,0);}
});
test('record capacity and expiry remain bounded without claiming unavailable delivery',async()=>{
 const f=await fixture({listener:false,telegram:false});const now=Date.now();for(let n=0;n<RELAY_ERROR_POLICY.maxRecords;n++)await f.store.put('relay_error','capacity-'+n,{owner,created:now,expires:now+60000,error_id:'err_'+n,code:'internal_error',agentId:null,chatId:null,agent:{state:'failed'},telegram:{state:'unavailable'},leaseUntil:0});
 assert.deepEqual((await report(f)).notification,{agent:'capacity_limited',telegram:'capacity_limited'});assert.equal((await f.store.list('relay_error',owner)).length,128);
 for(const record of await f.store.list('relay_error',owner)){record.expires=0;await f.store.put('relay_error',record.id,record);}const result=await report(f);assert.equal(result.notification.agent,'pending');assert.equal((await f.store.list('relay_error',owner)).length,1);
});
test('opportunistic dispatch handles no more than four delivered records in a batch',async()=>{
 const f=await fixture({listener:false,telegram:false});for(let n=0;n<7;n++)await f.errors.report({owner,agentId,code:'internal_error',chatId:'synthetic-'+n});await addListener(f.store);await f.errors.dispatch(owner);assert.equal(f.callbacks.length,4);await f.errors.dispatch(owner);assert.equal(f.callbacks.length,7);
});
test('initial persistence failure sends nothing and final Telegram write failure does not reopen attempt',async()=>{
 const f=await fixture(),put=f.store.put.bind(f.store);f.store.put=async(k,...rest)=>{if(k==='relay_error')throw Error('synthetic persist failed');return put(k,...rest);};await assert.rejects(report(f),/persist failed/);assert.equal(f.callbacks.length,0);assert.equal(f.sent.length,0);
 const g=await fixture({listener:false}),put2=g.store.put.bind(g.store);let fail=true;g.store.put=async(k,id,value)=>{if(k==='relay_error'&&value.telegram.state==='sent'&&fail){fail=false;throw Error('synthetic final write failed');}return put2(k,id,value);};await assert.rejects(report(g),/final write failed/);await g.errors.dispatch(owner);assert.equal(g.sent.length,1);assert.equal((await g.store.list('relay_error',owner))[0].telegram.state,'uncertain');
});

test('a stalled callback times out independently and leaves a stable pending retry',async()=>{
 const f=await fixture({telegram:false});f.app.post=async()=>new Promise(()=>{});const started=Date.now();
 const result=await report(f);assert.equal(result.notification.agent,'pending');assert(Date.now()-started<RELAY_ERROR_POLICY.dispatchMs);const [record]=await f.store.list('relay_error',owner);assert.equal(record.agent.attempts,1);assert.equal(record.leaseUntil,0);assert.equal(record.error_id,result.error_id);
});
test('inactive instance authority prevents both notification channels',async()=>{
 const f=await fixture();f.app.ownerActive=async()=>false;
 const result=await report(f);assert.deepEqual(result.notification,{agent:'pending',telegram:'unavailable'});assert.equal(f.callbacks.length,0);assert.equal(f.sent.length,0);
});
