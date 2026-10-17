import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerAgent,getAgent,listAgents,rotateAgentToken,resolveCallerAgent} from '../src/agents.js';
import {authenticate,authenticatePrincipal,oauth} from '../src/oauth.js';
import {hash} from '../src/security.js';
import {INSTANCE_ID} from '../src/config.js';

class MemoryStore {
 constructor(){this.data=new Map();this.locks=new Map();}
 async get(kind,id){return structuredClone(this.data.get(`${kind}:${id}`));}
 async put(kind,id,value){this.data.set(`${kind}:${id}`,structuredClone(value));}
 async insert(kind,id,value){if(this.data.has(`${kind}:${id}`))return false;this.data.set(`${kind}:${id}`,structuredClone(value));return true;}
 async take(kind,id){const value=await this.get(kind,id);this.data.delete(`${kind}:${id}`);return value;}
 async list(kind,owner){return [...this.data].filter(([key,v])=>key.startsWith(kind+':')&&v.owner===owner).map(([,v])=>structuredClone(v));}
 async pruneGroupTransport(now=Date.now()){for(const [key,value] of this.data)if((key.startsWith('group_delivery:')||key.startsWith('group_receipt:'))&&value.expires<=now)this.data.delete(key);}
 async withLock(key,fn){const prior=this.locks.get(key)??Promise.resolve();let release;const current=new Promise(resolve=>{release=resolve;});this.locks.set(key,current);await prior;const snapshot=structuredClone(this.data);try{return await fn(this);}catch(e){this.data=snapshot;throw e;}finally{release();if(this.locks.get(key)===current)this.locks.delete(key);}}
}
const apiKey='synthetic-agent-tests-only',owner=INSTANCE_ID;
function fixture(){return {store:new MemoryStore(),instanceKeyHash:hash(apiKey),origin:'https://synthetic.example',ownerActive:async id=>id===owner,authVersion:async()=>hash(apiKey)};}
const root={owner,authType:'api_key',agentId:null};
const request=(token,headers={})=>({headers:{authorization:'Bearer '+token,...headers}});
async function endpoint(app,path,method='GET',body='',headers={}){
 const result={headers:{},setHeader(k,v){this.headers[k]=v;},end(value){this.body=value;}};
 const req={url:path,method,headers};
 await oauth(app,req,path.split('?')[0],async()=>body,(status,value)=>{result.statusCode=status;result.body=value;},result);
 return result;
}
async function connect(app,handle,extraParams={}){
 const redirect='https://chatgpt.com/connector/oauth/callback';
 const registration=await endpoint(app,'/oauth/register','POST',JSON.stringify({redirect_uris:[redirect]}));
 const verifier='v'.repeat(50),client_id=registration.body.client_id,resource=app.origin+'/mcp';
 const params={client_id,redirect_uri:redirect,response_type:'code',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),resource,state:'synthetic',...extraParams};
 const page=await endpoint(app,'/oauth/authorize?'+new URLSearchParams(params));
 assert.match(page.body,/name="credential"/);
 assert.doesNotMatch(page.body,/name="agent_handle"|Agent handle \(optional\)|Choose the same handle/);
 assert.match(page.body,/After authorization, your agent registers its own/);
 const ticket=/name="ticket" value="([^"]+)"/.exec(page.body)[1];
 const approved=await endpoint(app,'/oauth/authorize','POST',new URLSearchParams({ticket,credential:apiKey,...(handle?{agent_handle:handle}:{})}).toString(),{origin:app.origin});
 const code=new URL(approved.headers.Location).searchParams.get('code');
 const tokens=await endpoint(app,'/oauth/token','POST',new URLSearchParams({client_id,redirect_uri:redirect,resource,code,code_verifier:verifier,grant_type:'authorization_code'}).toString());
 return {...tokens.body,client_id,resource};
}
async function refresh(app,tokens){const result=await endpoint(app,'/oauth/token','POST',new URLSearchParams({client_id:tokens.client_id,resource:tokens.resource,refresh_token:tokens.refresh_token,grant_type:'refresh_token'}).toString());return {...tokens,...result.body};}

