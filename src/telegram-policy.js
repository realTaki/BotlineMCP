export function telegramHumanAllowed(humans,telegramUserId){
 return humans.some(h=>h.telegram_user_id===String(telegramUserId));
}
export function telegramSenderAllowed(m,humans){
 const id=String(m.from?.id);
 if(m.sender_chat||m.from?.is_bot!==false||m.chat?.type!=='private')return false;
 if(String(m.chat.id)!==id)return false;
 return telegramHumanAllowed(humans,id);
}
export const telegramDmAcceptId=(botId,telegramUserId)=>`${botId}:${String(telegramUserId)}`;
export async function telegramDmAccepted(store,owner,botId,telegramUserId){
 const record=await store.get('dm_accept',telegramDmAcceptId(botId,telegramUserId));
 return record?.owner===owner&&record.botId===botId&&record.telegram_user_id===String(telegramUserId)&&record.accepted===true;
}
export async function markTelegramDmAccepted(store,owner,botId,telegramUserId){
 const id=String(telegramUserId);
 await store.put('dm_accept',telegramDmAcceptId(botId,id),{owner,botId,telegram_user_id:id,accepted:true});
}
export async function clearTelegramDmAccepted(store,botId,telegramUserId){
 await store.delete('dm_accept',telegramDmAcceptId(botId,telegramUserId));
}
