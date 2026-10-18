import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readFileSync} from 'node:fs';
import {App,handler} from '../src/app.js';
import {createEntrypoint} from '../api/index.js';
import {SETUP_GUIDE} from '../src/landing.js';
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
 for(const phrase of ['ChatGPT dot onboarding','Muse onboarding','Grok Bot onboarding','Generic webhook onboarding','session advisory locks','transaction-pooling','DDL','--env-file','configured','relay.error','seen-state','agent_whoami','invalidates the previous','same origin','live delivery untested','confirmation codes'])assert(SETUP_GUIDE.includes(phrase),phrase);
 assert(!SETUP_GUIDE.includes('https://botlinemcp.vercel.app/mcp'));
 const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');assert.match(readme,/public\/setup.md/);
 const source=readFileSync(new URL('../src/app.js',import.meta.url),'utf8');assert.match(source,/\+SETUP_GUIDE/);assert.doesNotMatch(source,/const museOnboarding=/);
});
