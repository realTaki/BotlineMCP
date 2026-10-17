import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {Store} from '../src/store.js';
test('actual Postgres SQL: persistence, JSONB updates, dedup, filtering and leases',async()=>{
 const {db,store}=await transactionalStore();await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
 try{
 assert.equal(await store.insert('bot','123',{owner:'one',active:false}),true);
 assert.equal(await store.insert('bot','123',{owner:'two'}),false);
 await store.put('bot','123',{owner:'one',active:true});assert.equal((await store.get('bot','123')).active,true);
 assert.equal((await store.list('bot','one')).length,1);assert.equal((await store.list('bot','two')).length,0);
 await store.put('delivery','a',{owner:'one',state:'pending',leaseUntil:0});
 assert(await store.lease('delivery','a'));assert.equal(await store.lease('delivery','a'),undefined);
 await store.put('delivery','b',{owner:'one',state:'accepted'});assert.equal((await store.list('delivery','one')).length,1);
 await store.put('settings_session','s',{owner:'one',expires:Date.now()+1000});assert(await store.take('settings_session','s'));assert.equal(await store.take('settings_session','s'),undefined);
 await store.put('bot','access',{id:'access',owner:'one',token:'encrypted',hookSecret:'unchanged',active:true});
 await store.put('bot','access',{id:'access',owner:'one',token:'replacement-encrypted',hookSecret:'unchanged',active:true});
 assert.equal((await store.get('bot','access')).token,'replacement-encrypted');
 await store.delete('bot','123');assert.equal(await store.get('bot','123'),undefined);
 }finally{await db.close();}
});

