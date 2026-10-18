import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import {App,handler} from '../src/app.js';
import {hash} from '../src/security.js';

const origin='https://mcp.example.com';
const apiKey='synthetic-settings-api-key-'.padEnd(48,'x');
const token='123:'+'synthetic_bot_token_'.repeat(2);
const agentHandle='settings-agent';
const agentId='agent_'+hash(JSON.stringify(['mcp:admin',agentHandle]));
const cookieName='__Host-mcp-settings';
const formHeaders={'content-type':'application/x-www-form-urlencoded',origin};
class MemoryStore {
  constructor(){this.data=new Map();this.locks=new Map();}
  async withLock(key,fn){const prior=this.locks.get(key)??Promise.resolve();let release;const current=new Promise(resolve=>{release=resolve;});this.locks.set(key,current);await prior;const snapshot=structuredClone(this.data);try{return await fn(this);}catch(error){this.data=snapshot;throw error;}finally{release();if(this.locks.get(key)===current)this.locks.delete(key);}}
  async withBotLock(key,fn){const prior=this.locks.get(key)??Promise.resolve();let release;const current=new Promise(resolve=>{release=resolve;});this.locks.set(key,current);await prior;try{return await fn(this);}finally{release();if(this.locks.get(key)===current)this.locks.delete(key);}}
  async pruneGroupTransport(now=Date.now()){for(const [key,value] of this.data)if((key.startsWith('group_delivery:')||key.startsWith('group_receipt:'))&&value.expires<=now)this.data.delete(key);}
  async get(k,id){return structuredClone(this.data.get(`${k}:${id}`));}
  async put(k,id,v){this.data.set(`${k}:${id}`,structuredClone(v));}
  async insert(k,id,v){const name=`${k}:${id}`;if(this.data.has(name))return false;this.data.set(name,structuredClone(v));return true;}
  async delete(k,id){this.data.delete(`${k}:${id}`);}
  async take(k,id){const name=`${k}:${id}`,value=this.data.get(name);this.data.delete(name);return structuredClone(value);}
  async list(k,owner){return [...this.data].filter(([id,v])=>id.startsWith(`${k}:`)&&(!owner||v.owner===owner)).map(([id,v])=>({...structuredClone(v),id:id.slice(k.length+1)}));}
}
function fixture(){
  const store=new MemoryStore(),calls=[];
  store.data.set('agent:'+agentId,{owner:'mcp:admin',agentId,handle:agentHandle,displayName:'Settings Agent',created:new Date().toISOString()});
  const app=new App({store,key:Buffer.alloc(32,7).toString('base64'),instanceKey:apiKey,origin,telegram:async(t,method,args)=>{calls.push({method,args});if(method==='getMe')return{id:123,is_bot:true,username:'synthetic_bot'};if(method==='getWebhookInfo')return{url:''};return true;}});
  return{store,app,calls};
}
async function request(app,path,method='GET',body='',headers={},extra={}){
  const req=Readable.from(body?[body]:[]);Object.assign(req,{url:path,method,headers,...extra});
  const result={headers:{},body:''};
  const res={statusCode:200,setHeader(k,v){result.headers[k.toLowerCase()]=v;},end(value=''){result.body=String(value);}};
  await handler(app)(req,res);return{...result,status:res.statusCode};
}
async function login(f,cookie){
  const result=await request(f.app,'/settings/login','POST',new URLSearchParams({api_key:apiKey}).toString(),{...formHeaders,...(cookie?{cookie}:{})});
  assert.equal(result.status,303);assert.equal(result.headers.location,'/settings/bot');
  const freshCookie=result.headers['set-cookie'].split(';')[0],sessionToken=freshCookie.split('=')[1];
  const page=await request(f.app,'/settings/bot','GET','',{cookie:freshCookie});assert.equal(page.status,200);
  const csrf=page.body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)?.[1];assert(csrf);
  return{cookie:freshCookie,token:sessionToken,csrf,result,page};
}
async function submit(f,session,headers={},fields={}){
  return request(f.app,'/settings/bind','POST',new URLSearchParams({csrf:session.csrf,token,agent_handle:agentHandle,...fields}).toString(),{...formHeaders,cookie:session.cookie,...headers});
}
function assertNoSecrets(value,...secrets){for(const secret of secrets)assert(!JSON.stringify(value).includes(secret));}

