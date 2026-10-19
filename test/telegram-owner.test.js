import test from 'node:test';
import assert from 'node:assert/strict';
import {configureHuman,getHuman,listHumans,getHumanByTelegramId,humanKey,TelegramOwner} from '../src/telegram-owner.js';
const owner='mcp:admin',agentId='synthetic-agent';
class MemoryStore{
 constructor(){this.data=new Map();this.calls=[];this.tail=Promise.resolve();}
 async get(k,id){return structuredClone(this.data.get(k+':'+id));}
 async put(k,id,v){this.data.set(k+':'+id,structuredClone(v));}
 async list(k,owner){return [...this.data].filter(([id,v])=>id.startsWith(k+':')&&v.owner===owner).map(([,v])=>structuredClone(v));}
 async withLock(key,fn){const previous=this.tail;let release;this.tail=new Promise(resolve=>{release=resolve;});await previous;try{return await fn(this);}finally{release();}}
}
async function fixture(){
 const store=new MemoryStore(),calls=[];const bot={id:'123',owner,active:true,token:'synthetic-encrypted'};
 await store.put('agent',agentId,{owner,agentId,handle:'assistant',displayName:'Assistant'});await store.put('bot',bot.id,bot);await store.put('group_bot',bot.id,{owner,agentId,bindingId:'generation-1'});
 const app={store,decrypt:value=>{assert.equal(value,bot.token);return 'synthetic-token';},telegram:async(token,method,args)=>{calls.push({method,args});assert.equal(token,'synthetic-token');return[{status:'creator',user:{id:42,is_bot:false}}];}};
 await configureHuman(app,owner,{human_handle:'human-owner',human_display_name:'Owner',telegram_user_id:'42'});
 return {app,store,bot,calls,helper:new TelegramOwner(app)};
}
function joined(id=1){return {update_id:id,my_chat_member:{chat:{id:-1234,type:'supergroup'},date:Math.floor(Date.now()/1000),old_chat_member:{status:'left',user:{id:123,is_bot:true}},new_chat_member:{status:'member',user:{id:123,is_bot:true}}}};}

test('humans are keyed by handle with one-to-one Telegram mappings and explicit provenance',async()=>{
 const f=await fixture();let human=await getHuman(f.app,owner,'human-owner');
 assert.equal(human.type,'human');assert.equal(human.telegram_user_id,'42');assert.equal(human.provenance,'configured_by_authenticated_owner');assert.equal(human.display_name,'Owner');
 assert.equal((await configureHuman(f.app,owner,{human_handle:'human-owner',telegram_user_id:'42'})).display_name,'Owner');
 human=await configureHuman(f.app,owner,{human_handle:' replacement ',telegram_user_id:'43'});
 assert.equal(human.handle,'replacement');assert.equal(human.display_name,'replacement');assert.equal(human.telegram_user_id,'43');assert.equal((await f.store.list('human',owner)).length,2);
 assert.equal((await getHumanByTelegramId(f.app,owner,'43')).handle,'replacement');assert.equal((await listHumans(f.app,owner)).length,2);assert.equal(await getHuman(f.app,owner),null);
 await configureHuman(f.app,owner,{human_handle:'replacement',telegram_user_id:'44',replace_telegram_user_id:'43'});assert.equal((await listHumans(f.app,owner)).length,2);assert.equal(await getHumanByTelegramId(f.app,owner,'43'),null);
 await assert.rejects(configureHuman(f.app,owner,{human_handle:'third-human',telegram_user_id:'44'}),/already assigned/);
 assert.equal(await getHuman(f.app,'other-owner'),null);assert.equal(f.calls.length,0);
});
test('human configuration rejects invalid IDs, handles, display names and agent collisions',async()=>{
 const f=await fixture();const before=await getHuman(f.app,owner,'human-owner');
 for(const telegram_user_id of ['0','-1','01','abc','9007199254740992',42])await assert.rejects(configureHuman(f.app,owner,{human_handle:'valid-human',telegram_user_id}));
 for(const human_handle of ['','a','bad handle','assistant','Replacement'])await assert.rejects(configureHuman(f.app,owner,{human_handle,telegram_user_id:'42'}));
 await assert.rejects(configureHuman(f.app,owner,{human_handle:'valid-human',telegram_user_id:'42',human_display_name:''}));assert.deepEqual(await getHuman(f.app,owner,'human-owner'),before);
});
test('Telegram group joins are ignored for the private-DM product',async()=>{
 const f=await fixture();assert.equal(await f.helper.join(f.bot,joined()),null);assert.equal(f.calls.length,0);assert.equal((await f.store.list('chat',owner)).length,0);
});
test('actual Postgres SQL: handle configuration preserves uniqueness',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const {Store}=await import('../src/store.js');
 const db=new PGlite();let tail=Promise.resolve();const acquire=async()=>{let release;const next=new Promise(resolve=>{release=resolve;});const previous=tail;tail=next;await previous;return release;};
 const query=async(sql,args)=>{const result=await db.query(sql,args);return {rows:result.rows,rowCount:result.affectedRows??result.rows.length};};
 const store=Object.create(Store.prototype);store.pool={query:async(sql,args)=>{const release=await acquire();try{return await query(sql,args);}finally{release();}},connect:async()=>({query,release:await acquire()})};
 try{
  await store.initialize();const f=await fixture();f.app.store=store;
  await store.put('agent',agentId,{owner,agentId,handle:'assistant',displayName:'Assistant'});await store.put('bot','123',f.bot);await store.put('group_bot','123',{owner,agentId,bindingId:'generation-1'});
  await configureHuman(f.app,owner,{human_handle:'human-owner',telegram_user_id:'42'});
  assert.equal((await getHuman(f.app,owner,'human-owner')).telegram_user_id,'42');
  assert.equal(await new TelegramOwner(f.app).join(f.bot,joined()),null);
  await assert.rejects(configureHuman(f.app,owner,{human_handle:'other',telegram_user_id:'42'}),/already assigned/);
 }finally{await db.close();}
});
test('concurrent different handles cannot claim one Telegram user ID',async()=>{
 const f=await fixture();const results=await Promise.allSettled([configureHuman(f.app,owner,{human_handle:'first-new',telegram_user_id:'44'}),configureHuman(f.app,owner,{human_handle:'second-new',telegram_user_id:'44'})]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal((await listHumans(f.app,owner)).filter(human=>human.telegram_user_id==='44').length,1);
});
test('agent registration cannot reuse a configured human handle',async()=>{
 const {registerAgent}=await import('../src/agents.js');const f=await fixture();
 await assert.rejects(registerAgent(f.app,{owner,authType:'api_key',agentId:null},{handle:'human-owner'}),/human/i);
 assert.equal((await listHumans(f.app,owner)).length,1);assert.equal((await f.store.list('agent',owner)).length,1);
});
test('changing an existing handle Telegram ID requires an exact current-ID replacement guard',async()=>{
 const f=await fixture();
 for(const replace_telegram_user_id of [undefined,'wrong','43'])await assert.rejects(configureHuman(f.app,owner,{human_handle:'human-owner',telegram_user_id:'43',replace_telegram_user_id}),/current Telegram user ID/);
 assert.equal((await getHuman(f.app,owner,'human-owner')).telegram_user_id,'42');
 const replaced=await configureHuman(f.app,owner,{human_handle:'human-owner',telegram_user_id:'43',replace_telegram_user_id:'42'});assert.equal(replaced.telegram_user_id,'43');
 await assert.rejects(configureHuman(f.app,owner,{human_handle:'human-owner',telegram_user_id:'44',replace_telegram_user_id:'42'}),/current Telegram user ID/);
});
