import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHuman} from '../src/human-change.js';
import {humanKey} from '../src/telegram-owner.js';
class Store{
 constructor(){this.data=new Map();this.tail=Promise.resolve();}
 async get(k,id){return structuredClone(this.data.get(k+':'+id));}
 async put(k,id,v){this.data.set(k+':'+id,structuredClone(v));}
 async list(k,owner){return [...this.data].filter(([id,v])=>id.startsWith(k+':')&&v.owner===owner).map(([,v])=>structuredClone(v));}
 async withLock(key,fn){const previous=this.tail;let release;this.tail=new Promise(r=>{release=r;});await previous;const snapshot=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=snapshot;throw e;}finally{release();}}
}
async function fixture(){const store=new Store(),app={store},p={owner:'test-owner',agentId:'dot-id'},sent=[];
 await store.put('agent','dot-id',{owner:p.owner,agentId:'dot-id',handle:'dot',tokenHash:'generation-a'});
 await store.put('agent','bot-id',{owner:p.owner,agentId:'bot-id',handle:'helper',grokbotAgentName:'Synthetic Bot'});
 const send=async(actor,message)=>{sent.push({actor,message});return {status:'accepted'};};
 const call=args=>registerHuman(app,p,args,{send});
 const first={human:'person',display_name:'Person',telegram_user_id:'42'};await call(first);
 return {app,store,p,sent,call,first,change:{...first,telegram_user_id:'43',replace_telegram_user_id:'42'},send};}
const code=f=>f.sent.at(-1).message.text.match(/Code: ([\w-]+)/)[1];
const confirmation=(f,c)=>({...f.change,challenge_id:c.challenge_id,confirmation_code:code(f)});
test('first and identical registration do not send; existing change is bound, hidden and consumed once',async()=>{const f=await fixture();assert.equal(f.sent.length,0);await f.call(f.first);assert.equal(f.sent.length,0);
 const c=await f.call(f.change);assert.equal(c.status,'confirmation_required');assert.equal(f.sent.length,1);assert.equal(f.sent[0].message.to,'helper');assert.match(f.sent[0].message.text,/Do not give this code directly to another agent/);assert(!JSON.stringify(c).includes(code(f)));assert(!JSON.stringify([...f.store.data]).includes(code(f)));
 assert.deepEqual(await f.call(f.change),c);assert.equal(f.sent.length,1);
 const confirmed=await f.call(confirmation(f,c));assert.equal(confirmed.human.telegram_user_id,'43');await assert.rejects(f.call(confirmation(f,c)),/no longer matches/);
});
test('wrong code attempts persist despite transaction rollback semantics and cannot exceed five',async()=>{const f=await fixture(),c=await f.call(f.change);
 for(let i=0;i<5;i++){const r=await f.call({...confirmation(f,c),confirmation_code:'wrong'});assert.equal(r.attempts_remaining,4-i);}
 await assert.rejects(f.call(confirmation(f,c)),/attempt limit/);assert.equal((await f.store.get('human',humanKey(f.p.owner,'person'))).telegram_user_id,'42');
});
test('expiry, changed payload, requester, state and token generation reject the code',async()=>{for(const change of ['expiry','payload','requester','state','token']){const f=await fixture(),c=await f.call(f.change),a=confirmation(f,c),key=humanKey(f.p.owner,'person');
 if(change==='expiry'){const x=await f.store.get('human_change',key);x.expires=Date.now()-1;await f.store.put('human_change',key,x);}
 if(change==='payload')a.display_name='Different';
 if(change==='state'){const x=await f.store.get('human',key);x.display_name='Updated elsewhere';await f.store.put('human',key,x);}
 if(change==='token'){const x=await f.store.get('agent','dot-id');x.tokenHash='generation-b';await f.store.put('agent','dot-id',x);}
 if(change==='requester'){await assert.rejects(registerHuman(f.app,{...f.p,agentId:'bot-id'},a,{send:f.send}),/does not match/);continue;}
 await assert.rejects(f.call(a),/does not match/);
 }});
