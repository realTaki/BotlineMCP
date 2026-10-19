import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {Store} from '../src/store.js';
import {App,tools} from '../src/app.js';
import {registerAgent} from '../src/agents.js';
import {Dms} from '../src/dms.js';
const owner='mcp:admin',secret='whsec_'+Buffer.alloc(32,8).toString('base64'),token=id=>id+':'+ 'x'.repeat(30);
async function fixture(){
 const db=new PGlite();let tail=Promise.resolve();const store=Object.create(Store.prototype);
 store.pool={query:(...a)=>db.query(...a),connect:async()=>{const prior=tail;let release;tail=new Promise(r=>release=r);await prior;return {query:(...a)=>db.query(...a),release};}};await store.initialize();
 const calls=[],events=[];let failHook=false,failSend=false,failDelete=false;
 const app=new App({store,instanceKey:'x'.repeat(64),key:Buffer.alloc(32,2).toString('base64'),origin:'https://mcp.example',post:async(url,h,b)=>{const e=JSON.parse(b);if(e.type!=='verification')events.push(e);return{status:200,body:JSON.stringify({challenge:e.challenge})};},telegram:async(t,method,args)=>{calls.push({method,args});if(method==='getMe')return{id:Number(t.split(':')[0]),is_bot:true,username:'test'};if(method==='getWebhookInfo')return{url:''};if(method==='setWebhook'&&failHook)throw Error('hook failed');if(method==='deleteWebhook'&&failDelete)throw Error('delete uncertain');if(method==='sendMessage'&&failSend)throw Error('send uncertain');return{message_id:1};}});
 const a=await registerAgent(app,{owner,authType:'api_key'},{handle:'alpha'}),b=await registerAgent(app,{owner,authType:'api_key'},{handle:'bravo'});
 return {db,store,app,calls,events,a:{owner,agentId:a.agent_id,authType:'api_key'},b:{owner,agentId:b.agent_id,authType:'api_key'},failHook:()=>failHook=true,failSend:()=>failSend=true,failDelete:()=>failDelete=true};
}
const call=(f,p,name,args={})=>f.app.invoke(owner,name,args,p);
test('single bot per handle, default routing, admission, unified sends and real unbind',async()=>{
 const f=await fixture();try{
 await assert.rejects(call(f,{owner},'telegram_bot_bind',{token:token(123)}),/Register/);
 await call(f,f.a,'telegram_bot_bind',{token:token(123)});
 assert.equal((await call(f,f.a,'telegram_bot_get')).bot.bot_id,'123');assert.equal((await call(f,f.b,'telegram_bot_get')).bot,null);
 assert.equal((await f.store.get('group_bot','123')).agentId,f.a.agentId);
 await assert.rejects(call(f,f.a,'telegram_bot_bind',{token:token(456)}),/already has a bot/);await assert.rejects(call(f,f.b,'telegram_bot_bind',{token:token(123)}),/another handle/);
 const g=new Dms(f.app);await g.subscription(f.a,{name:'agent.notification',arguments:{},delivery:{mode:'webhook',url:'https://callback.example/main',secret}});
 await call(f,f.a,'human_register',{human:'person',telegram_user_id:'42'});
 await call(f,f.a,'telegram_bot_bind',{token:token(123)});
 const sent=await g.send(f.a,{to:'person',text:'reply',request_id:'dm-msg-001'});assert.equal(sent.telegram.status,'sent');assert.equal(sent.to,'person');
 await f.store.put('group_delivery','pending',{owner,agentId:f.a.agentId,state:'pending',event:{eventId:'old',name:'message.created',data:{telegram:{bot_id:'123'},text:'pending'}},expires:Date.now()+10000});
 const unbound=await call(f,f.a,'telegram_bot_unbind');assert(unbound.unbound);const b=await f.store.get('bot','123');assert(!b.token&&!b.hookSecret&&!b.active);assert.equal(await f.store.get('group_bot','123'),undefined);assert.equal(await f.store.get('group_delivery','pending'),undefined);
 await assert.rejects(g.send(f.a,{to:'person',text:'after unbind',request_id:'dm-msg-002'}),/No bot is bound/);assert((await call(f,f.a,'telegram_bot_unbind')).unbound);
 await call(f,f.a,'telegram_bot_bind',{token:token(456)});assert.equal((await call(f,f.a,'telegram_bot_get')).bot.bot_id,'456');
 }finally{await f.db.close();}
});
test('failed bind remains inactive, and uncertain Telegram send is never retried',async()=>{
 const f=await fixture();try{f.failHook();await assert.rejects(call(f,f.a,'telegram_bot_bind',{token:token(123)}));assert.equal((await f.store.get('bot','123')).active,false);assert.equal((await f.store.get('group_bot','123')).agentId,f.a.agentId);
 await call(f,f.a,'telegram_bot_unbind');assert(!(await f.store.get('bot','123')).token);
 }finally{await f.db.close();}
 const g=await fixture();try{await call(g,g.a,'telegram_bot_bind',{token:token(123)});await call(g,g.a,'human_register',{human:'person',telegram_user_id:'42'});g.failSend();const args={to:'person',text:'ambiguous',request_id:'send-uncertain'};await assert.rejects(new Dms(g.app).send(g.a,args));const result=await new Dms(g.app).send(g.a,args);assert.equal(result.telegram.status,'uncertain');assert.equal(g.calls.filter(c=>c.method==='sendMessage'&&c.args.text==='ambiguous').length,1);
 }finally{await g.db.close();}
});
test('legacy routes remain untouched and ambiguous assignments fail closed',async()=>{
 const f=await fixture();try{await f.app.bind(owner,{token:token(789)});assert.equal(await f.store.get('group_bot','789'),undefined);assert.equal((await f.app.invoke(owner,'bot_list')).bots[0].assignment_required,true);
 await f.store.put('group_bot','111',{owner,agentId:f.a.agentId});await f.store.put('group_bot','222',{owner,agentId:f.a.agentId});await assert.rejects(call(f,f.a,'telegram_bot_get'),/Multiple/);await assert.rejects(call(f,f.a,'telegram_bot_bind',{token:token(123)}),/Multiple/);assert.equal((await f.store.list('group_bot')).length,2);
 }finally{await f.db.close();}
});
test('public list is the full catalog and rejects retired public calls',async()=>{
 const app=new App({}),names=(await app.rpc(null,'tools/list')).tools.map(t=>t.name);
 assert.deepEqual(names,tools.map(t=>t.name));assert.equal(names.length,15);
 for(const n of ['chats_create','chats_list','bot_disconnect','bot_reconnect','bot_groups_enable','telegram_send_message','delivery_retry','bot_list','bot_access_get','telegram_whitelist_update','bot_access_update'])assert(!names.includes(n));
 for(const n of ['delivery_retry','__delivery_retry_internal','bot_access_get','telegram_whitelist_update','bot_access_update'])await assert.rejects(app.rpc(owner,'tools/call',{name:n,arguments:{}}),/retired/);
});
test('unbind waits for an authorized in-flight send before removing the binding',async()=>{
 const f=await fixture();try{
  await call(f,f.a,'telegram_bot_bind',{token:token(123)});
  await call(f,f.a,'human_register',{human:'person',telegram_user_id:'42'});
  const original=f.app.telegram;
  let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.app.telegram=async(...args)=>{if(args[1]==='sendMessage'){entered();await gate;}return original(...args);};
  const sending=new Dms(f.app).send(f.a,{to:'person',text:'in flight',request_id:'locked-send-01'});await started;
  const unbinding=call(f,f.a,'telegram_bot_unbind');await new Promise(r=>setTimeout(r,10));
  assert.equal(f.calls.filter(c=>c.method==='deleteWebhook').length,0);release();await sending;await unbinding;
  await assert.rejects(new Dms(f.app).send(f.a,{to:'person',text:'late',request_id:'locked-send-02'}),/No bot is bound/);
  assert.equal(f.calls.filter(c=>c.method==='sendMessage'&&c.args.text==='late').length,0);
 }finally{await f.db.close();}
});
test('handle-bound bots ignore Telegram groups and still admit private DMs',async()=>{
 const f=await fixture();try{
  await call(f,f.a,'telegram_bot_bind',{token:token(123)});
  await call(f,f.a,'human_register',{human:'person',telegram_user_id:'42'});
  await call(f,f.a,'human_register',{human:'colleague',telegram_user_id:'43'});
  assert.equal((await call(f,f.a,'telegram_bot_get')).humans.length,2);
  const original=f.app.telegram;f.app.telegram=async(...a)=>a[1]==='getChatAdministrators'?[{status:'creator',user:{id:42,is_bot:false}}]:original(...a);
  const hook=(await f.store.get('bot','123')).hookSecret,now=Math.floor(Date.now()/1000),g=new Dms(f.app);
  await g.subscription(f.a,{name:'agent.notification',arguments:{},delivery:{mode:'webhook',url:'https://callback.example/inbox',secret}});
  const join={update_id:1,my_chat_member:{chat:{id:-100,type:'group'},date:now,old_chat_member:{status:'left',user:{id:123,is_bot:true}},new_chat_member:{status:'member',user:{id:123,is_bot:true}}}};
  await f.app.receive('123',hook,join);assert.equal((await f.store.list('chat',owner)).length,0);assert.equal(f.calls.filter(c=>c.method==='getChatAdministrators').length,0);
  const groupMsg={update_id:2,message:{message_id:2,date:now,from:{id:42,is_bot:false,first_name:'Fixture'},chat:{id:-100,type:'group'},text:'group text'}};
  await f.app.receive('123',hook,groupMsg);assert.equal(f.events.filter(e=>e.name==='agent.notification').length,0);
  const dm={update_id:3,message:{message_id:3,date:now,from:{id:42,is_bot:false,first_name:'Fixture'},chat:{id:42,type:'private'},text:'private text'}};
  await f.app.receive('123',hook,dm);
  const notices=f.events.filter(e=>e.name==='agent.notification'&&e.data.type==='message.created');assert.equal(notices.length,1);assert.equal(notices[0].data.message.text,'private text');assert.equal(notices[0].data.message.sender.handle,'person');
 }finally{await f.db.close();}
});
test('Telegram group joins never admit chats even when delivery capacity is full',async()=>{
 const f=await fixture();try{
  await call(f,f.a,'telegram_bot_bind',{token:token(123)});await call(f,f.a,'human_register',{human:'person',telegram_user_id:'42'});
  const original=f.app.telegram;f.app.telegram=async(...a)=>a[1]==='getChatAdministrators'?[{status:'creator',user:{id:42,is_bot:false}}]:original(...a);
  const hook=(await f.store.get('bot','123')).hookSecret,join={update_id:1,my_chat_member:{chat:{id:-100,type:'group'},date:Math.floor(Date.now()/1000),old_chat_member:{status:'left',user:{id:123,is_bot:true}},new_chat_member:{status:'member',user:{id:123,is_bot:true}}}};
  await f.store.pool.query("INSERT INTO mcp_records(kind,id,value) SELECT 'group_delivery','capacity-'||n,$1::jsonb FROM generate_series(1,512) n",[JSON.stringify({owner,state:'pending',expires:Date.now()+60000})]);
  assert.equal(await f.app.receive('123',hook,join),true);assert.equal((await f.store.list('chat',owner)).length,0);
  assert.equal(f.calls.filter(c=>c.method==='getChatAdministrators').length,0);
 }finally{await f.db.close();}
});
test('human_register once admits private DMs on every bound bot',async()=>{
 const f=await fixture();try{
  await call(f,f.a,'telegram_bot_bind',{token:token(123)});await call(f,f.b,'telegram_bot_bind',{token:token(456)});
  const now=Math.floor(Date.now()/1000),msg=id=>({update_id:id,message:{message_id:id,date:now,from:{id:42,is_bot:false,first_name:'Fixture'},chat:{id:42,type:'private'},text:'hello'}});
  const hook=(await f.store.get('bot','123')).hookSecret,otherHook=(await f.store.get('bot','456')).hookSecret;
  await f.app.receive('123',hook,msg(1));assert(f.calls.some(c=>c.method==='sendMessage'&&c.args.text.includes('你的 Telegram ID 是 42')));
  const result=await call(f,f.a,'human_register',{human:'person',telegram_user_id:'42'});assert.equal(result.human.handle,'person');assert.equal(result.human.telegram_user_id,'42');assert.deepEqual(Object.keys(result).sort(),['human']);
  const g=new Dms(f.app);await g.subscription(f.a,{name:'agent.notification',arguments:{},delivery:{mode:'webhook',url:'https://callback.example/a',secret}});
  await g.subscription(f.b,{name:'agent.notification',arguments:{},delivery:{mode:'webhook',url:'https://callback.example/b',secret}});
  await f.app.receive('123',hook,msg(3));await f.app.receive('456',otherHook,msg(2));
  const notices=f.events.filter(e=>e.name==='agent.notification'&&e.data.type==='message.created');assert.equal(notices.length,2);
  assert.deepEqual(notices.map(e=>e.data.message.sender.handle).sort(),['person','person']);
  const sent=await g.send(f.a,{to:'person',text:'reply',request_id:'dm-every-bot-001'});assert.equal(sent.telegram.status,'sent');
  await assert.rejects(g.send(f.a,{to:'missing-human',text:'no',request_id:'dm-every-bot-002'}),/handle|Unknown|not admitted/);
 }finally{await f.db.close();}
});
test('human registration admits the first private DM and queues it until the inbox exists',async()=>{
 const f=await fixture();try{
  await call(f,f.a,'telegram_bot_bind',{token:token(123)});
  const result=await call(f,f.a,'human_register',{human:'person',telegram_user_id:'42'});assert.equal(result.human.telegram_user_id,'42');assert.deepEqual(Object.keys(result).sort(),['human']);
  const bot=await f.store.get('bot','123'),now=Math.floor(Date.now()/1000);
  await f.app.receive('123',bot.hookSecret,{update_id:1,message:{message_id:1,date:now,from:{id:42,is_bot:false},chat:{id:42,type:'private'},text:'queued first message'}});
  const chats=await f.store.list('chat',owner),pending=await f.store.list('group_delivery',owner);assert.equal(chats.length,0);assert(pending.some(d=>d.event.name==='message.created'));assert(!pending.some(d=>d.event.name==='chat.created'));
  await new Dms(f.app).subscription(f.a,{name:'agent.notification',arguments:{},delivery:{mode:'webhook',url:'https://callback.example/dm',secret}});
  assert.equal(f.events.filter(e=>e.name==='agent.notification'&&e.data.type==='message.created').length,1);
  assert.equal(f.events.find(e=>e.name==='agent.notification').data.message.text,'queued first message');
 }finally{await f.db.close();}
});
test('existing_bot_id migration reuses only server-stored credentials and preserves legacy listeners',async()=>{
 const f=await fixture();try{
  await f.app.bind(owner,{token:token(123)});
  const legacy={owner,botId:'123',chatId:'42',url:'https://callback.example/legacy',secret:f.app.encrypt(secret),expires:Date.now()+60000};await f.store.put('subscription','legacy',legacy);
  const result=await call(f,f.a,'telegram_bot_bind',{existing_bot_id:'123'});assert.equal(result.credential_source,'stored');assert.deepEqual(result.webhook_events,['message','my_chat_member']);assert(!JSON.stringify(result).includes(token(123)));
  assert.deepEqual(await f.store.get('subscription','legacy'),legacy);const firstRoute=await f.store.get('group_bot','123');
  await call(f,f.a,'telegram_bot_bind',{existing_bot_id:'123'});assert.deepEqual(await f.store.get('group_bot','123'),firstRoute);assert.deepEqual(await f.store.get('subscription','legacy'),legacy);
  await assert.rejects(call(f,f.a,'telegram_bot_bind',{existing_bot_id:'123',token:token(123)}),/exactly one/);await assert.rejects(call(f,f.a,'telegram_bot_bind',{}),/exactly one/);
  await assert.rejects(call(f,f.b,'telegram_bot_bind',{existing_bot_id:'123'}),/another handle/);
  await f.app.bind(owner,{token:token(456)});await assert.rejects(call(f,f.a,'telegram_bot_bind',{existing_bot_id:'456'}),/already has a bot/);
  await f.store.put('bot','789',{owner:'other-instance',active:true,token:f.app.encrypt(token(789))});const calls=f.calls.length;
  await assert.rejects(call(f,f.b,'telegram_bot_bind',{existing_bot_id:'789'}),/unavailable/);assert.equal(f.calls.length,calls);
  const original=f.app.telegram;f.app.telegram=async(...a)=>a[1]==='getWebhookInfo'?{url:'https://other-service.example/webhook'}:original(...a);const hookCalls=f.calls.filter(c=>c.method==='setWebhook').length;
  await assert.rejects(call(f,f.b,'telegram_bot_bind',{existing_bot_id:'456'}),e=>/another service/.test(e.message)&&e.bindingState.active===true&&e.bindingState.assigned_to_current_handle===false);assert.equal(f.calls.filter(c=>c.method==='setWebhook').length,hookCalls);assert.equal(await f.store.get('group_bot','456'),undefined);
  const incomplete=await f.store.get('bot','456');delete incomplete.hookSecret;await f.store.put('bot','456',incomplete);await assert.rejects(call(f,f.b,'telegram_bot_bind',{existing_bot_id:'456'}),/webhook secret/);assert.equal((await f.store.get('bot','456')).hookSecret,undefined);

 }finally{await f.db.close();}
});
test('stored-token webhook setup failure exposes safe current state and retries the same binding',async()=>{
 const f=await fixture();try{
  await f.app.bind(owner,{token:token(123)});
  const original=f.app.telegram;let fail=true;f.app.telegram=async(...a)=>{if(a[1]==='setWebhook'&&fail)throw Object.assign(new Error('synthetic webhook failure'),{status:502});return original(...a);};
  await assert.rejects(f.app.rpc(owner,'tools/call',{name:'telegram_bot_bind',arguments:{existing_bot_id:'123'}},f.a),e=>{assert.equal(e.details.code,'binding_setup_failed');assert.equal(e.details.binding.active,false);assert.equal(e.details.binding.assigned_to_current_handle,true);assert.equal(e.details.binding.retry_existing_bot_id,true);assert(!JSON.stringify(e.details).includes(token(123)));return true;});
  const route=await f.store.get('group_bot','123');fail=false;await call(f,f.a,'telegram_bot_bind',{existing_bot_id:'123'});assert.equal((await f.store.get('bot','123')).active,true);assert.deepEqual(await f.store.get('group_bot','123'),route);
  await call(f,f.a,'telegram_bot_unbind');await assert.rejects(call(f,f.a,'telegram_bot_bind',{existing_bot_id:'123'}),/unavailable/);
 }finally{await f.db.close();}
});
test('legacy OAuth registration errors direct the caller to reconnect rather than change parameters',async()=>{
 const f=await fixture();try{await assert.rejects(f.app.rpc(owner,'tools/call',{name:'agent_register',arguments:{handle:'fresh-agent'}},{owner,authType:'oauth'}),e=>e.details.code==='reconnect_required'&&e.details.action.includes('reconnect')&&e.details.retryable===false);}finally{await f.db.close();}
});
test('stored credential identity mismatch cannot mutate or steal another handle bot',async()=>{
 const f=await fixture();try{
  await f.app.bind(owner,{token:token(123)});await call(f,f.b,'telegram_bot_bind',{token:token(456)});
  const old=await f.store.get('bot','123');await f.store.put('bot','123',{...old,token:f.app.encrypt(token(456))});
  const before123=await f.store.get('bot','123'),before456=await f.store.get('bot','456'),route456=await f.store.get('group_bot','456'),calls=f.calls.filter(c=>c.method==='setWebhook').length;
  await assert.rejects(call(f,f.a,'telegram_bot_bind',{existing_bot_id:'123'}),/identity mismatch/);
  assert.deepEqual(await f.store.get('bot','123'),before123);assert.deepEqual(await f.store.get('bot','456'),before456);assert.deepEqual(await f.store.get('group_bot','456'),route456);assert.equal(await f.store.get('group_bot','123'),undefined);assert.equal(f.calls.filter(c=>c.method==='setWebhook').length,calls);
 }finally{await f.db.close();}
});


test('actual SQL dot unbind removes retained inbox payloads and preserves other recipients',async()=>{
 const f=await fixture();try{
  const agent=await registerAgent(f.app,{owner,authType:'api_key'},{handle:'dot'}),dot={owner,agentId:agent.agent_id,authType:'api_key'};
  await call(f,dot,'telegram_bot_bind',{token:token(789)});
  await call(f,dot,'human_register',{human:'person',telegram_user_id:'42'});
  const bot=await f.store.get('bot','789');await f.app.receive('789',bot.hookSecret,{update_id:1,message:{message_id:1,from:{id:42,is_bot:false},chat:{id:42,type:'private'},date:Math.floor(Date.now()/1000),text:'held for dot'}});
  assert.equal((await call(f,dot,'messages_inbox')).messages.length,1);
  await new Dms(f.app).send(f.a,{to:'bravo',text:'other recipient',request_id:'other-retain-1'});
  await call(f,dot,'telegram_bot_unbind');assert.equal((await f.store.list('dot_inbox',owner)).length,0);assert.equal((await f.store.list('group_delivery',owner)).length,1);
 }finally{await f.db.close();}
});
