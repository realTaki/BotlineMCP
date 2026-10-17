import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {hash} from '../src/security.js';

const owner='asp:admin',botId='123456',handle='synthetic-agent',agentId='agent_'+hash(JSON.stringify([owner,handle]));
const listenerId=hash(JSON.stringify([agentId,'chat.created',null]));
const document=await readFile(new URL('../docs/legacy-bot-migration.md',import.meta.url),'utf8');
function documentedSql(marker,values={botId,handle}){
 const blocks=[...document.matchAll(/```sql\n([\s\S]*?)\n```/g)].map(match=>match[1]);
 const sql=blocks.find(block=>block.startsWith('-- legacy-migration:'+marker+'\n'));
 assert(sql,'Expected the actual documented SQL block');
 return sql.replaceAll('<bot_id>',values.botId).replaceAll('<agent_handle>',values.handle);
}
async function put(db,kind,id,value){await db.query('INSERT INTO asp_records(kind,id,value) VALUES($1,$2,$3) ON CONFLICT(kind,id) DO UPDATE SET value=EXCLUDED.value',[kind,id,JSON.stringify(value)]);}
async function get(db,kind,id){return (await db.query('SELECT value FROM asp_records WHERE kind=$1 AND id=$2',[kind,id])).rows[0]?.value;}
async function snapshot(db){return (await db.query('SELECT kind,id,value FROM asp_records ORDER BY kind,id')).rows;}
async function fixture(){
 const db=new PGlite();await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
 const bot={id:botId,owner,active:true,token:'synthetic-encrypted-bot-token',hookSecret:'synthetic-hook-secret',users:['42'],chats:['42','-100'],ownedChats:{'-100':{handle:'synthetic-human',telegram_user_id:'42'}},username:'synthetic_bot'};
 const agent={owner,agentId,handle,displayName:'Synthetic Agent',created:'2026-01-01T00:00:00.000Z'};
 const listener={owner,agentId,name:'agent.notification',chatId:null,expires:Date.now()+600000,url:'https://synthetic.example/notification',secret:'synthetic-encrypted-callback-secret'};
 await put(db,'bot',botId,bot);await put(db,'agent',agentId,agent);await put(db,'group_subscription',listenerId,listener);
 await put(db,'subscription','legacy-sub',{owner,botId,url:'https://synthetic.example/legacy',secret:'synthetic-legacy-secret',expires:Date.now()+600000});
 await put(db,'access','synthetic-access-hash',{owner,agentId,sessionId:'synthetic-existing-session',expires:Date.now()+600000});
 return {db,bot,agent,listener};
}
async function rejected(db,pattern){const before=await snapshot(db);await assert.rejects(db.exec(documentedSql('apply')),pattern);await db.exec('ROLLBACK');assert.deepEqual(await snapshot(db),before);}

test('documented read-only inspection exposes only safe readiness fields and changes nothing',async()=>{
 const f=await fixture();try{
  const before=await snapshot(f.db),result=(await f.db.query(documentedSql('inspect'))).rows[0];
  assert.deepEqual(Object.keys(result),['bot_exists','bot_active','token_present','matching_registered_agent_count','current_assigned_handle','other_bot_for_handle','valid_main_listener']);
  assert.equal(result.bot_exists,true);assert.equal(result.bot_active,true);assert.equal(result.token_present,true);assert.equal(Number(result.matching_registered_agent_count),1);assert.equal(result.current_assigned_handle,null);assert.equal(result.other_bot_for_handle,false);assert.equal(result.valid_main_listener,true);
  const output=JSON.stringify(result);for(const secret of [f.bot.token,f.bot.hookSecret,f.listener.secret,f.listener.url,'synthetic-existing-session'])assert(!output.includes(secret));
  assert.deepEqual(await snapshot(f.db),before);
  const missing=(await f.db.query(documentedSql('inspect',{botId:'999999',handle}))).rows[0];assert.equal(missing.bot_exists,false);assert.equal(missing.bot_active,false);assert.equal(missing.token_present,false);assert.equal(Number(missing.matching_registered_agent_count),0);assert.equal(missing.valid_main_listener,false);
 }finally{await f.db.close();}
});
test('documented migration inserts only routing metadata and is idempotent',async()=>{
 const f=await fixture();try{
  const before=await snapshot(f.db);await f.db.exec(documentedSql('apply'));
  const route=await get(f.db,'group_bot',botId);assert.deepEqual(Object.keys(route).sort(),['agentId','bindingId','owner']);assert.equal(route.owner,owner);assert.equal(route.agentId,agentId);assert.match(route.bindingId,/^[a-f0-9]{32}$/);
  const after=await snapshot(f.db);assert.deepEqual(after.filter(row=>row.kind!=='group_bot'),before);
  await f.db.exec(documentedSql('apply'));assert.deepEqual(await snapshot(f.db),after);
  assert.deepEqual(await get(f.db,'bot',botId),f.bot);
  const inspection=(await f.db.query(documentedSql('inspect'))).rows[0];assert.equal(inspection.current_assigned_handle,handle);assert.equal(inspection.other_bot_for_handle,false);
 }finally{await f.db.close();}
});
test('documented migration refuses absent or ambiguous agents and never creates authentication records',async()=>{
 const f=await fixture();try{
  await f.db.query("DELETE FROM asp_records WHERE kind='agent' AND id=$1",[agentId]);await rejected(f.db,/Exactly one normally registered agent/);
  await put(f.db,'agent',agentId,f.agent);await put(f.db,'agent','duplicate-agent',{...f.agent,agentId:'duplicate-agent'});await rejected(f.db,/Exactly one normally registered agent/);
  await f.db.query("DELETE FROM asp_records WHERE kind='agent' AND id='duplicate-agent'");await put(f.db,'agent',agentId,{...f.agent,agentId:'inconsistent'});await rejected(f.db,/identity is inconsistent/);
 }finally{await f.db.close();}
});
test('documented migration requires an active token-bearing bot and canonical generic main listener',async()=>{
 const f=await fixture();try{
  for(const patch of [{active:false},{token:null},{token:''},{unbound:true}]){await put(f.db,'bot',botId,{...f.bot,...patch});await rejected(f.db,/Bot must be active/);}await put(f.db,'bot',botId,f.bot);
  for(const patch of [{name:'chat.created'},{chatId:'some-chat'},{expires:0},{owner:'foreign-owner'},{secret:''},{url:''},{agentId:'other-agent'}]){await put(f.db,'group_subscription',listenerId,{...f.listener,...patch});await rejected(f.db,/unexpired main agent.notification listener/);}
  await f.db.query("DELETE FROM asp_records WHERE kind='group_subscription' AND id=$1",[listenerId]);await put(f.db,'group_subscription','noncanonical-listener',f.listener);await rejected(f.db,/unexpired main agent.notification listener/);
 }finally{await f.db.close();}
});
test('documented migration rejects other bot ownership and cross-handle or cross-owner reassignment',async()=>{
 const f=await fixture();try{
  await put(f.db,'group_bot','654321',{owner,agentId,bindingId:'synthetic-other-generation'});await rejected(f.db,/already has another bot/);
  assert.equal((await f.db.query(documentedSql('inspect'))).rows[0].other_bot_for_handle,true);
  await f.db.query("DELETE FROM asp_records WHERE kind='group_bot' AND id='654321'");
  for(const route of [{owner,agentId:'other-agent',bindingId:'synthetic-generation'},{owner:'foreign-owner',agentId,bindingId:'synthetic-generation'}]){await put(f.db,'group_bot',botId,route);await rejected(f.db,/already assigned to another agent/);}
 }finally{await f.db.close();}
});
