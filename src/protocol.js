// Modern per-request metadata and legacy initialize share one stateless endpoint.
export const MODERN_VERSION='2026-07-28';
export const LEGACY_VERSION='2025-06-18';
export const SUPPORTED_VERSIONS=[MODERN_VERSION,LEGACY_VERSION];
export const SERVER_INFO={name:'BotlineMCP',version:'0.6.17'};
const prefix='io.modelcontextprotocol/';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const failure=(code,message,data)=>({code,message,...(data?{data}:{})});
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
 const modern=version!==undefined||header!==undefined&&header!==LEGACY_VERSION;
 if(!modern)return {modern:false};
 if(!object(rpc)||rpc.jsonrpc!=='2.0'||typeof rpc.method!=='string'||!(typeof rpc.id==='string'||Number.isInteger(rpc.id)))return {modern:true,error:failure(-32600,'Invalid JSON-RPC request')};
 if(typeof version!=='string'||!object(meta?.[prefix+'clientCapabilities']))return {modern:true,error:failure(-32602,'Required per-request protocol metadata is missing or malformed')};
 if(header!==version||req.headers['mcp-method']!==rpc.method)return {modern:true,error:failure(-32020,'Protocol routing headers do not match the request')};
 if(!SUPPORTED_VERSIONS.includes(version))return {modern:true,error:failure(-32022,'Unsupported protocol version',{supported:SUPPORTED_VERSIONS,requested:version})};
 if(version!==MODERN_VERSION)return {modern:true,error:failure(-32602,'Per-request metadata requires a modern protocol version')};
 if(['initialize','ping'].includes(rpc.method))return {modern:true,status:404,error:failure(-32601,'Method is only available through legacy initialization')};
 const name=rpc.method==='resources/read'?rpc.params?.uri:['tools/call','prompts/get'].includes(rpc.method)?rpc.params?.name:undefined;
 if(name!==undefined&&decoded(req.headers['mcp-name'])!==name)return {modern:true,error:failure(-32020,'Named routing header does not match the request')};
 return {modern:true};
}
export function modernResult(result){return {...result,resultType:result.resultType??'complete',_meta:{...result._meta,[prefix+'serverInfo']:SERVER_INFO}};}
// Shared by the serverless entry and the development/direct HTTP handler.
export function prepareProtocol(req,res,rpc){
 req.protocolMessage=rpc;
 if(req.protocolPrepared)return true;
 const protocol=protocolRequest(req,rpc);
 if(protocol.error){res.statusCode=protocol.status??400;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:protocol.error}));return false;}
 req.protocolPrepared=true;
 if(protocol.modern){
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
