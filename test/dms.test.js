import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {Store} from '../src/store.js';
import {Readable} from 'node:stream';
import {App,handler} from '../src/app.js';
import {DotInbox,DOT_INBOX_POLICY} from '../src/dot-inbox.js';
import {Dms,DM_POLICY} from '../src/dms.js';
import {registerAgent} from '../src/agents.js';
import {configureHuman} from '../src/telegram-owner.js';
import {INBOUND_REACTIONS,waitInboundReactions} from '../src/telegram-reactions.js';
const owner='mcp:admin',secret='whsec_'+Buffer.alloc(32,8).toString('base64');
class MemoryStore {
 constructor(){this.data=new Map();this.queue=Promise.resolve();}
 async get(k,id){return structuredClone(this.data.get(k+':'+id));}
 async put(k,id,v){this.data.set(k+':'+id,structuredClone(v));}
 async insert(k,id,v){if(this.data.has(k+':'+id))return false;await this.put(k,id,v);return true;}
 async delete(k,id){this.data.delete(k+':'+id);}
 async list(k,o){return [...this.data].filter(([id,v])=>id.startsWith(k+':')&&(!o||v.owner===o)).map(([id,v])=>({...structuredClone(v),id:id.slice(k.length+1)}));}
 async lease(k,id){const v=await this.get(k,id);if(!v||v.leaseUntil>Date.now())return;v.leaseUntil=Date.now()+30000;await this.put(k,id,v);return v;}
 async withLock(key,fn){const last=this.queue;let release;this.queue=new Promise(r=>release=r);await last;const before=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=before;throw e;}finally{release();}}
 async telegramReactionSnapshot(botId,owner,agentId){return {bot:await this.get('bot',botId),route:await this.get('group_bot',botId),agent:await this.get('agent',agentId),humans:await this.list('human',owner)};}
 async withBotLock(key,fn){const last=this.queue;let release;this.queue=new Promise(r=>release=r);await last;try{return await fn(this);}finally{release();}}
 async reserveDeniedReply(){return true;}
 async pruneGroupTransport(now=Date.now()){for(const k of ['group_delivery','group_receipt','dot_inbox'])for(const r of await this.list(k))if(r.expires<=now)await this.delete(k,r.id);}
}
async function fixture(store=new MemoryStore()){
 const events=[],telegram=[];const app=new App({store,instanceKey:'x'.repeat(64),key:Buffer.alloc(32,7).toString('base64'),origin:'https://mcp.example',post:async(url,h,body)=>{const e=JSON.parse(body);if(e.type!=='verification')events.push({url,event:e});return {status:200,body:JSON.stringify({challenge:e.challenge})};},telegram:async(t,method,args)=>{telegram.push({method,args});return {message_id:9};}});
 const principals=[];for(const handle of ['alpha','bravo','charlie']){const a=await registerAgent(app,{owner,authType:'api_key'},{handle});principals.push({owner,agentId:a.agent_id,handle,authType:'api_key'});}
 return {store,app,g:new Dms(app),events,telegram,a:principals[0],b:principals[1],c:principals[2]};
}
const inbox=(url='https://callback.example/main')=>({name:'agent.notification',arguments:{},delivery:{mode:'webhook',url,secret}});
test('handle-direct DMs wait for the recipient inbox; no history or sender echo',async()=>{
 const f=await fixture();assert.equal(f.events.length,0);
 await f.g.subscription(f.a,inbox());await f.g.subscription(f.b,inbox('https://callback.example/b'));
 assert.equal(f.events.length,0);
 const sent=await f.g.send(f.a,{to:'bravo',text:'hello',request_id:'message-001'});assert.equal(sent.to,'bravo');assert.equal(sent.status,'accepted');
 assert.equal(f.events.length,1);assert.equal(f.events[0].url,'https://callback.example/b');
 const data=f.events[0].event.data;assert.equal(f.events[0].event.name,'agent.notification');assert.equal(data.type,'message.created');assert.equal(data.message.message_id,sent.message_id);assert.equal(data.message.sender.id,f.a.agentId);assert.equal(data.message.sender.handle,'alpha');assert.equal(data.message.to.handle,'bravo');assert.equal(data.message.text,'hello');assert.equal(data.group_id,undefined);assert.equal(data.message.chat_id,undefined);
 assert.equal((await f.store.list('group_delivery')).length,0);assert(!JSON.stringify(await f.store.list('group_receipt')).includes('hello'));
 assert.equal((await f.g.send(f.a,{to:'bravo',text:'hello',request_id:'message-001'})).message_id,sent.message_id);assert.equal(f.events.length,1);
 await assert.rejects(f.g.send(f.a,{to:'bravo',text:'changed',request_id:'message-001'}),/reused/);
});
test('unknown, self, unregistered and group filters fail closed',async()=>{
 const f=await fixture();
 await assert.rejects(f.g.send(f.a,{to:'missing',text:'secret',request_id:'message-001'}),/handle|Unknown/);
 await assert.rejects(f.g.send(f.a,{to:'alpha',text:'secret',request_id:'message-002'}),/yourself/);
 await assert.rejects(f.g.send({owner},{to:'bravo',text:'x',request_id:'message-003'}),/Register/);
 await assert.rejects(f.g.subscription(f.b,{...inbox(),arguments:{group_id:'chat_x'}}),/filter/);
 await assert.rejects(f.g.subscription(f.b,{name:'chat.created',arguments:{},delivery:{mode:'webhook',url:'https://callback.example/legacy',secret}}),/Unknown event/);
 await assert.rejects(f.g.subscription(f.b,{name:'message.created',arguments:{chat_id:'x'},delivery:{mode:'webhook',url:'https://callback.example/legacy',secret}}),/Unknown event/);
 const tools=(await f.app.rpc(owner,'tools/list',{},f.a)).tools.map(t=>t.name);
 assert(!tools.includes('chats_create'));assert(!tools.includes('chats_list'));assert(tools.includes('messages_send'));
 const events=(await f.app.rpc(null,'events/list')).events.map(e=>e.name);
 assert.deepEqual(events.filter(n=>n!=='telegram.message'),['agent.notification']);
});
test('each recipient inbox is isolated; renewal replaces callback',async()=>{
 const f=await fixture();
 await f.g.subscription(f.b,inbox('https://callback.example/bravo'));await f.g.subscription(f.c,inbox('https://callback.example/charlie'));
 await f.g.send(f.a,{to:'bravo',text:'first',request_id:'message-001'});await f.g.send(f.a,{to:'charlie',text:'second',request_id:'message-002'});
 assert.deepEqual(f.events.map(e=>[e.url,e.event.data.message.text]),[['https://callback.example/bravo','first'],['https://callback.example/charlie','second']]);
 await f.g.subscription(f.b,inbox('https://callback.example/renewed'));await f.g.send(f.a,{to:'bravo',text:'third',request_id:'message-003'});assert.equal(f.events.at(-1).url,'https://callback.example/renewed');
});
test('concurrent identical sends generate one message',async()=>{
 const f=await fixture();await f.g.subscription(f.b,inbox());
 const results=await Promise.all(Array.from({length:8},()=>f.g.send(f.a,{to:'bravo',text:'same',request_id:'message-001'})));
 assert.equal(new Set(results.map(r=>r.message_id)).size,1);assert.equal(f.events.length,1);
});
test('Telegram private DMs from registered humans enter the bound inbox; groups are ignored',async()=>{
 const f=await fixture();await f.store.put('bot','123',{id:'123',owner,active:true,token:f.app.encrypt('synthetic'),hookSecret:'hook'});await f.store.put('group_bot','123',{owner,agentId:f.a.agentId});
 await configureHuman(f.app,owner,{human_handle:'person',telegram_user_id:'42'});
 await f.g.subscription(f.a,inbox());
 const privateMsg={message_id:1,from:{id:42,is_bot:false,first_name:'Owner'},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'hello dm'};
 await f.app.receive('123','hook',{update_id:1,message:privateMsg});
 assert.equal(f.events.length,1);assert.equal(f.events[0].event.data.type,'message.created');assert.equal(f.events[0].event.data.message.text,'hello dm');assert.equal(f.events[0].event.data.message.sender.id,'42');
 await f.app.receive('123','hook',{update_id:2,message:{...privateMsg,chat:{id:-1,type:'group',title:'Group'},text:'hello group'}});
 assert.equal(f.events.length,1);assert.equal((await f.store.list('chat')).length,0);
 await f.app.receive('123','hook',{update_id:1,message:privateMsg});assert.equal(f.events.length,1);
 const reply=await f.g.send(f.a,{to:'person',text:'reply',request_id:'reply-001'});assert.equal(reply.telegram.status,'sent');
 const sends=f.telegram.filter(c=>c.method==='sendMessage');assert.equal(sends.length,1);assert.equal(sends[0].args.chat_id,'42');
 await f.g.send(f.a,{to:'person',text:'reply',request_id:'reply-001'});assert.equal(f.telegram.filter(c=>c.method==='sendMessage').length,1);
 await assert.rejects(f.g.send(f.a,{to:'unregistered',text:'blocked',request_id:'reply-002'}),/Unknown recipient/);
});
test('expired listener holds payload; retry backs off; accepted and expired payloads disappear',async()=>{
 const f=await fixture();await f.g.subscription(f.b,inbox());
 f.app.post=async()=>({status:503});await f.g.send(f.a,{to:'bravo',text:'transient',request_id:'message-001'});
 let d=(await f.store.list('group_delivery')).find(d=>d.event.name==='message.created');assert.equal(d.attempts,2);assert(d.next>Date.now());
 await f.g.dispatch(owner);assert.equal((await f.store.get('group_delivery',d.id)).attempts,2);
 d.expires=Date.now()-1;await f.store.put('group_delivery',d.id,d);await f.g.dispatch(owner);assert.equal(await f.store.get('group_delivery',d.id),undefined);
 assert.equal(DM_POLICY.payloadTtl,86400000);
});
test('actual SQL DM transaction rollback, idempotency and atomic bot route',async()=>{
 const db=new PGlite();let tail=Promise.resolve();const pool={query:(...a)=>db.query(...a),connect:async()=>{const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return {query:(...a)=>db.query(...a),release};}};
 const store=Object.create(Store.prototype);store.pool=pool;
 try{await store.initialize();const f=await fixture(store);const sent=await f.g.send(f.a,{to:'bravo',text:'held',request_id:'message-001'});assert.equal((await f.g.send(f.a,{to:'bravo',text:'held',request_id:'message-001'})).message_id,sent.message_id);await assert.rejects(store.withLock('rollback',async tx=>{await tx.put('probe','x',{});throw Error('rollback');}));assert.equal(await store.get('probe','x'),undefined);
 await store.put('bot','123',{owner});await f.store.put('group_bot','123',{owner,agentId:f.a.agentId});assert.equal((await f.store.get('group_bot','123')).agentId,f.a.agentId);assert.equal((await store.get('bot','123')).owner,owner);
 }finally{await db.close();}
});
test('held deliveries without an inbox cannot starve a ready later recipient',async()=>{
 const f=await fixture();for(let i=0;i<20;i++)await f.g.send(f.a,{to:'bravo',text:'pending '+i,request_id:'hold-'+String(i).padStart(3,'0')});
 await f.g.subscription(f.c,inbox());await f.g.send(f.a,{to:'charlie',text:'not starved',request_id:'message-001'});assert.equal(f.events.length,1);assert.equal(f.events[0].event.data.message.text,'not starved');
});
test('old Telegram replay cannot outlive receipt expiry; rebind keeps route outside bot row',async()=>{
 const f=await fixture();await f.store.put('bot','123',{id:'123',owner,active:true,hookSecret:'hook'});await f.store.put('group_bot','123',{owner,agentId:f.a.agentId});
 await configureHuman(f.app,owner,{human_handle:'person',telegram_user_id:'42'});
 const m={message_id:1,from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:Math.floor((Date.now()-8*86400000)/1000),text:'old'};
 await f.app.receive('123','hook',{update_id:1,message:m});assert.equal((await f.store.list('group_delivery')).length,0);
 await f.store.put('bot','123',{id:'123',owner,active:true,hookSecret:'hook'});assert.equal((await f.store.get('group_bot','123')).agentId,f.a.agentId);
});
test('Telegram DM cutover never re-emits a legacy completed update',async()=>{
 const f=await fixture();await f.store.put('bot','123',{id:'123',owner,active:true,hookSecret:'hook'});
 await configureHuman(f.app,owner,{human_handle:'person',telegram_user_id:'42'});
 await f.app.subscribe(owner,{name:'telegram.message',arguments:{bot_id:'123'},delivery:{mode:'webhook',url:'https://callback.example/legacy',secret}});
 const message={message_id:1,from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'already delivered'};
 await f.app.receive('123','hook',{update_id:1,message});assert.equal(f.events.length,1);assert.equal(f.events[0].event.name,'telegram.message');
 await f.store.put('group_bot','123',{owner,agentId:f.a.agentId});await f.g.subscription(f.a,inbox());
 await f.app.receive('123','hook',{update_id:1,message});assert.equal(f.events.length,1);
});
test('delivery_retry reports pending DM notifications',async()=>{
 const f=await fixture();await f.g.send(f.a,{to:'bravo',text:'waiting for listener',request_id:'message-001'});
 const result=await f.app.invoke(owner,'__delivery_retry_internal');assert.equal(result.pending,1);assert.equal(result.dm_pending,1);assert.equal(result.telegram_pending,0);
});
test('callback failure reports sanitized actionable error on the inbox',async()=>{
 const f=await fixture();await f.g.subscription(f.b,inbox('https://callback.example/b'));
 const original=f.app.post;f.app.post=async(url,h,b)=>{const event=JSON.parse(b);if(event.name==='agent.notification'&&event.data.type==='message.created')return {status:503,body:''};return original(url,h,b);};
 const result=await f.g.send(f.a,{to:'bravo',text:'private message never included in error',request_id:'failing-callback-01'});assert.equal(result.status,'pending');
 const errors=f.events.filter(e=>e.event.name==='agent.notification'&&e.event.data.type==='relay.error');assert.equal(errors.length,1);assert.equal(errors[0].event.data.error.code,'relay_delivery_failed');assert.equal(typeof errors[0].event.data.error.action,'string');assert(!JSON.stringify(errors).includes('private message never included in error'));
 assert.equal((await f.store.list('relay_error',owner)).length,1);
 await assert.rejects(f.app.rpc(owner,'tools/call',{name:'messages_send',arguments:{to:'bravo',text:'',request_id:'bad-params-001'}},f.a),e=>e.details.code==='invalid_parameters'&&e.details.retryable===false&&typeof e.details.action==='string');
});


