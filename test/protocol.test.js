import test from 'node:test';
import assert from 'node:assert/strict';
import {instrumentProtocol,prepareProtocol,protocolDiagnostic} from '../src/protocol.js';
test('protocol diagnostics emit only bounded enums and numeric status, never request or response content',()=>{
 const sensitive='synthetic-secret-person@example.test';
 const req={headers:{authorization:sensitive,'mcp-protocol-version':sensitive,origin:sensitive},url:'/'+sensitive};
 const rpc={id:sensitive,method:sensitive,params:{name:sensitive,arguments:{token:sensitive},_meta:{'io.modelcontextprotocol/protocolVersion':sensitive}}};
 assert.deepEqual(protocolDiagnostic(req,rpc,401),{event:'mcp.protocol',method:'other',header_version:'other',body_version:'other',status:401});
 const emitted=[],res={statusCode:400,setHeader(){},end(){}};
 instrumentProtocol(req,res,v=>emitted.push(v));instrumentProtocol(req,res,v=>emitted.push(v));
 prepareProtocol(req,res,rpc);res.end(sensitive);
 assert.equal(emitted.length,1);assert.equal(emitted[0].status,400);assert(!JSON.stringify(emitted).includes(sensitive));
});
test('diagnostics distinguish actual legacy/modern requests including success and authentication rejection',()=>{
 for(const version of ['2026-07-28','2025-06-18',undefined])for(const status of [200,400,401,403]){
  const req={headers:{'mcp-protocol-version':version},protocolMessage:{method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':version}}}};
  const emitted=[],res={statusCode:status,end(){}};instrumentProtocol(req,res,v=>emitted.push(v));res.end('private response');
  assert.equal(emitted[0].method,'tools/list');assert.equal(emitted[0].header_version,version??'missing');assert.equal(emitted[0].body_version,version??'missing');assert.equal(emitted[0].status,status);
 }
});

test('legacy initialization request versions remain bounded but observable',()=>{
 for(const version of ['2024-11-05','2025-03-26','2025-06-18','2025-11-25','2026-07-28'])assert.equal(protocolDiagnostic({headers:{}},{method:'initialize',params:{protocolVersion:version}},200).body_version,version);
 assert.equal(protocolDiagnostic({headers:{}},{method:'initialize',params:{protocolVersion:'synthetic-secret@example.test'}},200).body_version,'other');
});
