import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {App,handler} from '../src/app.js';
import {createEntrypoint} from '../api/index.js';
import {SETUP_GUIDE} from '../src/landing.js';
import {registerAgent,resolveCallerAgent} from '../src/agents.js';
import {BOOTSTRAP_EXCLUDED,unregisteredNextStep,toolDescription} from '../src/onboarding.js';
import {INSTANCE_ID} from '../src/config.js';
async function request(serve,method='GET',headers={},rpc){
 const req=Readable.from(rpc?[JSON.stringify(rpc)]:[]);Object.assign(req,{url:'/mcp',method,headers});
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=body??'';}};
 await serve(req,res);return res;
}
test('explicit HTML bootstrap preserves SSE and origin restrictions in both entrypoints',async()=>{
 let starts=0;
 const entry=createEntrypoint(()=>{starts++;throw new Error('no config');},()=> 'https://own.example');
 for(const serve of [entry,handler(new App({origin:'https://own.example'}))]){
  for(const accept of ['text/html','text/html,application/xhtml+xml,*/*;q=0.8']){
   const r=await request(serve,'GET',{accept});assert.equal(r.statusCode,200);assert.match(r.headers['Content-Type'],/text\/html/);assert.match(r.body,/href="\/setup.md"/);assert.doesNotMatch(r.body,/botlinemcp.vercel.app/);assert.equal(r.headers.Vary,'Accept');
  }
  for(const accept of [undefined,'*/*','text/event-stream','text/html,text/event-stream','text/html;q=0']){
   const r=await request(serve,'GET',accept?{accept}:{});assert.equal(r.headers['Content-Type'],'text/event-stream');assert.match(r.body,/: connected/);
  }
  assert.equal((await request(serve,'GET',{accept:'text/html',origin:'https://foreign.example'})).statusCode,403);
 }
 assert.equal(starts,0);
});
test('anonymous discovery explains authentication while business calls still reject anonymous clients',async()=>{
 const app=new App({origin:'https://own.example',instanceKey:'synthetic-instance-key'.repeat(3)}),serve=handler(app);
 for(const method of ['initialize','server/discover','tools/list']){
  const r=await request(serve,'POST',{'mcp-protocol-version':'2025-06-18'},{jsonrpc:'2.0',id:1,method,params:{}});assert.equal(r.statusCode,200);
  const result=JSON.parse(r.body).result;
  if(method!=='tools/list'){assert(result.instructions.endsWith(SETUP_GUIDE));assert.match(result.instructions,/Authorization: Bearer/);assert.match(result.instructions,/same origin/);}
 }
 const r=await request(serve,'POST',{'mcp-protocol-version':'2025-06-18'},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agent_whoami',arguments:{}}});assert.equal(r.statusCode,401);assert.match(r.headers['WWW-Authenticate'],/https:\/\/own.example\/.well-known\/oauth-protected-resource/);
});
test('one canonical guide covers hosted and selfhost readiness without credential or delivery shortcuts',()=>{
 assert.equal(SETUP_GUIDE,readFileSync(new URL('../public/setup.md',import.meta.url),'utf8'));
 for(const phrase of ['ChatGPT dot onboarding','Muse onboarding','Grok Bot onboarding','Generic webhook onboarding','session advisory locks','transaction-pooling','DDL','--env-file','configured','relay.error','seen-state','agent_whoami','revokes the previous','same origin','live delivery untested','confirmation codes','If the BotlineMCP connector is already installed','~/.secrets/BOTLINE_<HANDLE>_AGENT_TOKEN','agents_list'])assert(SETUP_GUIDE.includes(phrase),phrase);
 assert(!SETUP_GUIDE.includes('https://botlinemcp.vercel.app/mcp'));
 const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');assert.match(readme,/public\/setup.md/);
 const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');assert.match(source,/\+SETUP_GUIDE/);assert.doesNotMatch(source,/const museOnboarding=/);
});
test('initialize instructions include one do-this section per client and Grok Bot step 0',async()=>{
 const app=new App({origin:'https://own.example'});
 const init=await app.rpc(null,'initialize');
 assert.match(init.instructions,/## Grok Bot — do this/);
 assert.match(init.instructions,/## ChatGPT dot — do this/);
 assert.match(init.instructions,/## Muse — do this/);
 assert.match(init.instructions,/## Generic webhook — do this/);
 assert.match(init.instructions,/If the BotlineMCP connector is already installed, use it/);
 assert.match(init.instructions,/Do not ask for MCP_API_KEY/);
 assert.match(init.instructions,/Call agent_whoami with the saved agent_token first/);
 assert.match(init.instructions,/Call agent_register only if unregistered/);
 assert.match(init.instructions,/Do not subscribe to agent.notification/);
 assert.match(init.instructions,/\[handle\.type@botline\]:/);
 assert(init.instructions.endsWith(SETUP_GUIDE));
 assert.match(SETUP_GUIDE,/0\. If the BotlineMCP connector is already installed, use it/);
});
test('unregistered whoami includes next_step, setup.md, has_cursor_key, and bootstrap tools',async()=>{
 class Store {
  constructor(){this.data=new Map();}
  async get(k,id){return structuredClone(this.data.get(k+':'+id));}
  async put(k,id,v){this.data.set(k+':'+id,structuredClone(v));}
  async insert(k,id,v){if(this.data.has(k+':'+id))return false;await this.put(k,id,v);return true;}
  async list(k,o){return [...this.data].filter(([id,v])=>id.startsWith(k+':')&&(!o||v.owner===o)).map(([,v])=>structuredClone(v));}
  async withLock(key,fn){return fn(this);}
 }
 const app=new App({store:new Store(),instanceKey:'synthetic-instance-key'.repeat(3),origin:'https://own.example',key:Buffer.alloc(32,7).toString('base64')});
 const who=await app.invoke(INSTANCE_ID,'agent_whoami',{},{owner:INSTANCE_ID,authType:'api_key',agentId:null});
 assert.equal(who.registered,false);assert.equal(who.agent_id,null);assert.equal(who.has_cursor_key,false);
 assert.equal(who.next_step,unregisteredNextStep(null));assert.match(who.next_step,/setup\.md/);
 assert.equal(who.tool_profile,'bootstrap');
 for(const name of BOOTSTRAP_EXCLUDED)assert(!who.available_tool_names.includes(name),name);
 assert(who.available_tool_names.includes('agent_register'));assert(who.available_tool_names.includes('agent_whoami'));
 const grok=await app.rpc(INSTANCE_ID,'tools/list',{},{owner:INSTANCE_ID,authType:'api_key',agentId:null},'grokbot');
 const grokNames=grok.tools.map(t=>t.name);
 for(const name of BOOTSTRAP_EXCLUDED)assert(!grokNames.includes(name),name);
 assert(!grokNames.includes('messages_inbox'));
 assert.match(grok.tools.find(t=>t.name==='agent_register').description,/^Grok Bot registers with a lowercase handle/);
 assert.doesNotMatch(grok.tools.find(t=>t.name==='agent_register').description,/Muse registers/);
});
test('missing grokbot_agent_name warns; whitespace-padded tokens are accepted',async()=>{
 class Store {
  constructor(){this.data=new Map();}
  async get(k,id){return structuredClone(this.data.get(k+':'+id));}
  async put(k,id,v){this.data.set(k+':'+id,structuredClone(v));}
  async insert(k,id,v){if(this.data.has(k+':'+id))return false;await this.put(k,id,v);return true;}
  async list(k,o){return [...this.data].filter(([id,v])=>id.startsWith(k+':')&&(!o||v.owner===o)).map(([,v])=>structuredClone(v));}
  async withLock(key,fn){return fn(this);}
 }
 const app=new App({store:new Store(),instanceKey:'x'.repeat(64),origin:'https://own.example',key:Buffer.alloc(32,7).toString('base64')});
 const root={owner:INSTANCE_ID,authType:'api_key',agentId:null};
 const registered=await registerAgent(app,root,{handle:'shu1',display_name:'Synthetic One'});
 assert.match(registered.warning,/will not receive replies/);assert.equal(registered.next_step,'Confirm with agent_whoami.');
 const padded=await resolveCallerAgent(app,root,{agent_token:' \n'+registered.agent_token+'  '});
 assert.equal(padded.handle,'shu1');assert.equal(padded.agent_token,undefined);
 const listed=await app.rpc(INSTANCE_ID,'tools/list',{},root);
 for(const name of BOOTSTRAP_EXCLUDED)assert(!listed.tools.map(t=>t.name).includes(name),name);
});
test('every messages_send description variant keeps credential and limit safety text',()=>{
 for(const botType of ['grokbot','dot','muse','webhook',null]){
  const description=toolDescription('messages_send',botType);
  assert.match(description,/Never include credentials/,String(botType));
  assert.match(description,/Requires owner authorization/,String(botType));
  assert.match(description,/2 MiB/,String(botType));
  assert.match(description,/24 hours/,String(botType));
  assert.match(description,/actual recipient/,String(botType));
  assert.match(description,/1024/,String(botType));
  assert.match(description,/bound bot/,String(botType));
 }
});