test('Settings initially shows only API KEY and protected bot form requires authentication',async()=>{
  const f=fixture(),page=await request(f.app,'/settings');assert.equal(page.status,200);assert.match(page.body,/API KEY/);assert.match(page.body,/MCP_API_KEY/);assert(!page.body.includes('name="token"'));assert(!page.body.includes('Telegram Bot Token'));assert(!page.body.includes('name="agent_handle"'));
  assert.equal((await request(f.app,'/settings/bot')).status,401);
  assert.equal((await request(f.app,'/settings/bind','POST',new URLSearchParams({csrf:'wrong',token}).toString(),formHeaders)).status,401);
  assert.equal(f.calls.length,0);
  assert.equal((await request(f.app,'/settings?api_key='+encodeURIComponent(apiKey))).status,400);
});

test('Settings login rejects incorrect API keys and OAuth/agent credentials',async()=>{
  const f=fixture();await f.store.put('agent_auth',hash('agent-token'.padEnd(48,'x')),{owner:'retired-agent'});
  const oauthToken='oauth-token'.padEnd(48,'x');await f.store.put('access',hash(oauthToken),{owner:'mcp:admin',resource:origin+'/mcp',expires:Date.now()+60000});
  for(const credential of ['wrong-key'.padEnd(48,'x'),'agent-token'.padEnd(48,'x'),oauthToken]){
    const result=await request(f.app,'/settings/login','POST',new URLSearchParams({api_key:credential}).toString(),formHeaders);
    assert.equal(result.status,401);assertNoSecrets(result,credential);assert(!result.body.includes('name="token"'));
  }
  assert.equal((await f.store.list('settings_session')).length,0);
});

test('Successful login stores only hashed session token and restricts the cookie and page',async()=>{
  const f=fixture(),s=await login(f);
  assert.match(s.result.headers['set-cookie'],new RegExp(`^${cookieName}=[A-Za-z0-9_-]{43}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600$`));
  assert(!s.result.headers['set-cookie'].includes('Domain='));
  assertNoSecrets(s.result,apiKey,token);assertNoSecrets(await f.store.list('settings_session'),apiKey,token,s.token);
  assert((await f.store.get('settings_session',hash(s.token))).expires<=Date.now()+600000);
  for(const page of [await request(f.app,'/settings'),s.result,s.page]){
    assert.equal(page.headers['cache-control'],'no-store');assert.equal(page.headers['referrer-policy'],'strict-origin');
    assert.match(page.headers['content-security-policy'],/script-src 'none'/);assert.match(page.headers['content-security-policy'],/form-action 'self';/);assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
    assert(!page.body.includes('<script'));assert(!page.body.includes('localStorage'));assert(!page.body.includes('https://chatgpt.com'));
  }
  assert.match(s.page.body,/name="agent_handle"/);assert.match(s.page.body,/Each agent handle can bind at most one bot/);assert.match(s.page.body,/Groups and supergroups are ignored/);assert.match(s.page.body,/Telegram Bot Token/);assert.match(s.page.body,/type="password" name="token"/);assert.match(s.page.body,/encrypted working copy/);
  assert.match(s.page.body,/Registered humans can DM every bound bot/);assert(!s.page.body.includes('telegram_whitelist_update'));assert(!s.page.body.includes('empty allowlist'));
  assert.equal((await request(f.app,'/settings','GET','',{cookie:s.cookie})).status,200);
});

test('Every Settings POST rejects missing, null and foreign Origin without consuming a session',async()=>{
  const f=fixture(),s=await login(f);
  for(const badOrigin of [undefined,'null','https://foreign.example','https://mcp.example.com.attacker.test',origin+'/']){
    const loginHeaders={...formHeaders,origin:badOrigin};if(badOrigin===undefined)delete loginHeaders.origin;
    assert.equal((await request(f.app,'/settings/login','POST',new URLSearchParams({api_key:apiKey}).toString(),loginHeaders)).status,403);
    assert.equal((await submit(f,s,{origin:badOrigin})).status,403);
    assert(await f.store.get('settings_session',hash(s.token)));
  }
  assert.equal(f.calls.length,0);
});