test('registry normalizes handles, preserves IDs, updates explicit names, and scopes owner lookups',async()=>{
 const app=fixture();const first=await registerAgent(app,root,{handle:' Alice ',display_name:'Alice'});
 const again=await registerAgent(app,root,{handle:'alice',display_name:'Changed'});
 assert.equal(first.agent_id,again.agent_id);assert.equal(first.created_at,again.created_at);assert.equal(first.handle,'alice');assert.equal(again.display_name,'Changed');
 assert.match(first.agent_token,/^mcp_at_/);assert.match(again.agent_token,/^mcp_at_/);assert.notEqual(first.agent_token,again.agent_token);
 const third=await registerAgent(app,root,{handle:'alice'});
 assert.equal(third.display_name,'Changed');assert.notEqual(third.agent_token,again.agent_token);
 const {agent_token,...pub}=third;
 assert.equal(await getAgent(app,'other-owner',first.agent_id),null);
 assert.deepEqual(await listAgents(app,owner),[pub]);
 const stored=await app.store.get('agent',first.agent_id);
 assert.equal(stored.tokenHash,hash(third.agent_token));
 assert(!JSON.stringify(stored).includes(third.agent_token));
 assert(!JSON.stringify(stored).includes(first.agent_token));
 assert.equal((await getAgent(app,owner,first.agent_id)).agent_token,undefined);
 for(const handle of ['', 'a','not valid','<script>','x'.repeat(65)])await assert.rejects(registerAgent(app,root,{handle}));
 await assert.rejects(registerAgent(app,root,{handle:'valid',display_name:''}));
 assert.equal((await listAgents(app,owner)).length,1);
});
test('agent_token_rotate mints a new token and invalidates the previous hash',async()=>{
 const app=fixture();const registered=await registerAgent(app,root,{handle:'alice'});
 const principal={...root,agentId:registered.agent_id};
 const rotated=await rotateAgentToken(app,principal);
 assert.match(rotated.agent_token,/^mcp_at_/);assert.notEqual(rotated.agent_token,registered.agent_token);
 assert.equal(rotated.agent_id,registered.agent_id);assert.equal(rotated.handle,'alice');assert.equal(rotated.agent_token.length<=128,true);
 const stored=await app.store.get('agent',registered.agent_id);
 assert.equal(stored.tokenHash,hash(rotated.agent_token));
 assert.notEqual(stored.tokenHash,hash(registered.agent_token));
 await assert.rejects(resolveCallerAgent(app,root,{agent_token:registered.agent_token}),/unknown or revoked agent token/i);
 const resolved=await resolveCallerAgent(app,root,{agent_token:rotated.agent_token});
 assert.equal(resolved.agent_id,registered.agent_id);assert.equal(resolved.agent_token,undefined);
});
test('direct key selector requires registered identity and authenticate keeps owner return',async()=>{
 const app=fixture(),alice=await registerAgent(app,root,{handle:'alice'});
 assert.deepEqual(await authenticatePrincipal(app,request(apiKey)),root);
 assert.equal((await authenticatePrincipal(app,request(apiKey,{'x-mcp-agent-id':alice.agent_id}))).agentId,alice.agent_id);
 assert.equal(await authenticate(app,request(apiKey)),owner);
 await assert.rejects(authenticatePrincipal(app,request(apiKey,{'x-mcp-agent-id':'missing'})),/Unknown agent/);
 await assert.rejects(authenticatePrincipal(app,request(apiKey,{'x-mcp-agent-id':[alice.agent_id]})),/Unknown agent/);
 await assert.rejects(authenticatePrincipal(app,request('invalid')),/Authentication required/);
});
test('identical OAuth client IDs get distinct logical identities and stable refresh lineage',async()=>{
 const app=fixture(),a=await connect(app,'alice'),b=await connect(app,'bob');
 assert.equal(a.client_id,b.client_id);
 const pa=await authenticatePrincipal(app,request(a.access_token)),pb=await authenticatePrincipal(app,request(b.access_token));
 assert.notEqual(pa.agentId,pb.agentId);assert.notEqual(pa.sessionId,pb.sessionId);
 const renewed=await refresh(app,a);
 assert.deepEqual(await authenticatePrincipal(app,request(renewed.access_token)),pa);
 // Request headers cannot impersonate another agent through an OAuth grant.
 assert.deepEqual(await authenticatePrincipal(app,request(a.access_token,{'x-mcp-agent-id':pb.agentId})),pa);
 const reconnected=await connect(app,'ALICE');
 assert.equal((await authenticatePrincipal(app,request(reconnected.access_token))).agentId,pa.agentId);
 await assert.rejects(refresh(app,a),/Invalid refresh token/);
});
test('MCP-style registration binds an initially unnamed grant including existing refresh tokens',async()=>{
 const app=fixture(),tokens=await connect(app),before=await authenticatePrincipal(app,request(tokens.access_token));
 assert.equal(before.agentId,null);assert.ok(before.sessionId);
 const registered=await registerAgent(app,before,{handle:'mcp-agent'});
 assert.equal((await authenticatePrincipal(app,request(tokens.access_token))).agentId,registered.agent_id);
 const renewed=await refresh(app,tokens);
 assert.equal((await authenticatePrincipal(app,request(renewed.access_token))).agentId,registered.agent_id);
 await assert.rejects(registerAgent(app,before,{handle:'another-agent'}),/different agent identity/);
 assert.equal((await listAgents(app,owner)).length,1);
});
test('concurrent registration cannot switch a session or leave a losing identity',async()=>{
 const app=fixture(),principal={owner,authType:'oauth',sessionId:'synthetic-session',agentId:null};
 const outcomes=await Promise.allSettled([registerAgent(app,principal,{handle:'alice'}),registerAgent(app,principal,{handle:'bob'})]);
 assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);
 assert.equal((await listAgents(app,owner)).length,1);
});
test('legacy OAuth remains valid for owner APIs but cannot guess logical identity',async()=>{
 const app=fixture();const record={owner,resource:app.origin+'/mcp',client_id:'legacy-client',expires:Date.now()+60000};
 await app.store.put('access',hash('legacy-access'),record);
 await app.store.put('refresh',hash('legacy-refresh'),record);
 const principal=await authenticatePrincipal(app,request('legacy-access'));
 assert.deepEqual(principal,{owner,authType:'oauth',agentId:null});
 assert.equal(await authenticate(app,request('legacy-access')),owner);
 await assert.rejects(registerAgent(app,principal,{handle:'legacy'}),/Reconnect OAuth/);
 const renewed=await refresh(app,{client_id:record.client_id,resource:record.resource,refresh_token:'legacy-refresh'});
 assert.deepEqual(await authenticatePrincipal(app,request(renewed.access_token)),principal);
});
test('agent identity does not bypass existing expiry, resource, rotation or owner checks',async()=>{
 for(const change of [{expires:0},{resource:'https://wrong.example/mcp'},{authVersion:'old-version'},{owner:'retired-owner'}]){
  const app=fixture(),tokens=await connect(app,'alice'),record=await app.store.get('access',hash(tokens.access_token));
  await app.store.put('access',hash(tokens.access_token),{...record,...change});
  await assert.rejects(authenticatePrincipal(app,request(tokens.access_token)));
 }
});

