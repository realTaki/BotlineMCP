export function telegramHumanAllowed(humans,telegramUserId){
 return humans.some(h=>h.telegram_user_id===String(telegramUserId));
}
export function telegramSenderAllowed(m,humans){
 const id=String(m.from?.id);
 if(m.sender_chat||m.from?.is_bot!==false||m.chat?.type!=='private')return false;
 if(String(m.chat.id)!==id)return false;
 return telegramHumanAllowed(humans,id);
}
