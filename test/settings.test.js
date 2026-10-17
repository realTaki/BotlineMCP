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
  let s=await login(f);assert.equal((await submit(f,s)).status,502);assert.equal(await f.store.get('bot','123'),undefined);
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
  assert.deepEqual(called,{owner:'mcp:admin',args:{token},options:{agentId}});
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
