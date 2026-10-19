import {SUPPORTED_VERSIONS,SERVER_INFO,STREAMABLE_HTTP_VERSION,prepareProtocol,instrumentProtocol,usesModernEnvelope,writeGetSse,writeMcpResponse,modernResult} from './protocol.js';
import {tryLanding,tryMcpGuide,SETUP_GUIDE} from './landing.js';
import {INSTANCE_ID} from './config.js';
import {authenticatePrincipal,oauth} from './oauth.js';
import {registerAgent,listAgents,getAgent,resolveCallerAgent,rotateAgentToken,callerTokenProperty} from './agents.js';
import {Attachments,attachmentTools,ATTACHMENT_POLICY} from './attachments.js';
import {Dms,dmTools,dmEvents} from './dms.js';
import {isDotInboxAgent} from './dot-inbox.js';
import {isMuseAgent} from './muse-inbox.js';
import {BotBindings} from './bots.js';
import {listHumans} from './telegram-owner.js';
import {registerHuman} from './human-change.js';
import {telegramHumanAllowed,telegramSenderAllowed} from './telegram-policy.js';
import {RelayErrors,relayErrorDetails} from './relay-errors.js';
import {settings} from './settings.js';
import {DENIED_REPLY_POLICY} from './denied-replies.js';
import { hash,nonce,same,seal,unseal,signingKey,signedHeaders,callbackPost,requireThat } from './security.js';
import {grokbotDeliver,setCursorKey,clearCursorKey} from './grokbot.js';
import {holdInboundReactions} from './telegram-reactions.js';
const DAY=86400000;
const serviceDescription='Private single-instance-key, agent-first Telegram bridge. Give MCP_API_KEY only to trusted agent software; anyone holding it has full instance authority. Agents retain their own bot token and recovery configuration in a secure persistent vault and bind directly with telegram_bot_bind. Access is the human registry, not per-bot allowlists. Call human_register once; that human may DM every bound bot. Do not call it per bot. Do not use telegram_whitelist_update (retired). Minimize user friction: after necessary authorization, agents handle binding, registration and recovery. Link-only server forms are disabled. Keep an independent backup; database loss or lost keys can make stored credentials unrecoverable.';
const agentInstructions='Public setup guide: resolve /setup.md on the same origin as this MCP endpoint. Choose an existing instance or self-host; then authenticate and select a receiving capability. The authoritative guide follows.\n\n'+SETUP_GUIDE;
const string={type:'string'};
const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const identity=schema({bot_id:string});
const bindSchema={...schema({existing_bot_id:{type:'string',pattern:'^[1-9][0-9]*$',description:'Migrate or repair this instance’s existing unassigned/current-handle bot using its server-stored encrypted token. Mutually exclusive with token. Preserves legacy listeners; requires explicit owner approval to associate the handle and update webhook events. Existing-bot mode still uses the stored token.'},token:{type:'string',description:'Secret bot credential. Use only with secure agent-side credential injection; never paste in chat. Rebind still rotates the token.'},agent_token:callerTokenProperty},[]),oneOf:[{required:['token']},{required:['existing_bot_id']}]};
function parseBotType(value){
 if(value===undefined)return null;
 requireThat(typeof value==='string'&&(value==='dot'||value==='grokbot'||value==='muse'),'X-MCP-Bot-Type must be dot, grokbot or muse',400);
 return value;
}
function registeredBotType(agent){if(isMuseAgent(agent))return 'muse';return isDotInboxAgent(agent)?'dot':'grokbot';}
function callerIdentityArgs(name,args={}){
 if(name==='agent_register'||name==='telegram_send_message')return null;
 if(name==='agent_whoami')return {args,optional:true};
 return {args};
}
export const tools=[
  {name:'agent_register',description:'Register your stable logical agent handle and display_name through the authenticated connection. Returns agent_token once; store it and pass it on later tool calls. Never post it in chat. OAuth consent never asks for an agent handle. Verify agent_whoami and refresh authenticated tools/list. Dot uses exactly handle dot without a grokbot_agent_name destination, then one agent.notification subscription with empty arguments: on inbox.ready, pull messages_inbox and ACK only processed messages. Other webhook agents subscribe once; Grok Bot destinations must not subscribe because delivery goes directly to their Cursor session. Muse clients send X-MCP-Bot-Type: muse and register their own handle (never dot, never with grokbot_agent_name); they poll messages_inbox on a schedule instead of subscribing. Repeating the same handle issues a fresh agent_token and invalidates the previous one; an explicit display_name or grokbot_agent_name also updates those fields without changing identity. A legacy OAuth connection must reconnect once to establish a distinct grant lineage. For a Grok Bot, pass grokbot_agent_name exactly as shown in the Grok Bot app, and cursor_api_key on the first registration for this Cursor account. Ask the owner before sending cursor_api_key. The key is write-only and is never returned.',inputSchema:schema({handle:{type:'string',minLength:2,maxLength:64,pattern:'^[A-Za-z0-9._-]+$'},display_name:{type:'string',maxLength:128},grokbot_agent_name:{type:['string','null'],maxLength:255,description:'Optional Grok Bot agent name exactly as shown in the Grok Bot app. When set, inbound private DMs are sent to that Grok Bot through api.cursor.com. Registration resolves and caches the session id. Repeat registration to change it; null clears it.'},cursor_api_key:{type:'string',minLength:16,maxLength:512,description:'Cursor API key for this Cursor account. Write-only; never returned or logged. Ask the owner before sending. Required the first time this account registers a Grok Bot name.'}},['handle']),annotations:{readOnlyHint:false,idempotentHint:false}},
  {name:'agent_token_rotate',description:'Issue a new agent_token for this agent and invalidate the previous one. The new token is shown once. Store it; never post it in chat. Pass your current agent_token.',inputSchema:schema({agent_token:callerTokenProperty},[]),annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false}},
  {name:'cursor_key_set',description:'Replace the stored Cursor API key for this instance. Write-only; the key is never returned. Ask the owner before sending. Cached Grok Bot session ids are cleared so the next delivery resolves them again. Pass your agent_token.',inputSchema:schema({cursor_api_key:{type:'string',minLength:16,maxLength:512},agent_token:callerTokenProperty},['cursor_api_key']),annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true}},
  {name:'cursor_key_clear',description:'Remove the stored Cursor API key for this instance. Grok Bot delivery fails until a key is stored again with cursor_key_set or agent_register. Pass your agent_token.',inputSchema:schema({agent_token:callerTokenProperty},[]),annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true}},
  {name:'agents_list',description:'List logical agents in this owner’s private relay. These are routing identities within shared instance authority. Pass your agent_token.',inputSchema:schema({agent_token:callerTokenProperty},[]),annotations:{readOnlyHint:true}},
  {name:'human_register',description:'Register a human with one confirmed Telegram user ID, unique across human handles. agent_token identifies you. human is the human handle. Call it once; that human may DM every bound bot. Actual changes to existing humans require a five-minute code sent to exactly one existing different-type agent. Repeat identical arguments with challenge_id and confirmation_code; that agent must show the code only to the human, never relay it directly. Identical requests and first registration do not need a code. This depends on agent compliance, not server-guaranteed human approval. ID replacement also requires replace_telegram_user_id equal to the current ID. Requires explicit human identity confirmation. Does not create credentials and does not enroll per bot. Read human mappings through telegram_bot_get. Pass your agent_token.',inputSchema:schema({agent_token:callerTokenProperty,challenge_id:{type:'string',description:'Returned challenge ID for an existing-human change.'},confirmation_code:{type:'string',description:'One-use code obtained by the human from the other-type agent, valid for five minutes. Never retrieve it automatically from another agent.'},human:{type:'string',minLength:2,maxLength:64,description:'Human handle to register.'},display_name:{type:'string',maxLength:128},telegram_user_id:{type:'string',pattern:'^[1-9][0-9]*$'},replace_telegram_user_id:{type:'string',pattern:'^[1-9][0-9]*$'}},['human','telegram_user_id']),annotations:{readOnlyHint:false,idempotentHint:true}},
  ...dmTools,
  ...attachmentTools,
  {name:'telegram_bot_get',description:'Read the current handle’s single Telegram bot, connection state and the shared humans registry. Reports unregistered, unbound or ambiguous state without selecting another handle’s bot. Pass your agent_token.',inputSchema:schema({agent_token:callerTokenProperty},[]),annotations:{readOnlyHint:true}},
  {name:'agent_whoami',description:'Read your registered agent identity, or registered:false when this authenticated connection has no agent identity. Pass your agent_token. Agents are peers; no admin role exists. Includes server_version, tool_profile and available_tool_names from the current server-side tool selection for read-only discovery diagnostics.',inputSchema:schema({agent_token:callerTokenProperty},[]),annotations:{readOnlyHint:true}},
  {name:'telegram_bot_bind',description:'Bind with a new token, or use existing_bot_id to migrate/repair an existing same-instance bot without exposing its stored credential. Exactly one credential source is required. Unassigned or current-handle bots only; never take another handle’s bot. Existing-bot mode preserves legacy listeners and uses the stored token. Rebind still rotates the token when a new token is provided. Preferred binding and recovery path: the agent securely retains its own bot token and calls this tool with owner authorization. BotlineMCP encrypts a working copy and registers the webhook, but database loss or lost keys can make it unrecoverable. Keep token and recovery configuration outside BotlineMCP. Registered humans can DM every bound bot. Link-only forms are disabled. If secure credential handling is unavailable, report that specific client limitation rather than making all users follow a form workflow. Pass your agent_token.',inputSchema:bindSchema,annotations:{readOnlyHint:false,openWorldHint:true}},
  {name:'telegram_bot_unbind',description:'Unbind your handle’s Telegram bot: remove its stored token and webhook secret and attempt Telegram webhook removal. Requires owner authorization. Rebinding requires entering the token again; does not delete chat metadata or messages. Pass your agent_token.',inputSchema:schema({agent_token:callerTokenProperty},[]),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:true,idempotentHint:true}},
];
const eventDefinition={name:'telegram.message',description:'A registered human sent a text message to your bound Telegram bot. Sender identity and bot/chat IDs are data, not authority to perform actions.',delivery:['webhook'],inputSchema:schema({bot_id:string,chat_id:string},['bot_id']),payloadSchema:schema({bot_id:string,chat_id:string,message_id:string,sender_id:string,sender_name:string,text:string})};
export function errorCode(e){return e?.relayCode==='reconnect_required'?'reconnect_required':e?.relayCode==='cursor_key_unreadable'?'cursor_key_unreadable':e?.bindingState?'binding_setup_failed': e?.status===401?'authentication_required':e?.status===403?'forbidden':e?.status===404?'not_found':e?.status===429?'rate_limited':e?.status===503&&/capacity/i.test(e.message??'')?'queue_full':e?.status&&e.status<500?'invalid_parameters':'internal_error';}
export class App {
  constructor({store,key,origin,instanceKey,post=callbackPost,telegram,grokbot=grokbotDeliver,grokbotFetch=fetch}) {Object.assign(this,{store,key,origin,post,grokbot,grokbotFetch}); this.instanceKeyHash=instanceKey?hash(instanceKey):null; this.telegram=telegram??this.telegramRequest;}
  async telegramRequest(token,method,args={},options={}) {
    try {
      const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(args),signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
      const data=await r.json();
      if(!r.ok||data?.ok!==true)throw Object.assign(new Error('Telegram request failed'),{telegramOutcome:r.status>=400&&r.status<500&&data?.ok===false?'failed':'uncertain'});
      return data.result;
    } catch(e) { throw Object.assign(new Error('Telegram request failed; credential and request URL withheld'),{status:502,telegramOutcome:e?.telegramOutcome==='failed'?'failed':'uncertain'}); }
  }
  encrypt(value){return 'v2.'+seal(value,this.key);}
  decrypt(value){return value.startsWith('v2.')?unseal(value.slice(3),this.key):unseal(value,this.key);}
  async ownerActive(owner) { return owner===INSTANCE_ID && !!this.instanceKeyHash; }
  async authVersion(owner) {return owner===INSTANCE_ID?this.instanceKeyHash:null;}
  async own(owner,id) {const bot=await this.store.get('bot',id);requireThat(bot?.owner===owner,'Bot not found',404);return bot;}
  view(bot) {return {bot_id:bot.id,username:bot.username,active:bot.active};}
  async bind(owner,args,{agentId,bindingRoute,expectedBotId,bindingDiagnostic,migration}={}) {
    if(agentId){const result=await new BotBindings(this).bind(owner,args,{agentId,bindingDiagnostic,migration});return result;}
    requireThat(typeof args.token==='string' && /^\d+:[A-Za-z0-9_-]{20,}$/.test(args.token),'Invalid bot token format');
    if(bindingDiagnostic)bindingDiagnostic.stage='telegram_identity';
    const me=await this.telegram(args.token,'getMe'); requireThat(me.is_bot,'Not a bot credential');
    requireThat(String(me.id)===args.token.split(':')[0]&&(!expectedBotId||String(me.id)===expectedBotId),'Telegram bot identity mismatch',409);
    if(bindingDiagnostic)bindingDiagnostic.stage='binding_storage';
    const id=String(me.id),old=await this.store.get('bot',id);
    if(bindingDiagnostic)bindingDiagnostic.stage='binding_validation';
    requireThat(!old || old.owner===owner,'Bot is already bound to another agent',409);
    if(bindingDiagnostic)bindingDiagnostic.stage='webhook_inspection';
    const target=`${this.origin}/telegram/${id}`, info=await this.telegram(args.token,'getWebhookInfo');
    if(migration){
      if(bindingDiagnostic)bindingDiagnostic.stage='migration_recheck';
      requireThat(migration.botId===id&&migration.target===target&&migration.expires>Date.now()&&same(migration.fingerprint,hash(this.key+':webhook:'+info.url)),'Migration context changed; confirm again',409);
    }else if(info.url&&info.url!==target){
      if(bindingDiagnostic){
        bindingDiagnostic.stage='foreign_webhook';
        let host='unavailable';try{host=new URL(info.url).host;}catch{}
        bindingDiagnostic.preview={botId:id,target,host,fingerprint:hash(this.key+':webhook:'+info.url)};
      }
      requireThat(false,'Bot webhook belongs to another service; explicit migration confirmation required',409);
    }
    if(bindingDiagnostic)bindingDiagnostic.stage='binding_storage';
    let bot={id,owner,username:me.username,token:this.encrypt(args.token),hookSecret:old?.hookSecret??nonce(),active:false};
    if (!old) requireThat(await this.store.insert('bot',id,bot),'Concurrent binding; retry',409);
    else await this.store.put('bot',id,bot);
    if(bindingRoute)await this.store.put('group_bot',id,bindingRoute);
    if(bindingDiagnostic)bindingDiagnostic.stage='webhook_write';
    await this.telegram(args.token,'setWebhook',{url:target,secret_token:bot.hookSecret,allowed_updates:['message','my_chat_member'],drop_pending_updates:false});
    if(bindingDiagnostic)bindingDiagnostic.stage='webhook_written';
    if(migration){
      if(bindingDiagnostic)bindingDiagnostic.stage='webhook_verification';
      const observed=await this.telegram(args.token,'getWebhookInfo');
      requireThat(observed.url===target,'Migration webhook verification failed',502);
    }
    bot.active=true;
    await this.store.put('bot',id,bot);
    return this.view(bot);
  }
  async invoke(owner,name,args={},principal={owner,agentId:null},botType=null) {
    requireThat(args&&typeof args==='object'&&!Array.isArray(args));
    if(name==='telegram_bot_get')return {...await new BotBindings(this).current(owner,principal.agentId,{required:false}),humans:await listHumans(this,owner)};
    if(name==='telegram_bot_bind')name='bot_bind';
    if(name==='telegram_bot_unbind'){const bindings=new BotBindings(this);await bindings.actor(owner,principal.agentId);const current=await bindings.current(owner,principal.agentId,{required:false});return current.bot?bindings.unbind(owner,principal.agentId,current.bot.bot_id):{unbound:true,bot_id:null};}
    if(name==='human_register'){
      const bindings=new BotBindings(this);await bindings.actor(owner,principal.agentId);
      return registerHuman(this,principal,args);
    }
    if(['invite_create','invite_list','invite_revoke','agent_list','agent_disable'].includes(name))requireThat(false,'Invitations and per-agent accounts are retired; use the instance key.',410);
    if(['telegram_whitelist_update','bot_access_update','bot_access_get'].includes(name))requireThat(false,'Per-bot allowlists are retired; use human_register.',410);
    if(name==='agent_whoami'){const agent=principal.agentId?await getAgent(this,owner,principal.agentId):null;const available_tool_names=(await this.availableTools(principal,botType)).map(t=>t.name),tool_profile=!principal.agentId?'bootstrap':isMuseAgent(agent)?'muse':available_tool_names.includes('messages_inbox')?'dot':'bot';return {...(agent?{registered:true,...agent}:{registered:false,agent_id:null}),server_version:'0.6.23',tool_profile,available_tool_names};}
    if(name==='agent_register')return registerAgent(this,principal,args,{botType});
    if(name==='agent_token_rotate')return rotateAgentToken(this,principal);
    if(name==='cursor_key_set')return setCursorKey(this,principal,args);
    if(name==='cursor_key_clear')return clearCursorKey(this,principal);
    if(name==='agents_list')return {agents:await listAgents(this,owner)};
    if(name==='attachments_upload')return new Attachments(this).upload(principal,args);
    if(name==='attachments_read')return new Attachments(this).read(principal,args.attachment_id);
    if(dmTools.some(t=>t.name===name))return new Dms(this).invoke(principal,name,args);
    if(name==='bot_list')return new BotBindings(this).list(owner);
    if(name==='bot_begin_binding')requireThat(false,'Link-only binding has been retired. Use authenticated bot_bind.',410);
    if(name==='bot_bind'){await new BotBindings(this).actor(owner,principal.agentId);return this.bind(owner,args,{agentId:principal.agentId});}
    if(name==='bot_unbind')return new BotBindings(this).unbind(owner,principal.agentId,args.bot_id);
    if(name==='delivery_retry')requireThat(false,'Use ordinary messaging/subscription operations; no public retry tool is exposed',410);
    if(name==='__delivery_retry_internal') {await this.dispatch(owner);await new Dms(this).dispatch(owner);const telegram_pending=(await this.store.list('delivery',owner)).filter(d=>d.state==='pending').length,dm_pending=(await this.store.list('group_delivery',owner)).filter(d=>d.state==='pending').length;return {pending:telegram_pending+dm_pending,telegram_pending,dm_pending};}
    requireThat(name==='telegram_send_message','Unknown tool',404);
    requireThat(!(await this.store.get('group_bot',args.bot_id)),'Use messages_send for this bound bot',410);
    requireThat(!['attachment_id','attachment_principal','attachmentPayload'].some(k=>Object.hasOwn(args,k)),'Use messages_send for attachments',400);
    return this.sendTelegram(owner,args);
  }
  async sendTelegram(owner,args) {
    const bot=await this.own(owner,args.bot_id);
    requireThat(bot.active&&telegramHumanAllowed(await listHumans(this,owner),args.chat_id),'Chat not allowed',403);
    requireThat(typeof args.text==='string'&&(args.text.length>0||args.attachment_id)&&args.text.length<=(args.attachment_id?1024:4096)&&typeof args.request_id==='string'&&/^[\w-]{8,128}$/.test(args.request_id),'Invalid message or request_id');
    const id=hash(`${owner}:${args.request_id}`), fingerprint=hash(JSON.stringify([bot.id,args.chat_id,args.text,...(args.attachment_id?[args.attachment_id]:[])]));
    if(!await this.store.insert('send',id,{owner,fingerprint,state:'uncertain',created:Date.now()})) {
      const prev=await this.store.get('send',id);requireThat(prev.fingerprint===fingerprint,'request_id reused for different content',409);return prev.result??{status:'uncertain',instruction:'Check Telegram manually; do not resend with a new request_id.'};
    }
    let message;
    if(args.attachment_id){
      await new Attachments(this).inspect(args.attachment_principal,args.attachment_id);
      const {record,bytes}=args.attachmentPayload;
      const image=record.mime.startsWith('image/'),method=image?'sendPhoto':'sendDocument',field=image?'photo':'document';
      const form=new FormData();form.set('chat_id',args.chat_id);if(args.text)form.set('caption',args.text);form.set(field,new Blob([bytes],{type:record.mime}),record.name);
      try{const response=await (this.attachmentFetch??fetch)('https://api.telegram.org/bot'+this.decrypt(bot.token)+'/'+method,{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(15000)});const body=await response.json();requireThat(response.ok&&body.ok,'Telegram media send failed');message=body.result;}catch{return {status:'uncertain',instruction:'Attachment send outcome uncertain; check Telegram manually. Reuse request_id; never retry with a new ID.'};}
    }else message=await this.telegram(this.decrypt(bot.token),'sendMessage',{chat_id:args.chat_id,text:args.text});
    const result={status:'sent',message_id:String(message.message_id)};await this.store.put('send',id,{owner,fingerprint,state:'sent',result,created:Date.now()});return result;
  }
  subIdentity(owner,p) {
    requireThat(p.name==='telegram.message'&&p.arguments&&typeof p.arguments.bot_id==='string'&&(!p.arguments.chat_id||typeof p.arguments.chat_id==='string'),'Invalid event filter');
    requireThat(Object.keys(p.arguments).every(k=>['bot_id','chat_id'].includes(k)),'Unknown filter');
    requireThat(p.delivery?.mode==='webhook'&&typeof p.delivery.url==='string','Webhook delivery required');
    return hash(JSON.stringify([owner,p.delivery.url,p.name,p.arguments.bot_id,p.arguments.chat_id??null]));
  }
  async subscribe(owner,p) {
    const id=this.subIdentity(owner,p),bot=await this.own(owner,p.arguments.bot_id);requireThat(bot.active,'Bot is inactive');
    if(p.arguments.chat_id) requireThat(telegramHumanAllowed(await listHumans(this,owner),p.arguments.chat_id),'Chat not allowed',403);
    signingKey(p.delivery.secret);
    const challenge=nonce(),body=JSON.stringify({type:'verification',challenge});
    let r;try {r=await this.post(p.delivery.url,signedHeaders(p.delivery.secret,id,`verify_${nonce()}`,body),body);}catch{throw Object.assign(new Error('Callback verification failed'),{rpcCode:-32015,reason:'connection_failed'});}
    let echoed;try{echoed=JSON.parse(r.body).challenge;}catch{}
    requireThat(r.status>=200&&r.status<300&&same(challenge,echoed),'Callback challenge failed');
    requireThat(p.ttlMs===undefined||p.ttlMs===null||(Number.isFinite(p.ttlMs)&&p.ttlMs>0),'Invalid ttlMs');
    const ttl=Math.min(p.ttlMs??DAY,7*DAY),expires=Date.now()+ttl;
    const old=await this.store.get('subscription',id);
    const sub={id,owner,botId:bot.id,chatId:p.arguments.chat_id??null,url:p.delivery.url,secret:this.encrypt(p.delivery.secret),expires};
    if(old && this.decrypt(old.secret)!==p.delivery.secret) {sub.oldSecret=old.secret;sub.rotateUntil=Date.now()+60000;}
    await this.store.put('subscription',id,sub);
    return {id,refreshBefore:new Date(expires).toISOString(),cursor:null,truncated:false};
  }
  async actingPrincipal(principal,p,botType){
    const identity=callerIdentityArgs(p.name,p.arguments);
    if(!identity)return principal;
    const agent=await resolveCallerAgent(this,principal,identity.args??{},{optional:!!identity.optional});
    if(!agent)return principal;
    requireThat(!botType||registeredBotType(agent)===botType,'Agent handle does not match X-MCP-Bot-Type',403);
    return {...principal,agentId:agent.agent_id};
  }
  async rpc(owner,method,p={},principal={owner,agentId:null},botType=null) {
    let acting=principal;
    try{
      if(method==='tools/call'&&(tools.some(t=>t.name===p.name)||p.name==='telegram_send_message'))acting=await this.actingPrincipal(principal,p,botType);
      const result=await this.rpcCall(owner,method,p,acting,botType);
      if(owner&&acting?.agentId&&!['tools/list','events/list'].includes(method))try{await new RelayErrors(this).dispatch(owner);}catch{}
      return result;
    }catch(error){
      const code=method==='events/subscribe'?'subscription_failed':errorCode(error);error.details=relayErrorDetails(code);
      if(acting?.agentId&&(method==='events/subscribe'||!error.status||error.status>=500))try{error.details=await new RelayErrors(this).report({owner,agentId:acting.agentId,code});}catch{error.details={...error.details,notification:{agent:'unavailable',telegram:'unavailable'}};}
      if(error.bindingState)error.details={...error.details,binding:error.bindingState};
      throw error;
    }
  }
  async availableTools(principal,botType=null){
    if(botType){
      const excluded=(botType==='dot'||botType==='muse')?['cursor_key_set','cursor_key_clear']:['messages_inbox','messages_ack'];
      return tools.filter(t=>!excluded.includes(t.name));
    }
    if(!principal?.agentId)return tools;
    requireThat(await this.ownerActive(principal.owner),'Authentication required',401);
    const agent=await getAgent(this,principal.owner,principal.agentId);
    requireThat(agent,'Unknown agent identity',403);
    // Applicability under shared instance authority, never client-selected roles.
    const excluded=(isDotInboxAgent(agent)||isMuseAgent(agent))?['cursor_key_set','cursor_key_clear']:['messages_inbox','messages_ack'];
    return tools.filter(t=>!excluded.includes(t.name));
  }
  async rpcCall(owner,method,p={},principal={owner,agentId:null},botType=null) {
    if(method==='initialize')return {protocolVersion:STREAMABLE_HTTP_VERSION,capabilities:{tools:{}},serverInfo:SERVER_INFO,instructions:agentInstructions};
    if(method==='ping')return {};
    if(method==='server/discover')return {resultType:'complete',supportedVersions:SUPPORTED_VERSIONS,capabilities:{tools:{},events:{}},_meta:{'io.modelcontextprotocol/serverInfo':SERVER_INFO},instructions:agentInstructions,serverInfo:{...SERVER_INFO,description:serviceDescription}};
    if(method==='tools/list')return {tools:await this.availableTools(principal,botType)};
    if(method==='events/list')return {events:[eventDefinition,...dmEvents]};
    if(['events/subscribe','events/unsubscribe'].includes(method)&&dmEvents.some(e=>e.name===p.name))return new Dms(this).subscription(principal,p,method==='events/unsubscribe');
    if(method==='events/subscribe')return this.subscribe(owner,p);
    if(method==='events/unsubscribe') {await this.store.delete('subscription',this.subIdentity(owner,p));return {};}
    if(method==='tools/call') {
      requireThat(tools.some(t=>t.name===p.name)||p.name==='telegram_send_message','Unknown or retired tool',404);
      if(p.name!=='telegram_send_message')requireThat((await this.availableTools(principal)).some(t=>t.name===p.name),'Tool is unavailable for this agent profile; refresh tools/list after registration or identity changes',403);
      const r=await this.invoke(owner,p.name,p.arguments,principal,botType);if(p.name==='attachments_read')return r;return {content:[{type:'text',text:JSON.stringify(r)}],structuredContent:r};
    }
    throw Object.assign(new Error('Method not found'),{rpcCode:-32601});
  }
  async receive(botId,secret,update) {
    const bot=await this.store.get('bot',botId);requireThat(bot&&same(secret,bot.hookSecret),'Unauthorized webhook',403);
    if(!bot.active)return true;
    if(!update||Array.isArray(update)||!Number.isSafeInteger(update.update_id)||update.update_id<0)return true;
    if(update.my_chat_member)return true;
    const humans=await listHumans(this,bot.owner);
    const m=update.message,positive=id=>Number.isSafeInteger(id)&&id>0;
    if(!m||typeof m.from?.is_bot!=='boolean'||!positive(m.from?.id)||!Number.isSafeInteger(m.chat?.id)||m.chat.id===0||!positive(m.message_id)||!(typeof m.text==='string'&&m.text.length||m.photo||m.document||m.video||m.audio||m.voice||m.sticker||m.animation)||!Number.isSafeInteger(m.date)||m.date<0||!Number.isFinite(new Date(m.date*1000).getTime())||!['private','group','supergroup'].includes(m.chat.type))return true;
    if(m.chat.type!=='private')return true;
    const senderId=String(m.from.id),chatId=String(m.chat.id),receiptId=`${botId}:${update.update_id}`;
    const existing=await this.store.get('update',receiptId);
    if(existing?.denied||existing?.completed)return true;
    if(!telegramSenderAllowed(m,humans)) {
      if(m.sender_chat||m.from.is_bot||chatId!==senderId)return true;
      const now=Date.now(),messageTime=m.date*1000;
      // A receipt may be pruned after its retention window. Old denied updates
      // must remain ineligible even without that receipt; future dates fail closed.
      if(now-messageTime>=DENIED_REPLY_POLICY.receiptTtl||messageTime>now+60000)return true;
      if(await this.store.reserveDeniedReply(botId,update.update_id,senderId,chatId)) {
        // Fixed unregistered-DM guidance cannot echo user content, grant access,
        // or invoke agent callbacks.
        try {await this.telegram(this.decrypt(bot.token),'sendMessage',{chat_id:chatId,text:`你还没有注册。你的 Telegram ID 是 ${senderId}，请把它发给 agent 完成注册。`,reply_parameters:{message_id:m.message_id,allow_sending_without_reply:true}});}catch{}
      }
      return true;
    }
    const groupRoute=await this.store.get('group_bot',botId);
    if(groupRoute?.owner===bot.owner){
      if(m.chat.type!=='private')return true;
      // A legacy receipt owns this update even during a route cutover. Some of
      // its callbacks may already have succeeded; never re-emit it as a DM.
      // The switched bot's remaining legacy deliveries are cancelled.
      if(existing){await this.dispatch(bot.owner,existing.event.eventId);await this.store.put('update',receiptId,{owner:bot.owner,event:{eventId:existing.event.eventId},subscriptionIds:[],completed:true,created:existing.created});return true;}
      await new Dms(this).receiveTelegram({...bot,groupAgentId:groupRoute.agentId,bindingId:groupRoute.bindingId},m,update.update_id);return true;
    }
    // First persist receipt+its subscription snapshot so a crash/retry cannot add subscribers retroactively.
    if(!existing) {
      const subs=(await this.store.list('subscription',bot.owner)).filter(s=>s.botId===botId&&s.expires>Date.now()&&(!s.chatId||s.chatId===String(m.chat.id)));
      const event={eventId:`tg_${botId}_${update.update_id}`,name:'telegram.message',timestamp:new Date(m.date*1000).toISOString(),data:{bot_id:botId,chat_id:String(m.chat.id),message_id:String(m.message_id),sender_id:String(m.from.id),sender_name:[m.from.first_name,m.from.last_name].filter(Boolean).join(' '),text:m.text??((m.caption??'')+'\n[Attachment unsupported on legacy Telegram subscriptions; register and bind an agent handle.]')},cursor:null};
      await this.store.insert('update',receiptId,{owner:bot.owner,event,subscriptionIds:subs.map(s=>s.id),created:Date.now()});
    }
    const receipt=await this.store.get('update',receiptId);
    if(receipt.denied||receipt.completed)return true;
    for(const sid of receipt.subscriptionIds) await this.store.insert('delivery',`${receiptId}:${sid}`,{owner:bot.owner,subscriptionId:sid,event:receipt.event,state:'pending',attempts:0,next:0,leaseUntil:0});
    await this.dispatch(bot.owner,receipt.event.eventId);
    const complete=!(await this.store.list('delivery',bot.owner)).some(d=>d.event.eventId===receipt.event.eventId&&d.state==='pending');
    if(complete)await this.store.put('update',receiptId,{owner:bot.owner,event:{eventId:receipt.event.eventId},subscriptionIds:[],completed:true,created:receipt.created});
    return complete;
  }
  async dispatch(owner,eventId) {
    const pending=(await this.store.list('delivery',owner)).filter(d=>d.state==='pending'&&(!eventId||d.event.eventId===eventId));
    for(const candidate of pending.slice(0,4)) {
      if(candidate.next>Date.now())continue;
      const d=await this.store.lease('delivery',candidate.id);if(!d)continue;d.id=candidate.id;
      const sub=await this.store.get('subscription',d.subscriptionId),bot=sub&&await this.store.get('bot',sub.botId);
      const humans=await listHumans(this,owner);
      if(!sub||sub.expires<=Date.now()||!bot?.active||await this.store.get('group_bot',sub?.botId)||!await this.ownerActive(owner)||!telegramHumanAllowed(humans,d.event.data.sender_id)||!telegramHumanAllowed(humans,d.event.data.chat_id)) {d.state='cancelled';d.event={eventId:d.event.eventId};await this.store.put('delivery',d.id,d);continue;}
      const body=JSON.stringify(d.event);let status=0;
      if(Buffer.byteLength(body)>262144)status=413;
      else try {
        const headers=signedHeaders(this.decrypt(sub.secret),sub.id,d.event.eventId,body);
        if(sub.oldSecret&&sub.rotateUntil>Date.now()) headers['webhook-signature']+=' '+signedHeaders(this.decrypt(sub.oldSecret),sub.id,d.event.eventId,body,Number(headers['webhook-timestamp']))['webhook-signature'];
        status=(await this.post(sub.url,headers,body)).status;
      }catch{}
      d.attempts++;d.lastStatus=status;d.leaseUntil=0;
      if(status>=200&&status<300)d.state='accepted';
      else if(status===410||status===413||(status>=400&&status<500&&status!==429)||d.attempts>=8)d.state='failed';
      else d.next=Date.now()+Math.min(300000,1000*2**d.attempts);
      if(d.state!=='pending')d.event={eventId:d.event.eventId};
      await this.store.put('delivery',d.id,d);
    }
  }
}
export async function readBody(req,max=65536) {
  if(req.body!==undefined){const raw=typeof req.body==='string'?req.body:Buffer.isBuffer(req.body)?req.body.toString('utf8'):(req.headers['content-type']??'').includes('application/x-www-form-urlencoded')?new URLSearchParams(req.body).toString():JSON.stringify(req.body);requireThat(Buffer.byteLength(raw)<=max,'Request too large',413);return raw;}
  let raw='';for await(const chunk of req){raw+=chunk;requireThat(Buffer.byteLength(raw)<=max,'Request too large',413);}return raw;
}
export function handler(app) {
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','strict-origin');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self' https://chatgpt.com https://chat.openai.com; frame-ancestors 'none'; base-uri 'none'");
  const send=(status,data,type='application/json')=>{res.statusCode=status;res.setHeader('Content-Type',type);res.end(type==='application/json'?JSON.stringify(data):data);};
  try {
    const url=new URL(req.url,app.origin),path=url.pathname;
    if(tryLanding(req,res,path))return;
    if(path==='/settings'||path.startsWith('/settings/'))return await settings(app,req,path,readBody,send,res);
    if(path.startsWith('/oauth/')||path.startsWith('/.well-known/')) return await oauth(app,req,path,readBody,send,res);
    if(path==='/agents/redeem')return send(410,{error:'Invitations are retired. Connect with the instance key.'});
    if(path==='/health')return send(200,{service:'BotlineMCP',status:'configured',version:'0.6.23'});
    if(path==='/bind')return send(410,{error:'Link-only binding has been retired. Use authenticated MCP bot_bind.'});
    if(path.startsWith('/telegram/')&&req.method==='POST') {
      const update=JSON.parse(await readBody(req,262144)),botId=path.slice(10),secret=req.headers['x-telegram-bot-api-secret-token'];let done;
      try{done=await app.receive(botId,secret,update);}catch(error){
        try{const bot=await app.store.get('bot',botId),route=await app.store.get('group_bot',botId);if(bot?.active&&same(secret,bot.hookSecret)&&route?.owner===bot.owner){error.details=await new RelayErrors(app).report({owner:bot.owner,agentId:route.agentId,code:errorCode(error)});}}catch{}
        holdInboundReactions(app);throw error;
      }
      holdInboundReactions(app);
      return send(done?200:503,{ok:done});
    }
    if(path==='/mcp')instrumentProtocol(req,res);
    requireThat(path==='/mcp','Not found',404);
    if(req.headers.origin!==undefined)requireThat(req.headers.origin===app.origin,'Origin mismatch',403);
    if(req.method==='GET'){if(tryMcpGuide(req,res))return;return writeGetSse(res,req);}
    if(req.method!=='POST'){res.setHeader('Allow','GET, POST');requireThat(false,'Only GET and POST supported',405);}
    const rpc=JSON.parse(await readBody(req,ATTACHMENT_POLICY.requestBytes));
    req.protocolMessage=rpc;
    if(rpc?.jsonrpc==='2.0'&&typeof rpc.method==='string'&&rpc.id===undefined&&!Array.isArray(rpc)&&rpc.method.startsWith('notifications/')){res.statusCode=202;return res.end();}
    if(usesModernEnvelope(req,rpc)){if(!prepareProtocol(req,res,rpc))return;}
    else requireThat(rpc?.jsonrpc==='2.0'&&typeof rpc.method==='string'&&!Array.isArray(rpc)&&(typeof rpc.id==='string'||Number.isInteger(rpc.id)),'Invalid JSON-RPC');
    const botType=parseBotType(req.headers['x-mcp-bot-type']);
    const publicMethods=['server/discover','tools/list','events/list','initialize','ping'];
    let owner,principal;
    if(!publicMethods.includes(rpc.method)||(rpc.method==='tools/list'&&(req.headers.authorization!==undefined||req.headers['x-mcp-agent-id']!==undefined))){
      principal=await authenticatePrincipal(app,req);owner=principal.owner;
    }
    requireThat(rpc?.jsonrpc==='2.0'&&typeof rpc.method==='string'&&!Array.isArray(rpc),'Invalid JSON-RPC');
    const sendRpc=(status,payload)=>{if(req.protocolPrepared&&payload.result)payload={...payload,result:modernResult(payload.result)};if(payload.error?.code===-32601)status=404;return writeMcpResponse(req,res,status,payload);};
    try {const result=await app.rpc(owner,rpc.method,rpc.params,principal,botType);holdInboundReactions(app);return sendRpc(200,{jsonrpc:'2.0',id:rpc.id,result});}
    catch(e){holdInboundReactions(app);return sendRpc(200,{jsonrpc:'2.0',id:rpc.id,error:{code:e.rpcCode??-32602,message:e.status&&e.status<500?e.message:'Request failed',data:{...relayErrorDetails(errorCode(e)),...e.details,...(e.reason?{reason:e.reason}:{})}}});}
  } catch(e) {if(e.status===401)res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${app.origin}/.well-known/oauth-protected-resource", scope="bot:manage"`);if(e.status===405)res.setHeader('Allow','GET, POST');return send(e.status??500,{error:e.status&&e.status<500?e.message:'Request failed',...relayErrorDetails(errorCode(e)),...e.details});}
 };
}


