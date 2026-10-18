import {hash,nonce,requireThat,same} from './security.js';
import {normalizeCursorApiKey,storeCursorKey,resolveGrokbotSession} from './grokbot.js';

// Agents are routing identities under one owner's shared authority, not accounts
// or independently authorized security principals. Handles let reconnections
// deliberately recover the same identity; client_id never identifies an agent.
export function normalizeAgentHandle(value){
 requireThat(typeof value==='string','Agent handle required');
 const handle=value.trim().toLowerCase();
 requireThat(/^[a-z0-9][a-z0-9._-]{1,63}$/.test(handle),'Agent handle must be 2–64 lowercase letters, digits, dots, underscores or hyphens');
 return handle;
}
// Grok Bot agents are addressed by the name shown in the Grok Bot app (BDK
// cursor-grokbot-agents). Recipients are those registered with grokbot_agent_name.
export function normalizeGrokbotAgentName(value){
 if(value===null)return null;
 requireThat(typeof value==='string','grokbot_agent_name must be a string or null');
 const name=value.trim();
 requireThat(name.length>=1&&name.length<=255&&!/[\u0000-\u001f\u007f]/.test(name),'grokbot_agent_name must be 1–255 characters without control characters');
 return name;
}
const publicAgent = record => ({agent_id:record.agentId,handle:record.handle,display_name:record.displayName,grokbot_agent_name:record.grokbotAgentName??null,bot_type:record.botType??null,created_at:record.created});
export async function getAgent(app,owner,agentId){
 const record=typeof agentId==='string'?await app.store.get('agent',agentId):null;
 return record?.owner===owner?publicAgent(record):null;
}
export async function listAgents(app,owner){
 return (await app.store.list('agent',owner)).map(publicAgent).sort((a,b)=>a.handle.localeCompare(b.handle));
}
export async function registerAgent(app,principal,args={},opts={}){
 requireThat(principal&&typeof principal.owner==='string','Authentication required',401);
 if(!(principal.authType==='api_key'||principal.authType==='oauth'&&principal.sessionId))throw Object.assign(new Error('Reconnect OAuth to register a logical agent'),{status:409,relayCode:'reconnect_required'});
 const handle=normalizeAgentHandle(args.handle);
 const botType=opts.botType??null;
 if(botType==='muse'){
  requireThat(handle!=='dot','Handle dot is reserved for the ChatGPT agent',409);
  requireThat(args.grokbot_agent_name===undefined||args.grokbot_agent_name===null,'muse agents do not use grokbot_agent_name',400);
 }
 const displayName=args.display_name===undefined?handle:args.display_name;
 requireThat(typeof displayName==='string'&&displayName.trim().length>0&&displayName.length<=128,'Display name must be 1–128 characters');
 const grokbotAgentName=args.grokbot_agent_name===undefined?undefined:normalizeGrokbotAgentName(args.grokbot_agent_name);
 const cursorApiKey=args.cursor_api_key===undefined?undefined:normalizeCursorApiKey(args.cursor_api_key);
 const agentId='agent_'+hash(JSON.stringify([principal.owner,handle]));
 if(cursorApiKey)await app.store.withLock('human:'+principal.owner,async store=>{await storeCursorKey(store,app,principal.owner,cursorApiKey);});
 let grokbotSessionId;
 if(grokbotAgentName){
  requireThat(!(await app.store.list('human',principal.owner)).some(h=>h.handle===handle),'Handle is already used by a human',409);
  grokbotSessionId=await resolveGrokbotSession(app,principal.owner,grokbotAgentName);
 }
 return app.store.withLock('human:'+principal.owner,async store=>{
 requireThat(!(await store.list('human',principal.owner)).some(h=>h.handle===handle),'Handle is already used by a human',409);
 const existingSession=principal.sessionId?await store.get('agent_session',principal.sessionId):null;
 const boundAgent=existingSession?.agentId??principal.agentId;
 requireThat(!boundAgent||boundAgent===agentId,'This session already has a different agent identity; reconnect to choose another handle',409);
 const agent_token=mintAgentToken(),tokenHash=hash(agent_token);
 const record={owner:principal.owner,agentId,handle,displayName:displayName.trim(),tokenHash,...(grokbotAgentName?{grokbotAgentName,grokbotSessionId}:{}),...(botType==='muse'?{botType:'muse'}:{}),created:new Date().toISOString()};
 const inserted=await store.insert('agent',agentId,record);
 if(!inserted){
  const existing=await store.get('agent',agentId);requireThat(existing?.owner===principal.owner,'Agent not found',404);
  if(botType&&existing.botType&&existing.botType!==botType)requireThat(false,'Handle is already registered as a different bot type',409);
  const updated={...existing,tokenHash};if(args.display_name!==undefined)updated.displayName=displayName.trim();
  if(botType==='muse')updated.botType='muse';
  if(grokbotAgentName!==undefined){
   if(grokbotAgentName===null){delete updated.grokbotAgentName;delete updated.grokbotSessionId;}
   else{updated.grokbotAgentName=grokbotAgentName;updated.grokbotSessionId=grokbotSessionId;}
  }
  await store.put('agent',agentId,updated);
 }
 if(principal.authType==='oauth'){
  await store.insert('agent_session',principal.sessionId,{owner:principal.owner,agentId});
  const linked=await store.get('agent_session',principal.sessionId);
  requireThat(linked?.owner===principal.owner&&linked.agentId===agentId,'This session already has a different agent identity; reconnect to choose another handle',409);
 }
 return {...await getAgent({store},principal.owner,agentId),agent_token};
 });
}
const mintAgentToken=()=>'mcp_at_'+nonce();
export const callerTokenProperty={type:'string',minLength:16,maxLength:128,description:'Your per-agent secret from agent_register or agent_token_rotate. Shown once. Store it; never post it in chat.'};
export async function getAgentByToken(app,owner,token){
 if(typeof token!=='string'||token.trim()==='')return null;
 const tokenHash=hash(token.trim());
 const record=(await app.store.list('agent',owner)).find(a=>typeof a.tokenHash==='string'&&same(a.tokenHash,tokenHash));
 return record?.owner===owner?publicAgent(record):null;
}
export async function rotateAgentToken(app,principal){
 requireThat(principal&&typeof principal.owner==='string'&&typeof principal.agentId==='string','Authentication required',401);
 const agent_token=mintAgentToken();
 return app.store.withLock('human:'+principal.owner,async store=>{
  const existing=await store.get('agent',principal.agentId);
  requireThat(existing?.owner===principal.owner,'Unknown agent identity',403);
  await store.put('agent',principal.agentId,{...existing,tokenHash:hash(agent_token)});
  return {...publicAgent(existing),agent_token};
 });
}
export async function resolveCallerAgent(app,principal,args={},{optional=false}={}){
 requireThat(principal&&typeof principal.owner==='string','Authentication required',401);
 let fromToken=null;
 if(typeof args?.agent_token==='string'&&args.agent_token.trim()!==''){
  fromToken=await getAgentByToken(app,principal.owner,args.agent_token);
  requireThat(fromToken,'Unknown or revoked agent token',404);
 }
 if(principal.authType==='oauth'){
  if(principal.agentId){
   const fromOauth=await getAgent(app,principal.owner,principal.agentId);
   requireThat(fromOauth,'Unknown agent identity',403);
   requireThat(!fromToken||fromToken.agent_id===fromOauth.agent_id,'Agent token does not match this OAuth session',403);
   return fromOauth;
  }
  requireThat(!fromToken,'Agent token cannot override an OAuth session; call agent_register',403);
  if(optional)return null;
  requireThat(false,'This OAuth session has no registered agent. Call agent_register.',409);
 }
 if(fromToken)return fromToken;
 if(principal.agentId){
  const agent=await getAgent(app,principal.owner,principal.agentId);
  requireThat(agent,'Unknown agent identity',403);
  return agent;
 }
 if(optional)return null;
 requireThat(false,'Pass agent_token on this tool call, or send X-MCP-Agent-ID',400);
}