async function dotFixture(store){const f=await fixture(store),dot=await registerAgent(f.app,{owner,authType:'api_key'},{handle:'dot'});return {...f,dot:{owner,agentId:dot.agent_id,authType:'api_key'},inbox:new DotInbox(f.app)};}
test('dot caches beyond callback 2xx; burst wake coalesces; reads repeat and ACK is scoped and idempotent',async()=>{
 const f=await dotFixture();await f.g.subscription(f.dot,inbox());
 const results=await Promise.all(Array.from({length:5},(_,i)=>f.g.send(f.a,{to:'dot',text:'body '+i,request_id:'dot-send-'+i})));
 assert(f.events.length<=2);assert(f.events.every(e=>e.event.data.type==='inbox.ready'));assert(!JSON.stringify(f.events).includes('body'));
 const first=await f.app.invoke(owner,'messages_inbox',{limit:2},f.dot);assert.equal(first.messages.length,2);assert(first.next_cursor);
 assert.deepEqual(await f.inbox.list(f.dot,{limit:2}),first);
 const next=await f.inbox.list(f.dot,{cursor:first.next_cursor,limit:100});assert.equal(next.messages.length,3);assert.equal(next.next_cursor,null);
 assert.equal(new Set([...first.messages,...next.messages].map(m=>m.message_id)).size,5);
 assert.deepEqual(Object.keys(first).sort(),['messages','next_cursor']);for(const m of first.messages){assert.deepEqual(Object.keys(m).sort(),['message_id','sender','text']);assert.deepEqual(Object.keys(m.sender).sort(),['handle','id','kind']);assert.doesNotThrow(()=>f.g.validRequest('reply_'+m.message_id));}assert.doesNotThrow(()=>f.g.validRequest('reply_tgmsg_'+'a'.repeat(64)));assert(first.messages.every(m=>!('reply_request_id' in m)&&!('received_at' in m)&&!('expires_at' in m)));
 await assert.rejects(f.inbox.list(f.a),/dot recipient/);await assert.rejects(f.inbox.ack(f.a,{message_ids:[results[0].message_id]}),/dot recipient/);
 await assert.rejects(f.inbox.list({...f.dot,owner:'other'}),/Authentication/);
 const ack={message_ids:first.messages.map(m=>m.message_id)};assert.deepEqual(await f.inbox.ack(f.dot,ack),await f.inbox.ack(f.dot,ack));assert.equal((await f.inbox.list(f.dot)).messages.length,3);
 assert.equal((await f.g.send(f.a,{to:'dot',text:'body 0',request_id:'dot-send-0'})).message_id,results[0].message_id);assert.equal((await f.inbox.list(f.dot)).messages.length,3);
 await f.inbox.ack(f.dot,{message_ids:next.messages.map(m=>m.message_id)});assert.deepEqual((await f.inbox.list(f.dot)).messages,[]);
 await f.g.subscription(f.b,inbox());await f.g.send(f.a,{to:'bravo',text:'bot unchanged',request_id:'bot-normal-1'});assert.equal(f.events.at(-1).event.data.message.text,'bot unchanged');assert.equal((await f.store.list('group_delivery')).length,0);
});
test('dot wake failure, exhaustion, renewal and expired lease never consume inbox',async()=>{
 const f=await dotFixture();await f.g.subscription(f.dot,inbox());f.app.post=async()=>({status:503});
 await f.g.send(f.a,{to:'dot',text:'recoverable',request_id:'dot-fail-1'});
 for(let i=1;i<8;i++){const wake=await f.store.get('dot_wake',f.dot.agentId);await f.store.put('dot_wake',f.dot.agentId,{...wake,next:0});await f.g.dispatch(owner);}
 let wake=await f.store.get('dot_wake',f.dot.agentId);assert.equal(wake.attempts,8);assert(wake.exhausted);assert.equal((await f.inbox.list(f.dot)).messages.length,1);
 let calls=0;f.app.post=async(url,h,body)=>{calls++;const e=JSON.parse(body);return {status:200,body:JSON.stringify({challenge:e.challenge})};};
 await f.g.subscription(f.dot,inbox());assert.equal(calls,2);assert.equal((await f.inbox.list(f.dot)).messages.length,1);
 wake=await f.store.get('dot_wake',f.dot.agentId);await f.store.put('dot_wake',f.dot.agentId,{...wake,next:0,leaseUntil:Date.now()-1});await f.g.dispatch(owner);assert.equal(calls,3);
 const d=(await f.store.list('dot_inbox'))[0];await f.store.put('dot_inbox',d.id,{...d,expires:Date.now()-1});assert.equal((await f.inbox.list(f.dot)).messages.length,0);assert.equal(await f.store.get('dot_inbox',d.id),undefined);
});
test('dot arrivals during callback and read/ACK receive another wake without deleting newer messages',async()=>{
 const f=await dotFixture();await f.g.subscription(f.dot,inbox());const original=f.app.post;let release,entered;const started=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);let calls=0;
 f.app.post=async(...args)=>{calls++;if(calls===1){entered();await barrier;}return original(...args);};
 const firstSend=f.g.send(f.a,{to:'dot',text:'first',request_id:'dot-race-1'});await started;
 const read=await f.inbox.list(f.dot);await f.g.send(f.a,{to:'dot',text:'second',request_id:'dot-race-2'});
 await f.inbox.ack(f.dot,{message_ids:read.messages.map(m=>m.message_id)});release();await firstSend;
 assert.equal(calls,2);assert.deepEqual((await f.inbox.list(f.dot)).messages.map(m=>m.text),['second']);
});
test('dot Telegram duplicate receipt, access revocation, human replacement and binding generations',async()=>{
 const f=await dotFixture();await f.store.put('bot','123',{id:'123',owner,active:true,hookSecret:'hook'});await f.store.put('group_bot','123',{owner,agentId:f.dot.agentId,bindingId:'generation-one'});
 await configureHuman(f.app,owner,{human_handle:'person',telegram_user_id:'42'});
 const m={message_id:1,from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'private payload'};
 await f.app.receive('123','hook',{update_id:101,message:m});await f.app.receive('123','hook',{update_id:101,message:m});
 let read=await f.inbox.list(f.dot);assert.equal(read.messages.length,1);assert.equal(read.messages[0].telegram,undefined);
 const [human]=await f.store.list('human',owner);await f.store.delete('human',human.id);assert.equal((await f.inbox.list(f.dot)).messages.length,0);await assert.rejects(f.inbox.ack(f.dot,{message_ids:[read.messages[0].message_id]}),/authorized/);
 await f.store.put('human',human.id,human);await f.store.put('group_bot','123',{owner,agentId:f.dot.agentId,bindingId:'generation-two'});assert.equal((await f.inbox.list(f.dot)).messages.length,0);
 await f.store.put('group_bot','123',{owner,agentId:f.dot.agentId,bindingId:'generation-one'});assert.equal((await f.inbox.list(f.dot)).messages.length,1);
 const h=(await f.store.list('human',owner))[0];await f.store.put('human',h.id,{...h,telegram_user_id:'43'});assert.equal((await f.inbox.list(f.dot)).messages.length,0);
});
test('dot capacity and failed persistence roll back send receipt; other agents remain usable',async()=>{
 const f=await dotFixture();const original=f.store.insert.bind(f.store);f.store.insert=async(k,...args)=>{if(k==='dot_inbox')throw Error('disk failure');return original(k,...args);};
 await assert.rejects(f.g.send(f.a,{to:'dot',text:'rollback',request_id:'dot-rollback-1'}),/disk failure/);assert.equal((await f.store.list('group_receipt')).length,0);f.store.insert=original;
 for(let i=0;i<DOT_INBOX_POLICY.maxMessages;i++)await f.store.put('dot_inbox','fixture-'+i,{owner,agentId:f.dot.agentId,expires:Date.now()+100000,event:{data:{}}});
 await assert.rejects(f.g.send(f.a,{to:'dot',text:'full',request_id:'dot-full-1'}),/capacity/);await f.g.subscription(f.b,inbox());await f.g.send(f.a,{to:'bravo',text:'unaffected',request_id:'other-path-1'});assert.equal(f.events.at(-1).event.data.message.text,'unaffected');
});
test('actual SQL dot inbox survives restart, ACK only removes selected row and expiry prunes',async()=>{
 const db=new PGlite();let tail=Promise.resolve();const query=async(...a)=>{const r=await db.query(...a);return {...r,rowCount:r.affectedRows??r.rows.length};};const pool={query,connect:async()=>{const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return {query,release};}};
 const store=Object.create(Store.prototype);store.pool=pool;
 try{await store.initialize();const f=await dotFixture(store);await f.g.send(f.a,{to:'dot',text:'durable',request_id:'sql-dot-1'});await f.g.send(f.a,{to:'dot',text:'second',request_id:'sql-dot-2'});
 const restarted=Object.create(Store.prototype);restarted.pool=pool;const inbox=new DotInbox(Object.assign(Object.create(Object.getPrototypeOf(f.app)),f.app,{store:restarted}));
 const read=await inbox.list(f.dot);assert.equal(read.messages.length,2);await inbox.ack(f.dot,{message_ids:[read.messages[0].message_id]});assert.equal((await inbox.list(f.dot)).messages.length,1);
 const d=(await store.list('dot_inbox'))[0];await store.put('dot_inbox',d.id,{...d,expires:1});await store.pruneGroupTransport();assert.equal((await store.list('dot_inbox')).length,0);
 }finally{await db.close();}
});

