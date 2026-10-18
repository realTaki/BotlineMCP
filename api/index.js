import {prepareProtocol,instrumentProtocol,usesModernEnvelope,writeGetSse,writeMcpResponse,modernResult} from '../src/protocol.js';
import {configuration} from '../src/config.js';
import { App,handler,readBody } from '../src/app.js';
import {tryLanding,tryMcpGuide} from '../src/landing.js';
import { Store } from '../src/store.js';
export function createEntrypoint(createService=()=>{
 const config=configuration(process.env),store=new Store(config.databaseUrl);
 return {serve:handler(new App({store,...config})),initialized:store.initialize()};
},publicOrigin=()=>process.env.VERCEL_PROJECT_PRODUCTION_URL?'https://'+process.env.VERCEL_PROJECT_PRODUCTION_URL:null){
 let serve, initialized;
 return async function(req,res){
 const path=req.url.split('?')[0];
 if(tryLanding(req,res,path))return;
 if(path==='/mcp'){
  instrumentProtocol(req,res);
  if(req.headers.origin!==undefined&&req.headers.origin!==publicOrigin()){res.statusCode=403;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');return res.end(JSON.stringify({error:'Origin mismatch'}));}
  if(req.method==='GET'){if(tryMcpGuide(req,res))return;return writeGetSse(res,req);}
 }
 // Only identity-free discovery may bypass the configured handler.
 if(req.method==='POST'&&path==='/mcp'){
  try{
   req.body=JSON.parse(await readBody(req));
   req.protocolMessage=req.body;
   if(req.body?.jsonrpc==='2.0'&&typeof req.body.method==='string'&&req.body.id===undefined&&!Array.isArray(req.body)&&req.body.method.startsWith('notifications/')){res.statusCode=202;return res.end();}
   if(usesModernEnvelope(req,req.body)){
    if(!prepareProtocol(req,res,req.body))return;
    const contextualList=req.body.method==='tools/list'&&['authorization','x-mcp-agent-id','x-mcp-bot-type'].some(h=>req.headers[h]!==undefined);
    if(!contextualList&&req.body.jsonrpc==='2.0'&&['server/discover','tools/list','events/list'].includes(req.body.method)){
     const payload={jsonrpc:'2.0',id:req.body.id??null,result:modernResult(await new App({}).rpc(null,req.body.method))};
     return writeMcpResponse(req,res,200,payload);
    }
   }
  }catch{res.statusCode=400;return res.end('Invalid request');}
 }

 if(!serve){
  try{
   ({serve,initialized}=createService());
  }catch{res.statusCode=503;return res.end('Invalid service configuration.');}
 }
 try{await initialized;}catch{serve=undefined;initialized=undefined;res.statusCode=503;return res.end('Database initialization unavailable.');}
 return serve(req,res);
}
}
export default createEntrypoint();
