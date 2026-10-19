// Route atoms are encoded, never taken from display names or message text.
// encodeURIComponent covers `@` and control chars; `.` is also `%2E` so a handle
// cannot forge the type segment (e.g. `x.grokbot` must not look like type grokbot).
const atom=v=>encodeURIComponent(String(v??'unknown').slice(0,200)).replaceAll('.','%2E');
export function messageText(event){
 const d=event.data,from=d.sender;
 const platform=senderPlatform(from);
 const header=`[${atom(from?.handle??from?.id)}.${platform}@botline]:`;
 const appendix=(d.attachments??[]).map(a=>'\n[Attachment '+JSON.stringify(a.name)+'; '+a.size+' bytes; '+a.mime_type+'; ID '+a.attachment_id+'; expires '+a.expires_at+'. Use attachments_read to retrieve bytes.]').join('');
 return header+'\n'+(event.name==='message.created'?d.text:'')+appendix+(d.attachment_error?'\n[Attachment unavailable: '+d.attachment_error+']':'');
}

export const senderPlatform=from=>from?.kind==='human'?'user':from?.kind==='agent'&&['grokbot','chatgpt','muse'].includes(from.platform)?from.platform:'agent';
