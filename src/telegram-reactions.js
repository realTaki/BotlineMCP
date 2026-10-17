// Confirmed Telegram Bot API ReactionTypeEmoji values. 📥 and 📨 are not in that list.
export const INBOUND_REACTIONS=Object.freeze({received:'🕊',delivered:'👀',failed:'💔'});
const pending=new Map();

export function telegramReactionTarget(event){
 const tg=event?.data?.telegram,messageId=Number(tg?.message_id);
 if(!tg||tg.bot_id==null||tg.chat_id==null||!Number.isSafeInteger(messageId)||messageId<=0)return;
 return {botId:String(tg.bot_id),chatId:String(tg.chat_id),messageId};
}

export function waitInboundReactions(){
 return pending.size?Promise.all([...pending.values()]):Promise.resolve();
}

export function inboundTelegramReaction(app,target,emoji){
 if(!target?.botId||target.chatId==null||!Number.isSafeInteger(target.messageId)||target.messageId<=0)return Promise.resolve();
 if(emoji!==INBOUND_REACTIONS.received&&emoji!==INBOUND_REACTIONS.delivered&&emoji!==INBOUND_REACTIONS.failed)return Promise.resolve();
 const key=`${target.botId}:${target.chatId}:${target.messageId}`;
 const run=()=>setInboundReaction(app,target,emoji);
 const next=(pending.get(key)??Promise.resolve()).then(run,run);
 pending.set(key,next);
 next.finally(()=>{if(pending.get(key)===next)pending.delete(key);});
 return next;
}

async function setInboundReaction(app,target,emoji){
 try{
  const bot=await app.store.get('bot',target.botId);
  if(!bot?.active||!bot.token)return;
  await app.telegram(app.decrypt(bot.token),'setMessageReaction',{chat_id:target.chatId,message_id:target.messageId,reaction:[{type:'emoji',emoji}]});
 }catch(error){
  console.info(JSON.stringify({event:'inbound_reaction_failed',emoji,telegram_outcome:error?.telegramOutcome==='failed'?'failed':'uncertain'}));
 }
}
