import {INSTANCE_ID} from './config.js';
import {createHash} from 'node:crypto';
import {hash,nonce,requireThat,same,escapeHtml} from './security.js';
import {getAgent,registerAgent} from './agents.js';
export const OAUTH_CONSENT_LIMIT=Object.freeze({windowMs:10*60*1000,max:30});
function consentLimiterId(req){
 const forwarded=req.headers['x-forwarded-for'];
 const ip=typeof forwarded==='string'&&forwarded.trim()?forwarded.split(',')[0].trim():(typeof req.socket?.remoteAddress==='string'?req.socket.remoteAddress:'unknown');
 return hash('oauth-authorize:'+ip);
}
async function consumeConsentLimit(app,req){
 const now=Date.now(),id=consentLimiterId(req);
 const current=await app.store.get('oauth_limit',id);
 const window=current&&Number.isFinite(current.window)&&current.window>now-OAUTH_CONSENT_LIMIT.windowMs?current.window:now;
 const count=window===current?.window&&Number.isFinite(current.count)?current.count:0;
 requireThat(count<OAUTH_CONSENT_LIMIT.max,'Too many authorization attempts; retry later',429);
 await app.store.put('oauth_limit',id,{window,count:count+1,expires:window+OAUTH_CONSENT_LIMIT.windowMs});
}
export async function authenticate(app,req){
 return (await authenticatePrincipal(app,req)).owner;
}
export async function authenticatePrincipal(app,req){
 const authorization=req.headers.authorization;
 requireThat(typeof authorization==='string'&&authorization.startsWith('Bearer '),'Authentication required',401);
 const bearer=authorization.slice(7);
 if(app.instanceKeyHash&&same(hash(bearer),app.instanceKeyHash)){
  // Explicit selector is allowed only with the shared root credential. It does
  // not narrow its authority and cannot override an OAuth session's identity.
  const selected=req.headers['x-mcp-agent-id'];
  requireThat(selected===undefined||typeof selected==='string'&&await getAgent(app,INSTANCE_ID,selected),'Unknown agent identity',403);
  return {owner:INSTANCE_ID,agentId:selected??null,authType:'api_key'};
 }
 const t=await app.store.get('access',hash(bearer));
 requireThat(t&&t.expires>Date.now()&&t.resource===app.origin+'/mcp'&&await app.ownerActive(t.owner),'Authentication required',401);
 if(t.authVersion)requireThat(await app.authVersion(t.owner)===t.authVersion,'Credential rotated',401);
 const linked=t.sessionId?await app.store.get('agent_session',t.sessionId):null;
 requireThat(!linked||linked.owner===t.owner,'Invalid agent session',401);
 const agentId=linked?.agentId??t.agentId??null;
 requireThat(!agentId||await getAgent(app,t.owner,agentId),'Unknown agent identity',401);
 return {owner:t.owner,agentId,authType:'oauth',...(t.sessionId?{sessionId:t.sessionId}:{})};
}
export async function oauth(app,req,path,readBody,send,res){
 const resource=app.origin+'/mcp';
 if(path==='/.well-known/oauth-protected-resource'||path==='/.well-known/oauth-protected-resource/mcp')return send(200,{resource,authorization_servers:[app.origin],scopes_supported:['bot:manage']});
 if(path==='/.well-known/oauth-authorization-server')return send(200,{issuer:app.origin,authorization_endpoint:app.origin+'/oauth/authorize',token_endpoint:app.origin+'/oauth/token',registration_endpoint:app.origin+'/oauth/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:['bot:manage'],authorization_response_iss_parameter_supported:true});
 if(path==='/oauth/register'&&req.method==='POST'){
  const p=JSON.parse(await readBody(req,8192));
  requireThat(Array.isArray(p.redirect_uris)&&p.redirect_uris.length>0&&p.redirect_uris.length<=5,'Invalid redirect URIs');
  for(const value of p.redirect_uris){const u=new URL(value);requireThat(u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&(!u.port||u.port==='443')&&['chatgpt.com','chat.openai.com'].includes(u.hostname),'Redirect host not allowed');}
  requireThat(!p.token_endpoint_auth_method||p.token_endpoint_auth_method==='none','Public PKCE client required');
  // Deterministic client ID avoids unlimited registration rows for identical callbacks.
  const id='client_'+hash(JSON.stringify([...p.redirect_uris].sort()));
  await app.store.put('client',id,{redirects:p.redirect_uris});
  return send(201,{client_id:id,redirect_uris:p.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
 }
 if(path==='/oauth/authorize'&&req.method==='GET'){
  await consumeConsentLimit(app,req);
  const p=Object.fromEntries(new URL(req.url,app.origin).searchParams),client=await app.store.get('client',p.client_id);
  requireThat(client&&client.redirects.includes(p.redirect_uri),'Unknown client or redirect');
  requireThat(p.response_type==='code'&&p.code_challenge_method==='S256'&&/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge),'PKCE S256 is required');
  requireThat(p.resource===resource&&(!p.scope||p.scope==='bot:manage'),'Invalid resource or scope');
  requireThat(typeof p.state==='string'&&p.state.length<=2048,'State required');
  const ticket=nonce();await app.store.put('consent',hash(ticket),{...p,expires:Date.now()+600000});
  return send(200,`<!doctype html><meta charset="utf-8"><title>Authorize BotlineMCP</title><h1>Connect your agent</h1><p>This authorizes the requesting client to manage bots, read allowed Telegram messages, send Telegram messages, and exchange private direct messages with logical agents. Enter your API KEY (configured as MCP_API_KEY). Every connected client has the same authority to manage this private relay and all its bot bindings. Logical agent handles identify message senders and recipients; they do not isolate permissions or create separate accounts. After authorization, your agent registers its own stable handle and display name through MCP, then sets up its main notification subscription. No agent identity entry is needed on this page. Never enter a Telegram bot token here. By submitting, you authorize this client to act with the privileges of the credential you enter.</p><p>Return to: ${escapeHtml(p.redirect_uri)}</p><form method="post" action="/oauth/authorize"><input type="hidden" name="ticket" value="${ticket}"><label>API KEY <input type="password" name="credential" autocomplete="off" required></label><button type="submit">Authorize</button></form>`,'text/html; charset=utf-8');
 }
 if(path==='/oauth/authorize'&&req.method==='POST'){
  await consumeConsentLimit(app,req);
  requireThat(req.headers.origin===app.origin,'Origin mismatch',403);
  const p=new URLSearchParams(await readBody(req,8192));
  const c=await app.store.take('consent',hash(p.get('ticket')??''));requireThat(c&&c.expires>Date.now(),'Consent request expired');
  const credential=p.get('credential')??'';
  const owner=await authenticate(app,{headers:{authorization:'Bearer '+credential}});
  const sessionId=nonce();
  // Compatibility only for consent forms opened before the handle field was removed.
  // New connections register their identity through agent_register after OAuth.
  const handle=p.get('agent_handle')?.trim();
  const agent=handle?await registerAgent(app,{owner,authType:'oauth',sessionId},{handle}):null;
  const code=nonce();await app.store.put('code',hash(code),{...c,owner,sessionId,agentId:agent?.agent_id??null,authVersion:await app.authVersion(owner),expires:Date.now()+60000});
  const location=new URL(c.redirect_uri);location.searchParams.set('code',code);location.searchParams.set('state',c.state);location.searchParams.set('iss',app.origin);
  res.statusCode=303;res.setHeader('Location',location.toString());return res.end();
 }
 if(path==='/oauth/token'&&req.method==='POST'){
  const p=Object.fromEntries(new URLSearchParams(await readBody(req,8192)));
  requireThat(p.resource===resource,'Invalid resource');let grant;
  if(p.grant_type==='authorization_code'){
   grant=await app.store.take('code',hash(p.code??''));
   requireThat(grant&&grant.expires>Date.now()&&grant.client_id===p.client_id&&grant.redirect_uri===p.redirect_uri&&grant.resource===resource,'Invalid authorization code');
   requireThat(typeof p.code_verifier==='string'&&/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier)&&same(createHash('sha256').update(p.code_verifier).digest('base64url'),grant.code_challenge),'PKCE verification failed');
  }else if(p.grant_type==='refresh_token'){
   grant=await app.store.take('refresh',hash(p.refresh_token??''));requireThat(grant&&grant.expires>Date.now()&&grant.client_id===p.client_id&&grant.resource===resource,'Invalid refresh token');
  }else requireThat(false,'Unsupported grant');
  requireThat(await app.ownerActive(grant.owner),'Instance authentication unavailable',403);
  if(grant.authVersion)requireThat(await app.authVersion(grant.owner)===grant.authVersion,'Credential rotated',401);
  const access=nonce(),refresh=nonce(),record={owner:grant.owner,client_id:grant.client_id,resource,authVersion:await app.authVersion(grant.owner),...(grant.sessionId?{sessionId:grant.sessionId}:{}),...(grant.agentId?{agentId:grant.agentId}:{})};
  await app.store.put('access',hash(access),{...record,expires:Date.now()+3600000});
  await app.store.put('refresh',hash(refresh),{...record,expires:Date.now()+30*86400000});
  return send(200,{access_token:access,token_type:'Bearer',expires_in:3600,refresh_token:refresh,scope:'bot:manage'});
 }
 requireThat(false,'Not found',404);
}