test('ACK draining during callback does not suppress the next new message',async()=>{
 const f=await dotFixture();await f.g.subscription(f.dot,inbox());const original=f.app.post;let release,entered;const started=new Promise(r=>entered=r),barrier=new Promise(r=>release=r);let calls=0;
 f.app.post=async(...args)=>{calls++;if(calls===1){entered();await barrier;}return original(...args);};
 const send=f.g.send(f.a,{to:'dot',text:'first',request_id:'drain-race-1'});await started;const read=await f.inbox.list(f.dot);await f.inbox.ack(f.dot,{message_ids:read.messages.map(m=>m.message_id)});release();await send;
 await f.g.send(f.a,{to:'dot',text:'new',request_id:'drain-race-2'});assert.equal(calls,2);
});

test('pre-upgrade pending dot delivery is cached without extending retention',async()=>{
 const f=await dotFixture(),expires=Date.now()+50000;await f.g.subscription(f.dot,inbox());
 await f.store.put('group_delivery','old-dot',{owner,agentId:f.dot.agentId,state:'pending',attempts:0,next:0,leaseUntil:0,expires,event:{eventId:'old_message',name:'message.created',timestamp:new Date().toISOString(),data:{message_id:'old_message',sender:{kind:'agent',id:f.a.agentId,handle:'alpha'},to:{kind:'agent',id:f.dot.agentId,handle:'dot'},text:'retained on rollout'},cursor:null}});
 await f.g.dispatch(owner);assert.equal((await f.store.list('group_delivery')).length,0);const rows=await f.store.list('dot_inbox');assert.equal(rows.length,1);assert.equal(rows[0].expires,expires);assert.equal((await f.inbox.list(f.dot)).messages[0].text,'retained on rollout');assert.equal(f.events[0].event.data.type,'inbox.ready');
});

