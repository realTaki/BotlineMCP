// Route atoms are encoded, never taken from display names or message text.
// encodeURIComponent covers `@` and control chars; `.` is also `%2E` so a handle
// cannot forge the type segment (e.g. `x.grokbot` must not look like type grokbot).
const atom=v=>encodeURIComponent(String(v??'unknown').slice(0,200)).replaceAll('.','%2E');
export function messageText(event){
 const d=event.data,from=d.sender;
 const platform=senderPlatform(from);
 const header=`[${atom(from?.handle??from?.id)}.${platform}@botline]:`;
 return header+'\n'+(event.name==='message.created'?d.text:'');
}

export const senderPlatform=from=>from?.kind==='human'?'user':from?.kind==='agent'&&['grokbot','chatgpt','muse'].includes(from.platform)?from.platform:'agent';
