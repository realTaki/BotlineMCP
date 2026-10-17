import {prepareProtocol,instrumentProtocol} from '../src/protocol.js';
import {configuration} from '../src/config.js';
import { App,handler,readBody } from '../src/app.js';
import { Store } from '../src/store.js';
export function createEntrypoint(createService=()=>{
 const config=configuration(process.env),store=new Store(config.databaseUrl);
 return {serve:handler(new App({store,...config})),initialized:store.initialize()};
},publicOrigin=()=>process.env.VERCEL_PROJECT_PRODUCTION_URL?'https://'+process.env.VERCEL_PROJECT_PRODUCTION_URL:null){
 let serve, initialized;
 return async function(req,res){
 // Only identity-free discovery may bypass the configured handler.
 if(req.method==='POST'&&req.url.split('?')[0]==='/mcp'){
  instrumentProtocol(req,res);
  if(req.headers.origin!==undefined&&req.headers.origin!==publicOrigin()){res.statusCode=403;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');return res.end(JSON.stringify({error:'Origin mismatch'}));}
  try{
   req.body=JSON.parse(await readBody(req));
   if(!prepareProtocol(req,res,req.body))return;
   const contextualList=req.body.method==='tools/list'&&['authorization','x-mcp-agent-id','x-mcp-bot-type'].some(h=>req.headers[h]!==undefined);
   if(!contextualList&&req.body.jsonrpc==='2.0'&&['server/discover','tools/list','events/list'].includes(req.body.method)){
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    return res.end(JSON.stringify({jsonrpc:'2.0',id:req.body.id??null,result:await new App({}).rpc(null,req.body.method)}));
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