test('CSRF mismatch and malformed bind fields cannot consume the authenticated session',async()=>{
  const f=fixture(),s=await login(f);
  assert.equal((await submit(f,s,{}, {csrf:'wrong'})).status,403);
  for(const body of [new URLSearchParams({token}).toString(),new URLSearchParams({csrf:s.csrf,token,agent_handle:agentHandle,extra:'x'}).toString(),`csrf=${s.csrf}&csrf=${s.csrf}&token=${encodeURIComponent(token)}&agent_handle=${agentHandle}`,new URLSearchParams({csrf:s.csrf,token:'invalid-token',agent_handle:agentHandle}).toString()]){
    assert.equal((await request(f.app,'/settings/bind','POST',body,{...formHeaders,cookie:s.cookie})).status,400);
    assert(await f.store.get('settings_session',hash(s.token)));
  }
  assert.equal(f.calls.length,0);
});

test('Strict forms reject duplicates, extra fields, JSON, malformed cookies and duplicate security headers',async()=>{
  const f=fixture();
  for(const body of [`api_key=${apiKey}&api_key=${apiKey}`,`api_key=${apiKey}&extra=x`,''])assert.equal((await request(f.app,'/settings/login','POST',body,formHeaders)).status,400);
  for(const type of ['application/json','text/plain','multipart/form-data','application/x-www-form-urlencoded; charset=iso-8859-1'])assert.equal((await request(f.app,'/settings/login','POST',`api_key=${apiKey}`,{...formHeaders,'content-type':type})).status,415);
  assert.equal((await request(f.app,'/settings/login','POST','api_key='+'x'.repeat(8192),formHeaders)).status,413);
  assert.equal((await request(f.app,'/settings/login','POST',`api_key=${apiKey}`,{...formHeaders,'content-length':'8193'})).status,413);
  for(const body of [{api_key:[apiKey,apiKey]},{api_key:apiKey,extra:'x'},{api_key:32},[apiKey]])assert.equal((await request(f.app,'/settings/login','POST','',formHeaders,{body})).status,400);
  const parsed=await request(f.app,'/settings/login','POST','',formHeaders,{body:{api_key:apiKey}});assert.equal(parsed.status,303);
  const s=await login(f);
  for(const cookie of [`${s.cookie}; ${s.cookie}`,`${cookieName}=bad`,`${s.cookie}; invalid`,[s.cookie,s.cookie]])assert.equal((await request(f.app,'/settings/bot','GET','',{cookie})).status,400);
  // Same-name unrelated cookies may legitimately come from different Paths.
  assert.equal((await request(f.app,'/settings/bot','GET','',{cookie:`${s.cookie}; foo=1; foo=2`})).status,200);
  assert.equal((await request(f.app,'/settings/bot','GET','',{cookie:s.cookie},{rawHeaders:['Cookie','foo=1','Cookie',s.cookie]})).status,200);
  assert.equal((await request(f.app,'/settings/login','POST',`api_key=${apiKey}`,formHeaders,{rawHeaders:['Origin',origin,'Origin',origin]})).status,400);
});

test('Expired sessions, credential rotation and replaced login cookies are rejected',async()=>{
  const f=fixture();let s=await login(f),record=await f.store.get('settings_session',hash(s.token));record.expires=Date.now()-1;await f.store.put('settings_session',hash(s.token),record);
  assert.equal((await request(f.app,'/settings/bot','GET','',{cookie:s.cookie})).status,401);assert.equal((await submit(f,s)).status,401);
  s=await login(f);f.app.instanceKeyHash=hash('rotated-api-key'.padEnd(48,'x'));
  assert.equal((await submit(f,s)).status,401);assert.equal(f.calls.length,0);
  f.app.instanceKeyHash=hash(apiKey);s=await login(f);const replacement=await login(f,s.cookie);assert.notEqual(replacement.token,s.token);
  assert.equal(await f.store.get('settings_session',hash(s.token)),undefined);assert.equal((await submit(f,s)).status,401);assert.equal((await request(f.app,'/settings/bot','GET','',{cookie:replacement.cookie})).status,200);
});

