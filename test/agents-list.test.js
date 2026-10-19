import test from 'node:test';
import assert from 'node:assert/strict';
import {App,tools} from '../src/app.js';
import {Dms} from '../src/dms.js';
import {registerAgent} from '../src/agents.js';
import {configureHuman} from '../src/telegram-owner.js';
const owner='mcp:admin',secret='whsec_'+Buffer.alloc(32,8).toString('base64');
class MemoryStore {
 constructor(){this.data=new Map();this.queue=Promise.resolve();}
 async get(k,id){return structuredClone(this.data.get(k+':'+id));}
 async put(k,id,v){this.data.set(k+':'+id,structuredClone(v));}
 async insert(k,id,v){if(this.data.has(k+':'+id))return false;await this.put(k,id,v);return true;}
 async delete(k,id){this.data.delete(k+':'+id);}
 async list(k,o){return [...this.data].filter(([id,v])=>id.startsWith(k+':')&&(!o||v.owner===o)).map(([id,v])=>({...structuredClone(v),id:id.slice(k.length+1)}));}
 async listAgentInbox(o,a){return (await this.list('muse_inbox',o)).filter(d=>d.agentId===a);}
 async withHeldConnectionLock(key,fn){return fn(this);}
 async lease(k,id){const v=await this.get(k,id);if(!v||v.leaseUntil>Date.now())return;v.leaseUntil=Date.now()+30000;await this.put(k,id,v);return v;}
 async withLock(key,fn){const last=this.queue;let release;this.queue=new Promise(r=>release=r);await last;const before=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=before;throw e;}finally{release();}}
 async telegramReactionSnapshot(botId,owner,agentId){return {bot:await this.get('bot',botId),route:await this.get('group_bot',botId),agent:await this.get('agent',agentId),humans:await this.list('human',owner)};}
 async withBotLock(key,fn){const last=this.queue;let release;this.queue=new Promise(r=>release=r);await last;try{return await fn(this);}finally{release();}}
 async reserveDeniedReply(){return true;}
 async pruneGroupTransport(now=Date.now()){for(const k of ['group_delivery','group_receipt','dot_inbox','muse_inbox'])for(const r of await this.list(k))if(r.expires<=now)await this.delete(k,r.id);}
}
async function fixture(){
 const events=[],telegram=[];const app=new App({store:new MemoryStore(),instanceKey:'x'.repeat(64),key:Buffer.alloc(32,7).toString('base64'),origin:'https://mcp.example',post:async(url,h,body)=>{const e=JSON.parse(body);if(e.type!=='verification')events.push({url,event:e});return {status:200,body:JSON.stringify({challenge:e.challenge})};},telegram:async(t,method,args)=>{telegram.push({method,args});return {message_id:9};}});
 const principals=[];
 for(const handle of ['alpha','bravo','charlie']){const a=await registerAgent(app,{owner,authType:'api_key'},{handle});principals.push({owner,agentId:a.agent_id,handle,authType:'api_key'});}
 const muse=await registerAgent(app,{owner,authType:'api_key'},{handle:'synmuse'},{botType:'muse'});
 const dot=await registerAgent(app,{owner,authType:'api_key'},{handle:'dot'});
 const grok=await registerAgent(app,{owner,authType:'api_key'},{handle:'groker'});
 const grokRow=await app.store.get('agent',grok.agent_id);
 await app.store.put('agent',grok.agent_id,{...grokRow,grokbotAgentName:'Synthetic Grok'});
 return {store:app.store,app,g:new Dms(app),events,telegram,a:principals[0],b:principals[1],c:principals[2],muse:{owner,agentId:muse.agent_id,handle:'synmuse',authType:'api_key'},dot:{owner,agentId:dot.agent_id,handle:'dot',authType:'api_key'},grok:{owner,agentId:grok.agent_id,handle:'groker',authType:'api_key'}};
}
const handles=result=>result.agents.map(a=>a.handle).sort();
const inbox=(url='https://callback.example/bravo')=>({name:'agent.notification',arguments:{},delivery:{mode:'webhook',url,secret}});
const privateStart=(id=1)=>({update_id:id,my_chat_member:{chat:{id:42,type:'private'},from:{id:42,is_bot:false},old_chat_member:{status:'left',user:{id:123,is_bot:true}},new_chat_member:{status:'member',user:{id:123,is_bot:true}}}});
const privateKick=(id=2)=>({update_id:id,my_chat_member:{chat:{id:42,type:'private'},from:{id:42,is_bot:false},old_chat_member:{status:'member',user:{id:123,is_bot:true}},new_chat_member:{status:'kicked',user:{id:123,is_bot:true}}}});
const privateDm=(id=3)=>({update_id:id,message:{message_id:id,date:Math.floor(Date.now()/1000),from:{id:42,is_bot:false,first_name:'Person'},chat:{id:42,type:'private'},text:'hello'}});

