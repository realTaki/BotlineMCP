// One stateless protocol revision on every HTTP request.
export const PROTOCOL_VERSION='2026-07-28';
export const SUPPORTED_VERSIONS=[PROTOCOL_VERSION];
export const STREAMABLE_HTTP_VERSION='2025-06-18';
export const STREAMABLE_HTTP_VERSIONS=['2025-03-26','2025-06-18','2025-11-25'];
export const SERVER_VERSION='0.6.26';
export const SERVER_INFO={name:'BotlineMCP',version:SERVER_VERSION};
const prefix='io.modelcontextprotocol/';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const failure=(code,message,data)=>({code,message,...(data?{data}:{})});
export function acceptsEventStream(accept){
 return typeof accept==='string'&&accept.split(',').some(part=>part.trim().toLowerCase().startsWith('text/event-stream'));
}
export function usesModernEnvelope(req,rpc){
 const header=req.headers['mcp-protocol-version'];
 const meta=rpc?.params?._meta?.[prefix+'protocolVersion'];
 if(header===PROTOCOL_VERSION||meta===PROTOCOL_VERSION)return true;
 if(rpc?.method==='initialize'||rpc?.method==='notifications/initialized')return false;
 if(STREAMABLE_HTTP_VERSIONS.includes(header)||STREAMABLE_HTTP_VERSIONS.includes(meta))return false;
 return req.headers['mcp-method']!==undefined;
}
export function writeGetSse(res,req){
 res.statusCode=200;
 res.setHeader('Content-Type','text/event-stream');
 res.setHeader('Cache-Control','no-cache, no-store');
 res.setHeader('Connection','keep-alive');
 res.setHeader('X-Accel-Buffering','no');
 const priming=': connected\n\nretry: 15000\n\n';
 try{req?.resume?.();}catch{}
 if(typeof res.write==='function'){
  if(typeof res.flushHeaders==='function')res.flushHeaders();
  res.write(priming);
  req?.socket?.on?.('close',()=>{try{if(!res.writableEnded)res.end();}catch{}});
  return;
 }
 res.end(priming);
}
export function writeMcpResponse(req,res,status,payload){
 const stream=acceptsEventStream(req.headers.accept)&&payload&&(typeof payload.id==='string'||Number.isInteger(payload.id));
 res.statusCode=status;
 res.setHeader('Cache-Control','no-store');
 if(stream){
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  return res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
 }
 res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify(payload));
}
function decoded(value){
 if(typeof value!=='string')return null;
 if(value.startsWith('=?base64?')&&value.endsWith('?=')){
  const encoded=value.slice(9,-2);
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))return null;
  return Buffer.from(encoded,'base64').toString('utf8');
 }
 return value;
}
export function protocolRequest(req,rpc){
 const meta=rpc?.params?._meta,version=meta?.[prefix+'protocolVersion'],header=req.headers['mcp-protocol-version'];
 if(!object(rpc)||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string'||!(typeof rpc.id==='string'||Number.isInteger(rpc.id)))return {error:failure(-32600,'Invalid JSON-RPC request')};
 if(typeof version!=='string'||!object(meta?.[prefix+'clientCapabilities']))return {error:failure(-32602,'Required per-request protocol metadata is missing or malformed')};
 if(header!==version||req.headers['mcp-method']!==rpc.method)return {error:failure(-32020,'Protocol routing headers do not match the request')};
 if(!SUPPORTED_VERSIONS.includes(version))return {error:failure(-32022,'Unsupported protocol version',{supported:SUPPORTED_VERSIONS,requested:version})};
 if(['initialize','notifications/initialized','ping'].includes(rpc.method))return {status:404,error:failure(-32601,'Method not supported by this protocol revision')};
 const named=['tools/call','resources/read','prompts/get'].includes(rpc.method);
 const name=rpc.method==='resources/read'?rpc.params?.uri:rpc.params?.name;
 if(named&&typeof name!=='string')return {error:failure(-32602,'Named request requires a name or URI')};
 if(named&&decoded(req.headers['mcp-name'])!==name)return {error:failure(-32020,'Named routing header does not match the request')};
 return {};
}
export function modernResult(result){return {...result,resultType:result.resultType??'complete',_meta:{...result._meta,[prefix+'serverInfo']:SERVER_INFO}};}
// Shared by the serverless entry and the development/direct HTTP handler.
export function prepareProtocol(req,res,rpc){
 req.protocolMessage=rpc;
 if(req.protocolPrepared)return true;
 const protocol=protocolRequest(req,rpc);
 if(protocol.error){writeMcpResponse(req,res,protocol.status??400,{jsonrpc:'2.0',...(typeof rpc?.id==='string'||Number.isInteger(rpc?.id)?{id:rpc.id}:{}),error:protocol.error});return false;}
 req.protocolPrepared=true;
 {
  const end=res.end.bind(res);
  res.end=body=>{
   if(typeof body==='string')try{
    const value=JSON.parse(body);
    if(value.result)value.result=modernResult(value.result);
    if(value.error?.code===-32601)res.statusCode=404;
    else if(value.error?.code<=-32000&&value.error?.code>=-32019)value.error.code=-32603;
    body=JSON.stringify(value);
   }catch{}
   return end(body);
  };
 }
 return true;
}

const diagnosticMethods=new Set(['server/discover','initialize','notifications/initialized','ping','tools/list','tools/call','events/list','events/subscribe','events/unsubscribe']);
const diagnosticVersions=new Set(['2024-11-05','2025-03-26','2025-06-18','2025-11-25','2026-07-28']);
const diagnosticVersion=value=>value===undefined?'missing':diagnosticVersions.has(value)?value:'other';
export function protocolDiagnostic(req,rpc,status){
 return {event:'mcp.protocol',method:diagnosticMethods.has(rpc?.method)?rpc.method:'other',header_version:diagnosticVersion(req.headers['mcp-protocol-version']),body_version:diagnosticVersion(rpc?.method==='initialize'?rpc?.params?.protocolVersion:rpc?.params?._meta?.[prefix+'protocolVersion']),status:Number.isInteger(status)&&status>=100&&status<=599?status:500};
}
export function instrumentProtocol(req,res,emit=value=>console.info(JSON.stringify(value))){
 if(req.protocolInstrumented)return;
 req.protocolInstrumented=true;
 const end=res.end.bind(res);let emitted=false;
 res.end=body=>{
  if(!emitted){emitted=true;try{emit(protocolDiagnostic(req,req.protocolMessage,res.statusCode??200));}catch{}}
  return end(body);
 };
}