test('Binding consumes a single-use session, returns no credentials, and tells the owner to register humans once',async()=>{
  const f=fixture(),s=await login(f),result=await submit(f,s);
  assert.equal(result.status,200);assert.match(result.body,/Bot bound/);assert.match(result.body,/123 \(@synthetic_bot\)/);assertNoSecrets(result,apiKey,token,s.token,s.csrf);
  assert.match(result.body,/human_register once/);assert.match(result.body,/Registered humans can DM every bound bot/);assert(!result.body.includes('telegram_whitelist_update'));
  assert.match(result.headers['set-cookie'],/Max-Age=0$/);assert.equal(await f.store.get('settings_session',hash(s.token)),undefined);
  const bot=await f.store.get('bot','123');assert.equal(bot.owner,'mcp:admin');assert.equal(bot.active,true);assert.equal((await f.store.get('group_bot','123')).agentId,agentId);assert.equal(bot.users,undefined);assert.equal(bot.chats,undefined);assertNoSecrets(bot,token);
  assert.equal(f.calls.filter(c=>c.method==='setWebhook').length,1);
  assert.equal((await submit(f,s)).status,401);assert.equal((await request(f.app,'/settings/bot','GET','',{cookie:s.cookie})).status,401);assert.equal(f.calls.filter(c=>c.method==='setWebhook').length,1);
});

