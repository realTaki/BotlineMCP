import {getAgent} from './agents.js';
import {nonce,requireThat} from './security.js';
import {isMuseAgent} from './muse-inbox.js';
// The lock spans webhook mutation as well as local state, so unbind cannot remove
// a newer concurrent bind's webhook. No request-time migration claims old bots.
export class BotBindings {
 constructor(app){this.app=app;}
 async actor(owner,agentId){requireThat(agentId&&await getAgent(this.app,owner,agentId),'Register and select an agent handle before binding a bot',409);}
 async bind(owner,args,{agentId,bindingDiagnostic,migration}){
  await this.actor(owner,agentId);
  return this.app.store.withBotLock('bot-binding:'+owner,async tx=>{
   const app=Object.assign(Object.create(Object.getPrototypeOf(this.app)),this.app,{store:tx});
   const routes=(await tx.list('group_bot',owner)).filter(r=>r.agentId===agentId);
   requireThat(routes.length<=1,'Multiple existing bot bindings require explicit resolution; nothing was removed',409);
   const hasToken=args.token!==undefined,hasExisting=args.existing_bot_id!==undefined;
   requireThat(hasToken!==hasExisting,'Provide exactly one of token or existing_bot_id');
   if(hasToken)requireThat(typeof args.token==='string'&&/^\d+:[A-Za-z0-9_-]{20,}$/.test(args.token),'Invalid bot token format');
   else requireThat(typeof args.existing_bot_id==='string'&&/^[1-9]\d*$/.test(args.existing_bot_id)&&Number.isSafeInteger(Number(args.existing_bot_id)),'Invalid existing_bot_id');
   const expectedId=hasToken?args.token.split(':')[0]:args.existing_bot_id;
   const stored=hasExisting?await tx.get('bot',expectedId):null;
   if(hasExisting){requireThat(stored?.owner===owner&&!stored.unbound&&typeof stored.token==='string','Existing bot is unavailable in this instance; explicit token binding is required',404);requireThat(typeof stored.hookSecret==='string'&&stored.hookSecret.length>0,'Existing webhook secret is unavailable; explicit token rebinding is required',409);}
   requireThat(!routes.length||routes[0].id===expectedId,'This handle already has a bot; unbind it before binding another',409);
   const existing=await tx.get('group_bot',expectedId);
   requireThat(!existing||existing.owner===owner&&existing.agentId===agentId,'Bot belongs to another handle',409);
   if(bindingDiagnostic)bindingDiagnostic.bindingGeneration=existing?.bindingId??null;
   if(migration){
    if(bindingDiagnostic)bindingDiagnostic.stage='migration_recheck';
    const actor=await getAgent(app,owner,agentId);
    requireThat(actor&&migration.agentId===agentId&&migration.handle===actor.handle&&migration.owner===owner&&migration.authVersion===app.instanceKeyHash&&migration.expires>Date.now()&&migration.bindingGeneration===(existing?.bindingId??null),'Migration context changed; confirm again',409);
   }
   const route=existing??{owner,agentId,bindingId:nonce()};
   try{
    // The stored credential stays inside the server and is never returned to
    // MCP, diagnostic metadata, logs or the caller's argument list.
    const bindingArgs=hasExisting?{...args,token:app.decrypt(stored.token)}:args;
    const bot=await app.bind(owner,bindingArgs,{bindingRoute:route,expectedBotId:expectedId,bindingDiagnostic,migration});
    requireThat(bot.bot_id===expectedId,'Telegram bot identity mismatch',409);
    return {...bot,agent_id:agentId,credential_source:hasExisting?'stored':'provided',webhook_events:['message','my_chat_member']};
   }catch(error){
    const current=await tx.get('bot',expectedId),currentRoute=await tx.get('group_bot',expectedId);
    error.bindingState={bot_id:expectedId,active:!!current?.active,assigned_to_current_handle:currentRoute?.owner===owner&&currentRoute.agentId===agentId,stored_credential_available:!!current?.token&&!current?.unbound,retry_existing_bot_id:hasExisting&&!!current?.token&&!current?.unbound};
    throw error;
   }
  });
 }
 async unbind(owner,agentId,botId){
  await this.actor(owner,agentId);
  return this.app.store.withBotLock('bot-binding:'+owner,async tx=>{
   const route=await tx.get('group_bot',botId),bot=await tx.get('bot',botId);
   requireThat(bot?.owner===owner,'Bot not found',404);
   if(bot.unbound&&!route)return {bot_id:botId,unbound:true,webhook:'already_unbound'};
   requireThat(route?.owner===owner&&route.agentId===agentId,'Bot is not bound to this handle; resolve legacy ownership first',409);
   let webhook='removed';
   try{if(bot.token)await this.app.telegram(this.app.decrypt(bot.token),'deleteWebhook',{drop_pending_updates:false});}catch{webhook='unconfirmed';}
   const {token,hookSecret,users,chats,knownDms,dmEnrollments,ownedDms,dmRevoked,ownedChats,...safe}=bot;
   await tx.put('bot',botId,{...safe,active:false,unbound:true});await tx.delete('group_bot',botId);
   for(const sub of await tx.list('subscription',owner))if(sub.botId===botId)await tx.delete('subscription',sub.id);
   const boundChats=(await tx.list('chat',owner)).filter(c=>c.telegram?.bot_id===botId),chatIds=new Set(boundChats.map(c=>c.id));
   for(const sub of await tx.list('group_subscription',owner))if(sub.chatId&&chatIds.has(sub.chatId))await tx.delete('group_subscription',sub.id);
   await tx.withHeldConnectionLock('dms:'+owner,async inboxTx=>{for(const d of await inboxTx.list('dot_inbox',owner))if(d.event?.data?.telegram?.bot_id===botId)await inboxTx.delete('dot_inbox',d.id);if(isMuseAgent(await getAgent({store:inboxTx},owner,agentId)))for(const d of await inboxTx.listAgentInbox(owner,agentId))if(d.event?.data?.telegram?.bot_id===botId)await inboxTx.delete('muse_inbox',d.id);});
   for(const d of await tx.list('group_delivery',owner))if(chatIds.has(d.event?.data?.chat_id)||d.event?.data?.telegram?.bot_id===botId)await tx.delete('group_delivery',d.id);
   for(const d of await tx.list('delivery',owner))if(d.event?.data?.bot_id===botId)await tx.put('delivery',d.id,{...d,state:'cancelled',event:{eventId:d.event.eventId}});
   for(const r of await tx.list('update',owner))if(r.event?.data?.bot_id===botId)await tx.put('update',r.id,{owner,event:{eventId:r.event.eventId},subscriptionIds:[],completed:true,created:r.created});
   return {bot_id:botId,unbound:true,webhook,...(webhook==='unconfirmed'?{warning:'Token was removed locally. Telegram webhook removal was not confirmed; do not claim it was removed.'}:{})};
  });
 }
 async current(owner,agentId,{required=true}={}){
  if(!agentId){requireThat(!required,'Register and select a handle first',409);return {registered:false,bot:null,assignment_required:true};}
  await this.actor(owner,agentId);const routes=(await this.app.store.list('group_bot',owner)).filter(r=>r.agentId===agentId);
  requireThat(routes.length<=1,'Multiple existing bot bindings require explicit resolution; nothing was selected',409);
  const bot=routes.length?await this.app.store.get('bot',routes[0].id):null;
  if(!bot||bot.unbound){requireThat(!required,'No bot is bound to this handle',404);return {registered:true,bot:null};}
  requireThat(bot.owner===owner,'Bot not found',404);return required?bot:{registered:true,bot:{...this.app.view(bot),agent_id:agentId}};
 }
 async list(owner){
  const bots=await this.app.store.list('bot',owner),routes=await this.app.store.list('group_bot',owner);
  return {bots:bots.map(b=>{const route=routes.find(r=>r.id===b.id);return {...this.app.view(b),agent_id:route?.agentId??null,unbound:!!b.unbound,...(!route&&!b.unbound?{assignment_required:true}:{})};}),...(routes.some(r=>routes.filter(x=>x.agentId===r.agentId).length>1)?{warning:'Multiple bots are assigned to one handle. Resolve explicitly; no bindings were changed.'}:{})};
 }
}