test('agents_list description is the caller-filtered sendable list',()=>{
 const description=tools.find(t=>t.name==='agents_list').description;
 assert.match(description,/current caller can deliver to/);
 assert.match(description,/receive channel/);
 assert.match(description,/accepted this private DM/);
 assert.match(description,/caller is omitted/);
 assert.doesNotMatch(description,/\binbox\b|mailbox|phone|\bcall\b/i);
});

test('agents_list omits the caller, agents with no receive channel, and humans until a bound bot has an accepted DM',async()=>{
 const f=await fixture();
 await configureHuman(f.app,owner,{human_handle:'person',human_display_name:'Person',telegram_user_id:'42'});
 await f.g.subscription(f.b,inbox());
 const none=await f.app.invoke(owner,'agents_list',{},f.a);
 assert.deepEqual(handles(none),['bravo','dot','groker','synmuse']);
 assert(!none.agents.some(a=>a.handle==='alpha'));
 assert(!none.agents.some(a=>a.handle==='charlie'));
 assert(!none.agents.some(a=>a.handle==='person'));
 assert.equal(none.agents.find(a=>a.handle==='bravo').type,'agent');
 assert.equal(none.agents.find(a=>a.handle==='synmuse').bot_type,'muse');
 assert.equal(none.agents.find(a=>a.handle==='groker').grokbot_agent_name,'Synthetic Grok');

 await f.store.put('bot','123',{id:'123',owner,active:true,token:f.app.encrypt('synthetic'),hookSecret:'hook'});
 await f.store.put('group_bot','123',{owner,agentId:f.a.agentId,bindingId:'gen-1'});
 const bound=await f.app.invoke(owner,'agents_list',{},f.a);
 assert(!bound.agents.some(a=>a.handle==='person'));

 await f.app.receive('123','hook',privateDm());
 const accepted=await f.app.invoke(owner,'agents_list',{},f.a);
 const person=accepted.agents.find(a=>a.handle==='person');
 assert.deepEqual(person,{type:'human',handle:'person',display_name:'Person'});
 assert(!JSON.stringify(accepted).includes('42'));
});

test('agents_list includes a human after private-chat accept and drops them after they leave',async()=>{
 const f=await fixture();
 await configureHuman(f.app,owner,{human_handle:'person',telegram_user_id:'42'});
 await f.store.put('bot','123',{id:'123',owner,active:true,token:f.app.encrypt('synthetic'),hookSecret:'hook'});
 await f.store.put('group_bot','123',{owner,agentId:f.a.agentId,bindingId:'gen-1'});
 assert(!handles(await f.app.invoke(owner,'agents_list',{},f.a)).includes('person'));
 await f.app.receive('123','hook',privateStart());
 assert(handles(await f.app.invoke(owner,'agents_list',{},f.a)).includes('person'));
 await f.app.receive('123','hook',privateKick());
 assert(!handles(await f.app.invoke(owner,'agents_list',{},f.a)).includes('person'));
});

test('messages_send still validates handles that agents_list omitted',async()=>{
 const f=await fixture();
 await configureHuman(f.app,owner,{human_handle:'person',telegram_user_id:'42'});
 await f.store.put('bot','123',{id:'123',owner,active:true,token:f.app.encrypt('synthetic'),hookSecret:'hook'});
 await f.store.put('group_bot','123',{owner,agentId:f.a.agentId,bindingId:'gen-1'});
 assert(!handles(await f.app.invoke(owner,'agents_list',{},f.a)).includes('charlie'));
 assert(!handles(await f.app.invoke(owner,'agents_list',{},f.a)).includes('person'));
 const queued=await f.g.send(f.a,{to:'charlie',text:'around the list',request_id:'list-backstop-agent'});
 assert.equal(queued.to,'charlie');
 const human=await f.g.send(f.a,{to:'person',text:'around the list',request_id:'list-backstop-human'});
 assert.equal(human.to,'person');assert.equal(human.telegram.status,'sent');
});