test('authorization query cannot inject logical identity into unnamed consent',async()=>{
 const app=fixture(),alice=await registerAgent(app,root,{handle:'alice'});
 const tokens=await connect(app,undefined,{agentId:alice.agent_id,sessionId:'injected'});
 const principal=await authenticatePrincipal(app,request(tokens.access_token));
 assert.equal(principal.agentId,null);assert.notEqual(principal.sessionId,'injected');
});

test('actual Postgres SQL: registry registration and session binding commit atomically',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const {Store}=await import('../src/store.js');
 const db=new PGlite();let tail=Promise.resolve();
 const acquire=async()=>{let release;const next=new Promise(resolve=>{release=resolve;});const prior=tail;tail=next;await prior;return release;};
 const query=async(sql,args)=>{const result=await db.query(sql,args);return {rows:result.rows,rowCount:result.affectedRows??result.rows.length};};
 const store=Object.create(Store.prototype);store.pool={query:async(sql,args)=>{const release=await acquire();try{return await query(sql,args);}finally{release();}},connect:async()=>({query,release:await acquire()})};
 try{
  await store.initialize();const app={...fixture(),store};const principal={owner,authType:'oauth',sessionId:'database-session',agentId:null};
  const result=await registerAgent(app,principal,{handle:'database-agent'});
  assert.equal((await store.get('agent_session',principal.sessionId)).agentId,result.agent_id);
  const results=await Promise.allSettled([registerAgent(app,principal,{handle:'other-agent'}),registerAgent(app,principal,{handle:'database-agent'})]);
  assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');assert.equal((await listAgents(app,owner)).length,1);
 }finally{await db.close();}
});