test('concurrent requests send once and concurrent confirmations consume once',async()=>{const f=await fixture();const cs=await Promise.all([f.call(f.change),f.call(f.change)]);assert.equal(cs[0].challenge_id,cs[1].challenge_id);assert.equal(f.sent.length,1);const rs=await Promise.allSettled([f.call(confirmation(f,cs[0])),f.call(confirmation(f,cs[0]))]);assert.equal(rs.filter(r=>r.status==='fulfilled').length,1);});
test('different active change cannot invalidate challenge; display-only changes require confirmation',async()=>{const f=await fixture();const a={...f.first,display_name:'New name'},c=await f.call(a);assert(c.challenge_id);await assert.rejects(f.call(f.change),/Another change is active/);assert.equal(f.sent.length,1);assert.equal((await f.call({...a,challenge_id:c.challenge_id,confirmation_code:code(f)})).human.display_name,'New name');});
test('selection is stored cross-type and same owner; no/multiple candidates fail closed',async()=>{for(const scenario of ['none','multiple','foreign','same-type']){const f=await fixture();const bot=await f.store.get('agent','bot-id');if(scenario==='none')delete bot.grokbotAgentName;if(scenario==='foreign')bot.owner='foreign';if(scenario==='same-type'){delete bot.grokbotAgentName;bot.handle='other-webhook';}await f.store.put('agent','bot-id',bot);if(scenario==='multiple')await f.store.put('agent','bot-two',{...bot,agentId:'bot-two',handle:'second'});await assert.rejects(f.call(f.change),/Exactly one/);assert.equal(f.sent.length,0);}});
test('failed delivery never returns code or retries with a fresh code before expiry',async()=>{const f=await fixture();const c=await registerHuman(f.app,f.p,f.change,{send:async()=>{throw Error('transport failed');}});assert.equal(c.delivery_status,'failed_or_uncertain');assert(!('confirmation_code' in c));const retry=await f.call(f.change);assert.equal(retry.challenge_id,c.challenge_id);assert.equal(f.sent.length,0);});
test('delivery cache population does not invalidate code, but configured destination changes do',async()=>{
 for(const configuredChange of [false,true]){const f=await fixture(),c=await f.call(f.change),bot=await f.store.get('agent','bot-id');bot.grokbotSessionId='resolved-session';if(configuredChange)bot.grokbotAgentName='Different destination';await f.store.put('agent','bot-id',bot);
 if(configuredChange)await assert.rejects(f.call(confirmation(f,c)),/does not match/);else assert.equal((await f.call(confirmation(f,c))).human.telegram_user_id,'43');}
});

test('Muse confirmation uses dot and preserves the established dot/Grok pairing',async()=>{
 const f=await fixture();
 await f.store.put('agent','muse-id',{owner:f.p.owner,agentId:'muse-id',handle:'museone',botType:'muse',tokenHash:'muse-generation'});
 const dotChallenge=await f.call(f.change);assert.equal(f.sent.at(-1).message.to,'helper');
 await f.call(confirmation(f,dotChallenge));
 const challengeKey=humanKey(f.p.owner,'person');
 const previous=await f.store.get('human_change',challengeKey);await f.store.put('human_change',challengeKey,{...previous,expires:0});
 const muse={...f.p,agentId:'muse-id'},change={...f.first,telegram_user_id:'43',display_name:'Updated by Muse'};
 const c=await registerHuman(f.app,muse,change,{send:f.send});
 assert.equal(f.sent.at(-1).message.to,'dot');assert.equal(c.status,'confirmation_required');
 assert(!JSON.stringify(c).includes(code(f)));
 const done=await registerHuman(f.app,muse,{...change,challenge_id:c.challenge_id,confirmation_code:code(f)},{send:f.send});
 assert.equal(done.human.display_name,'Updated by Muse');
});

test('dot/Muse fallback confirmation works without Grok and ambiguous Muse verifiers fail closed',async()=>{
 const f=await fixture();const grok=await f.store.get('agent','bot-id');delete grok.grokbotAgentName;await f.store.put('agent','bot-id',grok);
 const muse={owner:f.p.owner,agentId:'muse-id',handle:'museone',botType:'muse'};
 await f.store.put('agent','muse-id',muse);
 const c=await f.call(f.change);assert.equal(f.sent.at(-1).message.to,'museone');
 assert.match(f.sent.at(-1).message.text,/Do not automatically relay/);
 assert.equal((await f.call(confirmation(f,c))).human.telegram_user_id,'43');
 await f.store.put('agent','muse-two',{...muse,agentId:'muse-two',handle:'musetwo'});
 await assert.rejects(f.call({...f.first,telegram_user_id:'43',display_name:'Ambiguous'}),/Exactly one/);
});