test('Concurrent duplicate submissions can perform only one binding',async()=>{
  const f=fixture(),s=await login(f),results=await Promise.all([submit(f,s),submit(f,s)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);assert.equal(f.calls.filter(c=>c.method==='getMe').length,1);assert.equal(f.calls.filter(c=>c.method==='setWebhook').length,1);
});

test('A session changed after validation is revalidated after atomic consumption',async()=>{
  const f=fixture(),s=await login(f),take=f.store.take.bind(f.store);
  f.store.take=async(k,id)=>{const result=await take(k,id);if(k==='settings_session')result.authVersion=hash('revoked');return result;};
  assert.equal((await submit(f,s)).status,401);assert.equal(f.calls.length,0);assert.equal(await f.store.get('settings_session',hash(s.token)),undefined);
});

test('Telegram failure consumes the session without echoing errors or retrying an uncertain request',async()=>{
  const f=fixture(),s=await login(f);let mutations=0;
  f.app.telegram=async(_t,method)=>{if(method==='getMe')return{id:123,is_bot:true,username:'synthetic_bot'};if(method==='getWebhookInfo')return{url:''};mutations++;throw Object.assign(Error('secret '+token),{status:400});};
  const result=await submit(f,s);assert.equal(result.status,502);assert.match(result.body,/Check telegram_bot_get/);assert.match(result.body,/Do not automatically retry/);assertNoSecrets(result,token,apiKey);
  assert.equal(await f.store.get('settings_session',hash(s.token)),undefined);assert.equal((await submit(f,s)).status,401);assert.equal(mutations,1);assert.equal((await f.store.get('bot','123')).active,false);assert.equal((await f.store.get('group_bot','123')).agentId,agentId);
});

test('Settings rebind writes token and webhook without allowlists',async()=>{
  const f=fixture();await f.app.bind('mcp:admin',{token},{agentId});
  let s=await login(f);assert.equal((await submit(f,s)).status,200);assert.equal((await f.store.get('bot','123')).active,true);assert.equal((await f.store.get('bot','123')).users,undefined);
  s=await login(f);assert.equal((await submit(f,s)).status,200);assert.equal((await f.store.get('bot','123')).active,true);
  await f.app.invoke('mcp:admin','telegram_bot_bind',{token},{owner:'mcp:admin',agentId,authType:'api_key'});assert.equal((await f.store.get('bot','123')).active,true);
});

test('Settings cannot replace another webhook or take ownership of another agent bot',async()=>{
  const f=fixture();f.app.telegram=async(t,method)=>method==='getMe'?{id:123,is_bot:true,username:'synthetic_bot'}:method==='getWebhookInfo'?{url:'https://other-service.example/hook'}:assert.fail('Webhook must not be replaced');
  let s=await login(f);const conflict=await submit(f,s);assert.equal(conflict.status,409);assert.match(conflict.body,/foreign_webhook/);assert.match(conflict.body,/No webhook change was attempted/);assertNoSecrets(conflict,'https://other-service.example/hook',token,apiKey);assert.equal(await f.store.get('bot','123'),undefined);assert.equal((await submit(f,s)).status,401);
  f.app.telegram=async()=>({id:123,is_bot:true,username:'synthetic_bot'});await f.store.put('bot','123',{owner:'fixture-agent'});s=await login(f);assert.equal((await submit(f,s)).status,502);assert.equal((await f.store.get('bot','123')).owner,'fixture-agent');
});

test('Success only displays safe non-secret bot identifiers',async()=>{
  const f=fixture();f.app.telegram=async(t,method)=>method==='getMe'?{id:123,is_bot:true,username:'<script>'+token+'</script>'}:method==='getWebhookInfo'?{url:''}:true;
  const s=await login(f),result=await submit(f,s);assert.equal(result.status,200);assertNoSecrets(result,token);assert(!result.body.includes('<script>'));
});

test('Legacy /bind stays disabled and Vercel routes include the authenticated Settings paths',async()=>{
  const f=fixture();for(const method of ['GET','POST'])assert.equal((await request(f.app,'/bind',method,new URLSearchParams({token}).toString(),formHeaders)).status,410);
  assert.equal(f.calls.length,0);const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  // Exact rewrites avoid Vercel injecting wildcard matches as ?path=... into
  // req.url, which must retain its strict prohibition on query parameters.
  for(const path of ['/settings','/settings/login','/settings/bot','/settings/bind'])assert(config.rewrites.some(r=>r.source===path&&r.destination==='/api/index'));
  assert(!config.rewrites.some(r=>r.source.startsWith('/settings/')&&r.source.includes(':')));
});


test('Binding requires an existing same-owner handle without auto-selecting or creating an agent',async()=>{
  const f=fixture(),s=await login(f);
  const missing=new URLSearchParams({csrf:s.csrf,token}).toString();
  assert.equal((await request(f.app,'/settings/bind','POST',missing,{...formHeaders,cookie:s.cookie})).status,400);
  for(const handle of ['', 'a', 'invalid handle', 'unregistered']){
    assert.equal((await submit(f,s,{}, {agent_handle:handle})).status,400);
    assert(await f.store.get('settings_session',hash(s.token)));
  }
  // Even a malformed registry record stored at the expected lookup key cannot
  // cross the instance-owner boundary.
  const foreignId='agent_'+hash(JSON.stringify(['mcp:admin','foreign-agent']));
  await f.store.put('agent',foreignId,{owner:'other-owner',agentId:foreignId,handle:'foreign-agent'});
  assert.equal((await submit(f,s,{}, {agent_handle:'foreign-agent'})).status,400);
  assert(await f.store.get('settings_session',hash(s.token)));
  assert.equal((await f.store.list('agent')).length,2);assert.equal(f.calls.length,0);
});

test('Existing API-key session binds the selected normalized handle',async()=>{
  const f=fixture(),s=await login(f);let called;
  f.app.bind=async(owner,args,options)=>{called={owner,args,options};return {bot_id:'123',username:'synthetic_bot'};};
  const result=await submit(f,s,{}, {agent_handle:' SETTINGS-AGENT '});
  assert.equal(result.status,200);
  assert.deepEqual(called,{owner:'mcp:admin',args:{token},options:{agentId,bindingDiagnostic:{stage:'binding_validation'}}});
  assert.equal((await f.store.list('agent')).length,1);
  assert.equal((await f.store.list('agent_session')).length,0);
  assert.equal(await f.store.get('settings_session',hash(s.token)),undefined);
});

test('Handle duplicates and parser arrays are rejected before session consumption',async()=>{
  const f=fixture(),s=await login(f);
  const duplicate=new URLSearchParams({csrf:s.csrf,token,agent_handle:agentHandle});duplicate.append('agent_handle',agentHandle);
  assert.equal((await request(f.app,'/settings/bind','POST',duplicate.toString(),{...formHeaders,cookie:s.cookie})).status,400);
  assert.equal((await request(f.app,'/settings/bind','POST','',{...formHeaders,cookie:s.cookie},{body:{csrf:s.csrf,token,agent_handle:[agentHandle,agentHandle]}})).status,400);
  assert(await f.store.get('settings_session',hash(s.token)));assert.equal(f.calls.length,0);
});

test('Settings cannot give one handle a second bot or move its bot to another handle',async()=>{
  const f=fixture();let s=await login(f);assert.equal((await submit(f,s)).status,200);
  const original=await f.store.get('group_bot','123');const before=f.calls.length;
  s=await login(f);assert.equal((await submit(f,s,{}, {token:'456:'+token.split(':')[1]})).status,502);
  assert.equal(f.calls.length,before);assert.equal(await f.store.get('bot','456'),undefined);
  const otherHandle='other-settings-agent',otherId='agent_'+hash(JSON.stringify(['mcp:admin',otherHandle]));
  await f.store.put('agent',otherId,{owner:'mcp:admin',agentId:otherId,handle:otherHandle,displayName:'Other',created:new Date().toISOString()});
  s=await login(f);assert.equal((await submit(f,s,{}, {agent_handle:otherHandle})).status,502);
  assert.equal(f.calls.length,before);assert.deepEqual(await f.store.get('group_bot','123'),original);
});

test('Failed Settings rebind leaves an existing bot durably inactive without restoring old state',async()=>{
  const f=fixture();await f.app.bind('mcp:admin',{token},{agentId});
  const original=f.app.telegram;f.app.telegram=async(t,method,args)=>{if(method==='setWebhook')throw Error('synthetic uncertain webhook result');return original(t,method,args);};
  const s=await login(f),result=await submit(f,s);
  assert.equal(result.status,502);const bot=await f.store.get('bot','123');
  assert.equal(bot.active,false);
  assert.equal((await f.store.get('group_bot','123')).agentId,agentId);assert.equal(await f.store.get('settings_session',hash(s.token)),undefined);
});

for(const method of ['getMe','getWebhookInfo'])test(`Settings distinguishes ${method} failures from webhook write uncertainty`,async()=>{
 const f=fixture(),original=f.app.telegram,s=await login(f);let writes=0;
 f.app.telegram=async(t,m,a)=>{if(m==='setWebhook')writes++;if(m===method)throw Error('https://api.telegram.org/bot'+token+'/ '+apiKey);return original(t,m,a);};
 const result=await submit(f,s);assert.equal(result.status,502);assert.match(result.body,/No webhook change was attempted/);assert(!result.body.includes('may have succeeded'));assertNoSecrets(result,token,apiKey,'https://api.telegram.org');assert.equal(writes,0);assert.equal((await submit(f,s)).status,401);
});

test('Settings retains uncertain outcome after Telegram success but failed final storage',async()=>{
 const f=fixture(),s=await login(f),put=f.store.put.bind(f.store);let writes=0;
 f.store.put=async(k,id,v)=>{if(k==='bot'&&v.active)throw Error('storage '+apiKey);return put(k,id,v);};
 const original=f.app.telegram;f.app.telegram=async(t,m,a)=>{if(m==='setWebhook')writes++;return original(t,m,a);};
 const result=await submit(f,s);assert.equal(result.status,502);assert.match(result.body,/webhook_result_unconfirmed/);assert.match(result.body,/Do not automatically retry/);assertNoSecrets(result,token,apiKey);assert.equal(writes,1);assert.equal((await submit(f,s)).status,401);assert.equal(writes,1);
});


test('Settings pre-write storage failure is safe, definite and one-use',async()=>{
 const f=fixture(),s=await login(f),insert=f.store.insert.bind(f.store);
 f.store.insert=async(k,id,v)=>{if(k==='bot')throw Error('secret '+token+' '+apiKey);return insert(k,id,v);};
 const result=await submit(f,s);assert.equal(result.status,502);assert.match(result.body,/binding_storage_failed/);assert.match(result.body,/No Telegram webhook change was attempted/);assertNoSecrets(result,token,apiKey);assert.equal(f.calls.filter(c=>c.method==='setWebhook').length,0);assert.equal((await submit(f,s)).status,401);
});


test('Settings input diagnostics distinguish token, handle and parser errors without secrets',async()=>{
 const f=fixture(),s=await login(f);
 for(const [fields,code] of [[{token:'bad '+token},'bot_token_format'],[{agent_handle:'invalid handle'},'agent_handle_format'],[{agent_handle:'missing-agent'},'agent_handle_not_registered']]){
  const r=await submit(f,s,{},fields);assert.equal(r.status,400);assert.match(r.body,new RegExp('Error code: '+code));assertNoSecrets(r,token,apiKey,fields.agent_handle??'not-a-value');assert(await f.store.get('settings_session',hash(s.token)));assert.equal(f.calls.length,0);
 }
 const r=await request(f.app,'/settings/bind','POST','',{...formHeaders,cookie:s.cookie},{body:{csrf:s.csrf,token,agent_handle:[agentHandle,agentHandle]}});assert.equal(r.status,400);assert.match(r.body,/Error code: form_fields/);assertNoSecrets(r,token,apiKey);assert.equal(f.calls.length,0);
});

test('Settings lookup matches a registered dot OAuth identity and parsed form bodies',async()=>{
 const f=fixture();const registered=await f.app.invoke('mcp:admin','agent_register',{handle:'dot',display_name:'dot'},{owner:'mcp:admin',authType:'oauth',sessionId:'synthetic-oauth-lineage'});
 const s=await login(f);const r=await request(f.app,'/settings/bind','POST','',{...formHeaders,cookie:s.cookie},{body:{csrf:s.csrf,token,agent_handle:'dot'}});
 assert.equal(r.status,200);assert.equal((await f.store.get('group_bot','123')).agentId,registered.agent_id);assertNoSecrets(r,token,apiKey,registered.agent_token);
});

async function migrationFixture(){
 const f=fixture();f.hook='https://old.example/private-secret?key=synthetic_query_secret';f.mode='ok';
 f.app.telegram=async(t,method,args)=>{
  f.calls.push({method,args});
  if(method==='getMe')return {id:Number(t.split(':')[0]),is_bot:true,username:'synthetic_bot'};
  if(method==='getWebhookInfo'){if(f.mode==='verify-fail'&&f.wrote)throw Error('private failure');return {url:f.mode==='verify-mismatch'&&f.wrote?'https://changed.example/after':f.hook};}
  if(method==='setWebhook'){f.wrote=true;f.hook=args.url;if(f.mode==='timeout')throw Error('secret timeout');return true;}
  throw Error('unexpected method');
 };
 const initial=await login(f),preview=await submit(f,initial);assert.equal(preview.status,409);
 const cookie=preview.headers['set-cookie'].split(';')[0],csrf=preview.body.match(/name="csrf" value="([A-Za-z0-9_-]+)"/)[1];
 f.confirm={cookie,csrf};f.preview=preview;return f;
}
async function confirmMigration(f,fields={},headers={}){return submit(f,f.confirm,headers,{confirm_migration:'yes',...fields});}
test('foreign webhook preview stores no token or raw URL; explicit one-use confirmation preserves pending and verifies target',async()=>{
 const f=await migrationFixture();assert.match(f.preview.body,/old.example/);assertNoSecrets(f.preview,token,'private-secret','synthetic_query_secret',apiKey);
 assertNoSecrets([...f.store.data],token,'private-secret','synthetic_query_secret');assert.equal(await f.store.get('bot','123'),undefined);assert(!f.calls.some(c=>c.method==='setWebhook'));
 const [a,b]=await Promise.all([confirmMigration(f),confirmMigration(f)]);assert.deepEqual([a.status,b.status].sort(),[200,401]);
 const writes=f.calls.filter(c=>c.method==='setWebhook');assert.equal(writes.length,1);assert.equal(writes[0].args.drop_pending_updates,false);assert.equal(writes[0].args.url,origin+'/telegram/123');assert(!f.calls.some(c=>c.method==='deleteWebhook'));
 assert.equal(f.calls.at(-1).method,'getWebhookInfo');assert.equal((await f.store.get('bot','123')).active,true);assert.equal((await f.store.get('group_bot','123')).agentId,agentId);
});
test('migration rejects CSRF, foreign origin, changed target/token/hook, expiry and another agent without writing webhook',async()=>{
 for(const mode of ['csrf','origin','token','hook','expired','other-agent','generation','auth','target','actor-rename','actor-delete']){
  const f=await migrationFixture(),fields={},headers={};
  if(mode==='csrf')fields.csrf='invalid';if(mode==='origin')headers.origin='https://evil.example';if(mode==='token')fields.token='456:'+token.split(':')[1];if(mode==='hook')f.hook='https://changed.example/secret';
  const sid=hash(f.confirm.cookie.split('=')[1]),s=await f.store.get('settings_session',sid);
  if(mode==='expired'){s.expires=Date.now()-1;await f.store.put('settings_session',sid,s);}
  if(mode==='auth')f.app.instanceKeyHash=hash('different');
  if(mode==='target'){f.app.origin='https://new.example';headers.origin=f.app.origin;}
  if(mode==='actor-rename'){const a=await f.store.get('agent',agentId);await f.store.put('agent',agentId,{...a,handle:'renamed'});}
  if(mode==='actor-delete'){const lock=f.store.withBotLock.bind(f.store);f.store.withBotLock=(k,fn)=>lock(k,async tx=>{await tx.delete('agent',agentId);return fn(tx);});}
  if(mode==='other-agent')await f.store.put('group_bot','123',{owner:'mcp:admin',agentId:'other-agent',bindingId:'new'});
  if(mode==='generation')await f.store.put('group_bot','123',{owner:'mcp:admin',agentId,bindingId:'new'});
  const r=await confirmMigration(f,fields,headers);assert.notEqual(r.status,200,mode);assert(!f.calls.some(c=>c.method==='setWebhook'),mode);assertNoSecrets(r,token,'private-secret');
 }
});
test('migration cancellation and expiration while waiting for lock do not mutate Telegram',async()=>{
 const f=await migrationFixture();assert.equal((await confirmMigration(f,{confirm_migration:'no',token:''})).status,200);assert.equal((await confirmMigration(f)).status,401);assert(!f.wrote);
 const g=await migrationFixture(),original=g.store.withBotLock.bind(g.store);
 g.store.withBotLock=async(k,fn)=>original(k,async tx=>{const old=Date.now;Date.now=()=>old()+360000;try{return await fn(tx);}finally{Date.now=old;}});
 assert.notEqual((await confirmMigration(g)).status,200);assert(!g.wrote);
});
test('migration timeout or verification failure is unconfirmed, inactive, one-use and never auto-rolled-back',async()=>{
 for(const mode of ['timeout','verify-fail','verify-mismatch','db-fail']){
  const f=await migrationFixture();f.mode=mode;
  if(mode==='db-fail'){const put=f.store.put.bind(f.store);f.store.put=async(k,id,v)=>{if(k==='bot'&&v.active)throw Error('storage failed');return put(k,id,v);};}
  const r=await confirmMigration(f);assert.equal(r.status,502);assert.match(r.body,/webhook_result_unconfirmed/);assertNoSecrets(r,'secret timeout',token);assert.equal((await f.store.get('bot','123')).active,false);
  assert.equal((await confirmMigration(f)).status,401);assert.equal(f.calls.filter(c=>c.method==='setWebhook').length,1);assert(!f.calls.some(c=>c.method==='deleteWebhook'));
 }
});


test('concurrent confirmation and cancellation cannot both claim success',async()=>{
 for(const cancelFirst of [true,false]){
  const f=await migrationFixture(),take=f.store.take.bind(f.store);let release,entered=0;
  const barrier=new Promise(resolve=>release=resolve);
  f.store.take=async(...args)=>{if(++entered===2)release();await barrier;return take(...args);};
  const confirm=()=>confirmMigration(f),cancel=()=>confirmMigration(f,{confirm_migration:'no',token:''});
  const results=await Promise.all((cancelFirst?[cancel,confirm]:[confirm,cancel]).map(fn=>fn()));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,401]);
  const winner=results.find(r=>r.status===200);
  if(winner.body.includes('Migration cancelled'))assert(!f.wrote);
  else assert.equal(f.calls.filter(c=>c.method==='setWebhook').length,1);
 }
});