test('whoami exposes peers or unregistered, never legacy storage owner or admin role',async()=>{
 const {App,tools}=await import('../src/app.js');const f=fixture();const app=new App({store:f.store,instanceKey:apiKey,origin:f.origin});
 assert.deepEqual(await app.invoke(owner,'agent_whoami',{},root),{registered:false,agent_id:null,server_version:'0.6.21',tool_profile:'bootstrap',available_tool_names:tools.map(t=>t.name)});
 const agent=await registerAgent(app,root,{handle:'peer',display_name:'Before'});
 const principal={...root,agentId:agent.agent_id};const before=await app.invoke(owner,'agent_whoami',{},principal);
 assert.equal(before.registered,true);assert.equal(before.agent_id,agent.agent_id);assert(!('role' in before));assert(!('instance_id' in before));assert(!JSON.stringify(before).includes('mcp:admin'));
 assert.equal(before.agent_token,undefined);assert.equal(before.tokenHash,undefined);assert(!JSON.stringify(before).includes(agent.agent_token));
 await f.store.put('bot','old-bot',{owner,active:true});await f.store.put('chat','existing',{owner,agent_ids:[agent.agent_id]});
 await registerAgent(app,principal,{handle:'peer',display_name:'After'});const after=await app.invoke(owner,'agent_whoami',{},principal);
 assert.equal(after.display_name,'After');assert.equal(after.agent_id,before.agent_id);assert.equal(after.created_at,before.created_at);
 assert.equal((await app.own(owner,'old-bot')).owner,owner);assert.deepEqual((await f.store.get('chat','existing')).agent_ids,[agent.agent_id]);
 await assert.rejects(registerAgent(app,principal,{handle:'another'}),/different agent identity/);
});


test('handle-free OAuth bootstraps through MCP registration, main listener and stable reconnection',async()=>{
 const {App}=await import('../src/app.js');const f=fixture();
 const app=new App({store:f.store,instanceKey:apiKey,origin:f.origin,key:Buffer.alloc(32,7).toString('base64'),post:async(url,headers,body)=>({status:200,body:JSON.stringify({challenge:JSON.parse(body).challenge})})});
 const tokens=await connect(app),before=await authenticatePrincipal(app,request(tokens.access_token));
 assert.equal(before.agentId,null);assert.equal((await listAgents(app,owner)).length,0);
 const registered=await app.invoke(owner,'agent_register',{handle:'self-agent',display_name:'Self Agent'},before);
 let principal=await authenticatePrincipal(app,request(tokens.access_token));
 assert.equal((await app.invoke(owner,'agent_whoami',{},principal)).display_name,'Self Agent');
 const subscription={name:'agent.notification',arguments:{},delivery:{mode:'webhook',url:'https://synthetic.example/callback',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}};
 const first=await app.rpc(owner,'events/subscribe',subscription,principal);
 assert.equal((await f.store.get('group_subscription',first.id)).agentId,registered.agent_id);
 const renewed=await refresh(app,tokens);principal=await authenticatePrincipal(app,request(renewed.access_token));
 assert.equal(principal.agentId,registered.agent_id);
 assert.equal((await app.rpc(owner,'events/subscribe',subscription,principal)).id,first.id);
 const reconnected=await connect(app),newPrincipal=await authenticatePrincipal(app,request(reconnected.access_token));
 assert.equal(newPrincipal.agentId,null);assert.notEqual(newPrincipal.sessionId,principal.sessionId);
 const reused=await app.invoke(owner,'agent_register',{handle:'self-agent'},newPrincipal);
 assert.equal(reused.agent_id,registered.agent_id);assert.equal(reused.display_name,'Self Agent');
 assert.equal((await listAgents(app,owner)).length,1);
 assert.equal((await f.store.list('group_subscription',owner)).length,1);
 await assert.rejects(app.invoke(owner,'agent_register',{handle:'different-agent'},newPrincipal),/different agent identity/);
});