const reactionEmojis=calls=>calls.filter(c=>c.method==='setMessageReaction').map(c=>c.args.reaction[0].emoji);
async function boundBot(f,agentId){
 await f.store.put('bot','123',{id:'123',owner,active:true,token:f.app.encrypt('synthetic'),hookSecret:'hook'});
 await f.store.put('group_bot','123',{owner,agentId,bindingId:'generation-one'});
 await configureHuman(f.app,owner,{human_handle:'person',telegram_user_id:'42'});
 return {message_id:7,from:{id:42,is_bot:false,first_name:'Owner'},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'hello dm'};
}

test('inbound Telegram DMs react received, delivered, failed, and never on rejected admission',async()=>{
 const received=await fixture();await boundBot(received,received.a.agentId);
 await received.app.receive('123','hook',{update_id:1,message:{message_id:7,from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'held'}});
 await waitInboundReactions();
 assert.deepEqual(reactionEmojis(received.telegram),[INBOUND_REACTIONS.received]);
 assert.equal((await received.store.list('group_delivery')).length,1);
 const [held]=received.telegram.filter(c=>c.method==='setMessageReaction');
 assert.equal(held.args.chat_id,'42');assert.equal(held.args.message_id,7);assert.deepEqual(held.args.reaction,[{type:'emoji',emoji:INBOUND_REACTIONS.received}]);

 const delivered=await fixture();const dm=await boundBot(delivered,delivered.a.agentId);await delivered.g.subscription(delivered.a,inbox());
 await delivered.app.receive('123','hook',{update_id:1,message:dm});await waitInboundReactions();
 assert.deepEqual(reactionEmojis(delivered.telegram),[INBOUND_REACTIONS.received,INBOUND_REACTIONS.delivered]);
 await delivered.app.receive('123','hook',{update_id:1,message:dm});await waitInboundReactions();
 assert.deepEqual(reactionEmojis(delivered.telegram),[INBOUND_REACTIONS.received,INBOUND_REACTIONS.delivered]);

 const failed=await fixture();await boundBot(failed,failed.a.agentId);
 const original=failed.app.post;failed.app.post=async(url,h,body)=>{const e=JSON.parse(body);if(e.name==='agent.notification'&&e.data?.type==='message.created')return {status:400,body:''};return original(url,h,body);};
 await failed.g.subscription(failed.a,inbox());
 await failed.app.receive('123','hook',{update_id:1,message:{message_id:7,from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'undeliverable'}});
 await waitInboundReactions();
 assert.deepEqual(reactionEmojis(failed.telegram),[INBOUND_REACTIONS.received,INBOUND_REACTIONS.failed]);

 const rejected=await fixture();await rejected.store.put('bot','123',{id:'123',owner,active:true,token:rejected.app.encrypt('synthetic'),hookSecret:'hook'});
 await rejected.store.put('group_bot','123',{owner,agentId:rejected.a.agentId,bindingId:'generation-one'});
 await rejected.app.receive('123','hook',{update_id:1,message:{message_id:7,from:{id:99,is_bot:false},chat:{id:99,type:'private'},date:Math.floor(Date.now()/1000),text:'unregistered'}});
 await waitInboundReactions();
 assert.equal(reactionEmojis(rejected.telegram).length,0);
 assert(rejected.telegram.some(c=>c.method==='sendMessage'&&c.args.text.includes('你的 Telegram ID 是 99')));
 await rejected.app.receive('123','hook',{update_id:2,message:{message_id:8,from:{id:42,is_bot:false},chat:{id:-1,type:'group'},date:Math.floor(Date.now()/1000),text:'group'}});
 await waitInboundReactions();
 assert.equal(reactionEmojis(rejected.telegram).length,0);
});

