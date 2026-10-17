import {requireThat} from './security.js';

export const GROKBOT_API_ORIGIN='https://api.cursor.com';
const TIMEOUT_MS=15000;

// Provider bodies can contain private content or unrelated credentials. Never
// reflect, parse, or log an error body; expose only fixed status-based guidance.
function publicApiError(status){
 if(status===401||status===403)return 'Cursor API credentials were rejected; check the configured key and access.';
 if(status===429)return 'Cursor API rate limit reached; retry later.';
 if(status===409||status>=500)return 'Cursor API is temporarily unavailable; retry later.';
 return 'Cursor API rejected the request; check the Grok Bot configuration.';
}

// Dispatcher policy: 2xx delivered, 409/429/5xx/network retried, other 4xx failed.
function classifyHttp(status){
 if(status===409)return 503;
 if(status===401||status===403)return 409;
 return status;
}

async function grokbotRequest(apiKey,method,path,body,{fetchImpl=fetch}={}){
 requireThat(typeof apiKey==='string'&&apiKey.length>0,'Cursor API key required',409);
 const headers={authorization:`Bearer ${apiKey}`,'x-cursor-client-type':'agent-serve'};
 if(body!==undefined)headers['content-type']='application/json';
 let response;
 try{
  response=await fetchImpl(GROKBOT_API_ORIGIN+path,{method,redirect:'error',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(TIMEOUT_MS)});
 }catch{return {ok:false,status:0};}
 const status=classifyHttp(response.status);
 if(status<200||status>=300)return {ok:false,status,error:publicApiError(response.status)};
 let text='';
 try{text=await response.text();}catch{return {ok:false,status:0};}
 try{return {ok:true,status,body:JSON.parse(text)};}catch{return {ok:false,status:502};}
}

export async function grokbotSession(apiKey,name,{fetchImpl=fetch}={}){
 requireThat(typeof name==='string'&&name.length>0,'Grok Bot name required');
 const result=await grokbotRequest(apiKey,'POST','/v0/grokbot/sessions',{name},{fetchImpl});
 if(!result.ok)throw Object.assign(new Error(result.error||'Grok Bot session request failed'),{status:result.status||502});
 const id=result.body?.id;
 requireThat(typeof id==='string'&&id.length>0,'Grok Bot session response was invalid',502);
 return {id,name:result.body.name,createdAtMs:result.body.createdAtMs,latestUpdatedSeq:result.body.latestUpdatedSeq};
}

export async function grokbotMessage(apiKey,sessionId,text,messageId,{fetchImpl=fetch}={}){
 requireThat(typeof sessionId==='string'&&sessionId.length>0,'Grok Bot session required',502);
 requireThat(typeof messageId==='string'&&messageId.length>0,'messageId required');
 const result=await grokbotRequest(apiKey,'POST',`/v0/grokbot/sessions/${encodeURIComponent(sessionId)}/messages`,{text,messageId},{fetchImpl});
 if(!result.ok)return {status:result.status||0};
 const delivery=result.body?.delivery;
 if(delivery==='accepted_temporal'||delivery==='duplicate')return {status:200};
 return {status:400};
}
