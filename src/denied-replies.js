import {hash} from './security.js';

export const DENIED_REPLY_POLICY={
  receiptTtl:7*86400000,
  peerCooldown:10*60000,
  chatCooldown:30000,
  botWindow:60000,
  botMax:30,
  maxPeers:512,
  maxChats:256
};

// Keep only successful reservations, with hashed IDs and a fixed per-bot bound.
// Suppressed messages never add sender/chat entries or retain their text.
export function nextDeniedReplyState(previous,senderId,chatId,now) {
  const p=DENIED_REPLY_POLICY;
  const live=(entries,ttl)=>Object.fromEntries(Object.entries(entries??{}).filter(([,at])=>Number.isSafeInteger(at)&&at>now-ttl));
  const peers=live(previous?.peers,p.peerCooldown),chats=live(previous?.chats,p.chatCooldown);
  const peer=hash(JSON.stringify([senderId,chatId])),chat=hash(chatId);
  const window=Number.isSafeInteger(previous?.window)&&previous.window>now-p.botWindow?previous.window:now;
  const count=window===previous?.window&&Number.isSafeInteger(previous?.count)?previous.count:0;
  if(peers[peer]!==undefined||chats[chat]!==undefined||count>=p.botMax||Object.keys(peers).length>=p.maxPeers||Object.keys(chats).length>=p.maxChats)return null;
  peers[peer]=now;chats[chat]=now;
  return {peers,chats,window,count:count+1,expires:now+p.peerCooldown};
}