test('inbound reaction transport failure is log-only and does not block delivery or retry',async()=>{
 const f=await fixture();const dm=await boundBot(f,f.a.agentId);await f.g.subscription(f.a,inbox());
 const logs=[],info=console.info;console.info=value=>logs.push(value);
 const original=f.app.telegram;let reactionCalls=0;
 f.app.telegram=async(t,method,args)=>{if(method==='setMessageReaction'){reactionCalls++;throw Object.assign(new Error('synthetic reaction failure'),{telegramOutcome:'failed'});}return original(t,method,args);};
 try{
  await f.app.receive('123','hook',{update_id:1,message:dm});await waitInboundReactions();
  assert.equal(f.events.filter(e=>e.event.data.type==='message.created').length,1);
  assert.equal(f.events[0].event.data.message.text,'hello dm');
  assert.equal(reactionCalls,2);
  assert(logs.some(line=>String(line).includes('inbound_reaction_failed')&&String(line).includes(INBOUND_REACTIONS.received)));
  assert(!JSON.stringify(logs).includes('hello dm'));assert(!JSON.stringify(logs).includes('synthetic'));
 }finally{console.info=info;}
});

test('in-progress inbound delivery keeps the received reaction until a terminal outcome',async()=>{
 const f=await fixture();await boundBot(f,f.a.agentId);
 const original=f.app.post;f.app.post=async(url,h,body)=>{const e=JSON.parse(body);if(e.name==='agent.notification'&&e.data?.type==='message.created')return {status:503,body:''};return original(url,h,body);};
 await f.g.subscription(f.a,inbox());
 await f.app.receive('123','hook',{update_id:1,message:{message_id:7,from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'retry later'}});
 await waitInboundReactions();
 assert.deepEqual(reactionEmojis(f.telegram),[INBOUND_REACTIONS.received]);
 const d=(await f.store.list('group_delivery')).find(row=>row.event?.data?.telegram?.message_id===7);assert.equal(d.state,'pending');
});