// PGlite has one SQL connection. Serialize pool checkout to exercise complete
// transactions rather than accidentally interleaving BEGIN/COMMIT on that connection.
async function transactionalStore(){
 const db=new PGlite();let tail=Promise.resolve();
 const acquire=async()=>{let release;const next=new Promise(r=>release=r),previous=tail;tail=next;await previous;return release;};
 const query=async(sql,args)=>{const r=await db.query(sql,args);return{rows:r.rows,rowCount:r.affectedRows??r.rows.length};};
 const store=Object.create(Store.prototype);store.pool={
  query:async(sql,args)=>{const release=await acquire();try{return await query(sql,args);}finally{release();}},
  connect:async()=>{const release=await acquire();return{query,release};}
 };
 await store.initialize();return{db,store};
}
test('actual Postgres SQL: denied reply reservation atomically deduplicates, limits and prunes',async()=>{
 const {DENIED_REPLY_POLICY}=await import('../src/denied-replies.js');
 const {db,store}=await transactionalStore(),now=1791582000000;
 const bot={id:'123',owner:'one',active:true};
 try{
  await store.put('bot','123',bot);
  await store.put('human','person',{owner:'one',handle:'person',telegram_user_id:'42'});
  assert.equal(await store.reserveDeniedReply('123',1,'42','42',now),false);assert.equal(await store.get('update','123:1'),undefined);
  const concurrent=await Promise.all(Array.from({length:20},()=>store.reserveDeniedReply('123',2,'43','42',now)));
  assert.equal(concurrent.filter(Boolean).length,1);
  const receipt=await store.get('update','123:2');assert.equal(receipt.denied,true);assert.equal(receipt.state,'intent');assert.equal(receipt.expires,now+DENIED_REPLY_POLICY.receiptTtl);
  for(const key of ['text','event','senderId','sender_id','chatId','chat_id'])assert.equal(receipt[key],undefined);
  let limiter=await store.get('denied_limit','123');assert.equal(Object.keys(limiter.peers).length,1);assert.equal(Object.keys(limiter.chats).length,1);assert(!Object.keys(limiter.peers).includes('43'));
  assert.equal(await store.reserveDeniedReply('123',3,'43','42',now+DENIED_REPLY_POLICY.chatCooldown),false); // same sender/chat still limited
  assert.equal((await store.get('update','123:3')).state,'suppressed');
  assert.equal(await store.reserveDeniedReply('123',4,'44','42',now+DENIED_REPLY_POLICY.chatCooldown-1),false); // group/chat-level cooldown
  assert.equal(await store.reserveDeniedReply('123',5,'44','42',now+DENIED_REPLY_POLICY.chatCooldown),true);
  assert.equal(await store.reserveDeniedReply('123',6,'43','42',now+DENIED_REPLY_POLICY.peerCooldown),true);
  // Receipt dedup survives limiter expiry and a new Store instance.
  const restarted=Object.create(Store.prototype);restarted.pool=store.pool;
  assert.equal(await restarted.reserveDeniedReply('123',2,'43','42',now+DENIED_REPLY_POLICY.peerCooldown+1),false);
  await store.put('bot','inactive',{...bot,id:'inactive',active:false});
  assert.equal(await store.reserveDeniedReply('inactive',1,'43','42',now),false);assert.equal(await store.reserveDeniedReply('missing',1,'43','42',now),false);
  assert.equal(await store.get('update','inactive:1'),undefined);
  await store.put('update','allowed-old',{owner:'one',completed:true,created:0,event:{eventId:'allowed'}});
  await store.put('send','unrelated-old',{owner:'one',state:'uncertain',created:0});
  await store.put('denied_limit','inactive',{expires:now,peers:{},chats:{}});
  await store.pruneDeniedReplies(now+DENIED_REPLY_POLICY.receiptTtl);
  assert.equal(await store.get('update','123:2'),undefined);assert.equal(await store.get('denied_limit','123'),undefined);assert.equal(await store.get('denied_limit','inactive'),undefined);
  assert(await store.get('update','123:5')); // received later, not expired yet
  assert(await store.get('update','allowed-old'));assert(await store.get('send','unrelated-old'));
 }finally{await db.close();}
});
test('actual Postgres SQL: per-bot denial budget and bounded limiter fail closed',async()=>{
 const {DENIED_REPLY_POLICY,nextDeniedReplyState}=await import('../src/denied-replies.js');
 const {db,store}=await transactionalStore(),now=1791582000000;
 try{
  await store.put('bot','123',{id:'123',owner:'one',active:true});
  const results=await Promise.all(Array.from({length:40},(_,i)=>store.reserveDeniedReply('123',i+1,String(i+100),String(-1000-i),now)));
  assert.equal(results.filter(Boolean).length,DENIED_REPLY_POLICY.botMax);
  const state=await store.get('denied_limit','123');assert.equal(Object.keys(state.peers).length,DENIED_REPLY_POLICY.botMax);
  assert.equal(await store.reserveDeniedReply('123',41,'999','-9999',now+DENIED_REPLY_POLICY.botWindow),true);
  const capped={peers:Object.fromEntries(Array.from({length:DENIED_REPLY_POLICY.maxPeers},(_,i)=>['peer'+i,now])),chats:{},window:now,count:0,expires:now+DENIED_REPLY_POLICY.peerCooldown};
  await store.put('denied_limit','123',capped);assert.equal(await store.reserveDeniedReply('123',42,'998','-9998',now+1),false);
  assert.equal(Object.keys((await store.get('denied_limit','123')).peers).length,DENIED_REPLY_POLICY.maxPeers);
  assert(nextDeniedReplyState(capped,'998','-9998',now+DENIED_REPLY_POLICY.peerCooldown));
  const chatCapped={...capped,peers:{},chats:Object.fromEntries(Array.from({length:DENIED_REPLY_POLICY.maxChats},(_,i)=>['chat'+i,now]))};
  assert.equal(nextDeniedReplyState(chatCapped,'998','-9998',now+1),null);
 }finally{await db.close();}
});
test('actual Postgres SQL: denied reservation rollback cannot leave partial receipt or limiter',async()=>{
 const {db,store}=await transactionalStore();
 try{
  await store.put('bot','123',{id:'123',owner:'one',active:true});
  const connect=store.pool.connect;store.pool.connect=async()=>{const c=await connect();return{...c,query:async(sql,args)=>{if(sql.startsWith('UPDATE mcp_records SET value=$2'))throw Error('synthetic intent write failure');return c.query(sql,args);}};};
  await assert.rejects(store.reserveDeniedReply('123',1,'43','42'),/synthetic intent write failure/);
  assert.equal(await store.get('update','123:1'),undefined);assert.equal(await store.get('denied_limit','123'),undefined);
  store.pool.connect=connect;assert.equal(await store.reserveDeniedReply('123',1,'43','42'),true);
 }finally{await db.close();}
});