test('dot inbound DMs react delivered after inbox.ready and failed after wake exhaustion',async()=>{
 const ok=await dotFixture();const dm=await boundBot(ok,ok.dot.agentId);await ok.g.subscription(ok.dot,inbox());
 await ok.app.receive('123','hook',{update_id:1,message:dm});await waitInboundReactions();
 assert.deepEqual(reactionEmojis(ok.telegram),[INBOUND_REACTIONS.received,INBOUND_REACTIONS.delivered]);
 assert.equal((await ok.inbox.list(ok.dot)).messages.length,1);

 const fail=await dotFixture();await boundBot(fail,fail.dot.agentId);await fail.g.subscription(fail.dot,inbox());
 fail.app.post=async()=>({status:400});
 await fail.app.receive('123','hook',{update_id:2,message:{message_id:9,from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'wake fails'}});
 for(let i=1;i<8;i++){const wake=await fail.store.get('dot_wake',fail.dot.agentId);await fail.store.put('dot_wake',fail.dot.agentId,{...wake,next:0});await fail.g.dispatch(owner);}
 await waitInboundReactions();
 assert.deepEqual(reactionEmojis(fail.telegram),[INBOUND_REACTIONS.received,INBOUND_REACTIONS.failed]);
 assert.equal((await fail.store.list('dot_inbox'))[0].reaction,'failed');
 await fail.app.receive('123','hook',{update_id:3,message:{message_id:10,from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'second wake fails'}});
 for(let i=1;i<8;i++){const wake=await fail.store.get('dot_wake',fail.dot.agentId);await fail.store.put('dot_wake',fail.dot.agentId,{...wake,next:0});await fail.g.dispatch(owner);}
 await waitInboundReactions();
 const failedIds=fail.telegram.filter(c=>c.method==='setMessageReaction'&&c.args.reaction[0].emoji===INBOUND_REACTIONS.failed).map(c=>c.args.message_id);
 assert.deepEqual(failedIds,[9,10]);
 fail.app.post=async(url,h,body)=>{const e=JSON.parse(body);return {status:200,body:JSON.stringify({challenge:e.challenge})};};
 const wake=await fail.store.get('dot_wake',fail.dot.agentId);await fail.store.put('dot_wake',fail.dot.agentId,{...wake,exhausted:false,next:0,attempts:0});
 await fail.g.dispatch(owner);await waitInboundReactions();
 assert.deepEqual(fail.telegram.filter(c=>c.method==='setMessageReaction'&&c.args.reaction[0].emoji===INBOUND_REACTIONS.delivered).map(c=>c.args.message_id).sort((a,b)=>a-b),[9,10]);
});

test('Telegram webhook returns while waitUntil holds inbound reaction work',async()=>{
 const f=await fixture();const dm=await boundBot(f,f.a.agentId);
 const held=[];f.app.waitUntil=work=>held.push(work);
 let release;const blocked=new Promise(r=>release=r);
 const original=f.app.telegram;
 f.app.telegram=async(t,method,args)=>{if(method==='setMessageReaction'){await blocked;f.telegram.push({method,args});return {ok:true};}return original(t,method,args);};
 const req=Readable.from([JSON.stringify({update_id:1,message:dm})]);
 Object.assign(req,{url:'/telegram/123',method:'POST',headers:{'x-telegram-bot-api-secret-token':'hook','content-type':'application/json'}});
 let ended=false;const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(b){ended=true;this.body=b??'';}};
 await handler(f.app)(req,res);
 assert.equal(ended,true);assert.equal(res.statusCode,200);assert.deepEqual(JSON.parse(res.body),{ok:true});
 assert.equal(reactionEmojis(f.telegram).length,0);assert(held.length>=1);
 let settled=false;Promise.all(held).then(()=>settled=true);await Promise.resolve();assert.equal(settled,false);
 release();await Promise.all(held);await waitInboundReactions();
 assert.deepEqual(reactionEmojis(f.telegram),[INBOUND_REACTIONS.received]);
});
