import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {hash,nonce,requireThat} from './security.js';
import {getAgent,callerTokenProperty} from './agents.js';
import {telegramHumanAllowed} from './telegram-policy.js';
export const ATTACHMENT_POLICY={maxBytes:2*1024*1024,maxStoredBytes:32*1024*1024,ttl:86400000,dailyBytes:100*1024*1024,dailyOperations:500,requestBytes:3*1024*1024,monthlyBytes:1024*1024*1024,monthlyUploads:500,monthlyReads:3000,maxReads:10,concurrency:2};
const schema=properties=>({type:'object',properties,required:Object.keys(properties).filter(k=>k!=='agent_token'),additionalProperties:false});
export const attachmentTools=[
 {name:'attachments_upload',description:'Upload one small file as base64 (maximum 2 MiB). Requires a stable request_id; retries with different bytes/metadata are rejected. Returns an attachment_id; send it with messages_send to grant that recipient access. No public URL. Fixed 24-hour expiry, shared instance storage/daily quotas. Refresh tools/list; no re-registration needed.',inputSchema:schema({request_id:{type:'string'},name:{type:'string'},data:{type:'string',description:'Canonical base64 of actual file bytes; do not send URLs.'},agent_token:callerTokenProperty}),annotations:{readOnlyHint:false,idempotentHint:true}},
 {name:'attachments_read',description:'Read actual bytes of one authorized unexpired attachment. Raster images return an MCP image block; recognized audio returns an MCP audio block; other files return an embedded resource blob. Set format=resource for a downloadable blob instead of native media; client playback and transcription support vary. Never execute files. Reading consumes the shared daily transfer budget; download once and cache locally. ACK does not delete bytes before fixed expiry. No public links or Telegram credentials are returned.',inputSchema:{...schema({attachment_id:{type:'string'},agent_token:callerTokenProperty}),properties:{attachment_id:{type:'string'},format:{type:'string',enum:['native','resource'],description:'Optional; native by default. resource returns one embedded blob for clients without native media support.'},agent_token:callerTokenProperty}},annotations:{readOnlyHint:true}},
];
export const cleanFilename=value=>String(value??'file').split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,120)||'file';
// Byte identification is deliberately narrow. Metadata/extensions are never evidence
// of a codec, and identification is not a decoder or a claim that content is safe.
function audioType(b){
 if(b.length>=47&&b.toString('ascii',0,4)==='OggS'){
  let offset=0,pages=0,serial,sequence=0;
  while(offset<b.length){
   if(offset+27>b.length||b.toString('ascii',offset,offset+4)!=='OggS'||b[offset+4]!==0||(b[offset+5]&~7))return null;
   const count=b[offset+26],table=offset+27,end=table+count;if(!count||end>b.length)return null;
   const size=b.subarray(table,end).reduce((n,v)=>n+v,0);if(!size||end+size>b.length)return null;
   if(!pages){
    serial=b.readUInt32LE(offset+14);
    // Standard mono/stereo Opus identification packet on its own BOS page.
    if(b[offset+5]!==2||count!==1||size!==19||b.toString('ascii',end,end+8)!=='OpusHead'||b[end+8]!==1||![1,2].includes(b[end+9])||b[end+18]!==0)return null;
   }
   if(pages===1&&(size<16||b.toString('ascii',end,end+8)!=='OpusTags'))return null;
   if(b.readUInt32LE(offset+14)!==serial||b.readUInt32LE(offset+18)!==sequence++)return null;
   pages++;offset=end+size;
  }
  // A lone identification header is not an audio stream.
  if(pages>=3)return 'audio/ogg';
 }
 if(b.length>=44&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE'&&b.readUInt32LE(4)===b.length-8){
  let offset=12,format=false,data=false,align=0;
  while(offset+8<=b.length){
   const type=b.toString('ascii',offset,offset+4),size=b.readUInt32LE(offset+4),start=offset+8,end=start+size;
   if(end>b.length)return null;
   if(type==='fmt '){
    if(format||size<16)return null;
    const codec=b.readUInt16LE(start),channels=b.readUInt16LE(start+2),rate=b.readUInt32LE(start+4),bits=b.readUInt16LE(start+14);
    align=b.readUInt16LE(start+12);
    if(codec!==1||channels<1||channels>2||rate<8000||rate>192000||![8,16,24,32].includes(bits)||align!==channels*bits/8||b.readUInt32LE(start+8)!==rate*align)return null;
    format=true;
   }else if(type==='data'){if(!format||!size||size%align)return null;data=true;}
   offset=end+(size%2);
  }
  if(offset===b.length&&format&&data)return 'audio/wav';
 }
 // MPEG Layer III: skip a bounded ID3v2 tag and require two complete,
 // consecutive frames with consistent MPEG version and sample rate.
 let offset=0;
 if(b.length>=10&&b.toString('ascii',0,3)==='ID3'){
  if(![2,3,4].includes(b[3])||b[4]===255||b.subarray(6,10).some(v=>v&128))return null;
  offset=10+b.subarray(6,10).reduce((n,v)=>n*128+v,0)+(b[3]===4&&(b[5]&16)?10:0);
 }
 let frames=0,signature;
 while(offset+4<=b.length&&frames<2){
  const h=b.readUInt32BE(offset),version=(h>>>19)&3,layer=(h>>>17)&3,bitrateIndex=(h>>>12)&15,rateIndex=(h>>>10)&3;
  if((h>>>21)!==2047||version===1||layer!==1||!bitrateIndex||bitrateIndex===15||rateIndex===3||(h&3)===2)break;
  const rate=[44100,48000,32000][rateIndex]/(version===3?1:version===2?2:4),bitrate=(version===3?[0,32,40,48,56,64,80,96,112,128,160,192,224,256,320]:[0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex];
  const length=Math.floor((version===3?144000:72000)*bitrate/rate)+((h>>>9)&1),current=version+':'+rate;
  if((signature&&signature!==current)||offset+length>b.length)break;
  signature=current;offset+=length;frames++;
 }
 return frames>=2?'audio/mpeg':null;
}
export function mediaType(b){
 const pixels=(w,h)=>w>0&&h>0&&w*h<=16000000;
 if(b.length>=33&&b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&b.readUInt32BE(8)===13&&b.toString('ascii',12,16)==='IHDR'&&pixels(b.readUInt32BE(16),b.readUInt32BE(20)))return 'image/png';
 if(b.length>=4&&b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217){
  let i=2;while(i+4<=b.length&&b[i]===255){const marker=b[i+1];if(marker===0xda||marker===0xd9)break;const length=b.readUInt16BE(i+2);if(length<2||i+2+length>b.length)break;
   if([0xc0,0xc1,0xc2].includes(marker)&&length>=8&&pixels(b.readUInt16BE(i+7),b.readUInt16BE(i+5)))return 'image/jpeg';i+=length+2;}
 }
 // Unknown codecs/formats and active SVG/HTML remain opaque downloads.
 return audioType(b)??'application/octet-stream';
}
const meta=r=>({attachment_id:r.id,name:r.name,mime_type:r.mime,size:r.size,sha256:r.sha256,expires_at:new Date(r.expires).toISOString()});
function encrypt(app,b){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',Buffer.from(app.key,'base64'),iv);return Buffer.concat([iv,c.update(b),c.final(),c.getAuthTag()]);}
function decrypt(app,b){b=Buffer.from(b);const d=createDecipheriv('aes-256-gcm',Buffer.from(app.key,'base64'),b.subarray(0,12));d.setAuthTag(b.subarray(-16));return Buffer.concat([d.update(b.subarray(12,-16)),d.final()]);}
export class Attachments{
 constructor(app){this.app=app;this.store=app.store;}
 async actor(p,store=this.store){requireThat(p?.agentId&&await this.app.ownerActive(p.owner)&&await getAgent({store},p.owner,p.agentId),'Authentication required',403);}
 async budget(owner,bytes=0,operations=1,kind=null,id=null){
  // Conservative application accounting includes base64 and storage/transport copies,
  // not a provider bill. Reserve before I/O and never refund uncertain attempts.
  return this.store.withLock('attachments:'+owner,async tx=>{
   await tx.pruneAttachments(Date.now());
   const day=Math.floor(Date.now()/86400000),old=await tx.get('attachment_budget',owner),r=old?.day===day?old:{owner,day,bytes:0,operations:0};
   requireThat(r.bytes+bytes<=ATTACHMENT_POLICY.dailyBytes&&r.operations+operations<=ATTACHMENT_POLICY.dailyOperations,'Attachment daily budget reached; retry tomorrow',429);
   const history=(old?.history??[]).filter(b=>b.day>=day-30),bucket=history.find(b=>b.day===day)??{day,bytes:0,uploads:0,reads:0};if(!history.includes(bucket))history.push(bucket);
   const uploads=kind==='upload'?1:0,reads=kind==='read'?1:0;
   requireThat(history.reduce((n,b)=>n+b.bytes,0)+bytes<=ATTACHMENT_POLICY.monthlyBytes&&history.reduce((n,b)=>n+b.uploads,0)+uploads<=ATTACHMENT_POLICY.monthlyUploads&&history.reduce((n,b)=>n+b.reads,0)+reads<=ATTACHMENT_POLICY.monthlyReads,'Attachment rolling 30-day budget reached',429);
   if(id&&kind==='file'){const k=hash(id),usage=await tx.get('attachment_reads',k)??{owner,count:0,expires:Date.now()+ATTACHMENT_POLICY.ttl};requireThat(usage.count<ATTACHMENT_POLICY.maxReads,'Attachment read limit reached',429);await tx.put('attachment_reads',k,{...usage,count:usage.count+1});}
   bucket.bytes+=bytes;bucket.uploads+=uploads;bucket.reads+=reads;
   await tx.put('attachment_budget',owner,{...r,bytes:r.bytes+bytes,operations:r.operations+operations,history});
  });
 }
 async operation(p,fn){
  await this.actor(p);const id=nonce(),now=Date.now();
  await this.store.withLock('attachments:'+p.owner,async tx=>{const r=await tx.get('attachment_leases',p.owner)??{owner:p.owner,leases:[]};r.leases=r.leases.filter(l=>l.expires>now);requireThat(r.leases.length<ATTACHMENT_POLICY.concurrency,'Attachment concurrency limit reached; retry later',503);r.leases.push({id,expires:now+120000});await tx.put('attachment_leases',p.owner,r);});
  try{return await fn();}finally{await this.store.withLock('attachments:'+p.owner,async tx=>{const r=await tx.get('attachment_leases',p.owner);if(r)await tx.put('attachment_leases',p.owner,{...r,leases:r.leases.filter(l=>l.id!==id&&l.expires>Date.now())});});}
 }
 async upload(p,args){return this.operation(p,()=>this.uploadInternal(p,args));}
 async bytes(p,id){return this.operation(p,()=>this.bytesInternal(p,id));}
 async telegram(p,bot,m,updateId){return this.operation(p,()=>this.telegramInternal(p,bot,m,updateId));}
 charge(n){return 3*Math.ceil(n*4/3);}
 async allowed(p,r,tx=this.store){
  requireThat(r&&r.owner===p.owner&&r.expires>Date.now(),'Attachment unavailable or expired',404);
  requireThat(r.uploader===p.agentId||!!await tx.get('attachment_grant',hash(r.id+':'+p.agentId)),'Attachment is not shared with this agent',403);
  if(r.source){const s=r.source,b=await tx.get('bot',s.botId),route=await tx.get('group_bot',s.botId),humans=await tx.list('human',p.owner);requireThat(b?.owner===p.owner&&b.active&&!b.unbound&&route?.owner===p.owner&&route.agentId===s.agentId&&route.bindingId===s.bindingId&&humans.some(h=>h.handle===s.humanHandle&&h.telegram_user_id===s.humanId)&&telegramHumanAllowed(humans,s.humanId),'Attachment source access revoked',403);}
  return r;
 }
 async inspect(p,id,tx=this.store){await this.actor(p,tx);requireThat(typeof id==='string'&&/^att_[A-Za-z0-9_-]{43}$/.test(id),'Invalid attachment_id');return this.allowed(p,await tx.getAttachment(id),tx);}
 async persist(p,bytes,name,requestId,source){
  const filename=cleanFilename(name),fingerprint=hash(JSON.stringify([filename,hash(bytes),source??null]));
  return this.store.withLock('attachments:'+p.owner,async tx=>{
   await tx.pruneAttachments(Date.now());const rid=hash(p.owner+':'+p.agentId+':'+requestId),prior=await tx.get('attachment_upload',rid);
   if(prior){requireThat(prior.fingerprint===fingerprint,'request_id reused for different attachment',409);const r=await this.allowed(p,await tx.getAttachment(prior.attachmentId),tx);return meta(r);}
   const body=encrypt(this.app,bytes);requireThat((await tx.attachmentStoredBytes(p.owner))+body.length<=ATTACHMENT_POLICY.maxStoredBytes,'Attachment storage capacity reached; wait for expiry',429);
   const r={id:'att_'+nonce(),owner:p.owner,uploader:p.agentId,name:filename,mime:mediaType(bytes),size:bytes.length,sha256:hash(bytes),expires:Date.now()+ATTACHMENT_POLICY.ttl,...(source?{source}:{})};
   if(source)await this.allowed(p,r,tx);
   await tx.putAttachment(r,body);await tx.put('attachment_upload',rid,{owner:p.owner,fingerprint,attachmentId:r.id,expires:r.expires+6*86400000});return meta(r);
  });
 }
 async uploadInternal(p,args){
  await this.actor(p);await this.budget(p.owner,0,1,'upload');
  requireThat(typeof args.request_id==='string'&&/^[\w-]{8,128}$/.test(args.request_id),'Invalid request_id');requireThat(typeof args.name==='string'&&args.name.length<=256,'Invalid filename');
  requireThat(typeof args.data==='string'&&args.data.length<=Math.ceil(ATTACHMENT_POLICY.maxBytes/3)*4&&args.data.length%4===0&&!/[^A-Za-z0-9+/=]/.test(args.data),'Invalid or oversized attachment base64');
  const b=Buffer.from(args.data,'base64');requireThat(b.length>0&&b.length<=ATTACHMENT_POLICY.maxBytes&&b.toString('base64')===args.data,'Invalid attachment bytes');
  await this.budget(p.owner,this.charge(b.length),0);return this.persist(p,b,args.name,args.request_id);
 }
 async grant(p,ids,recipient,tx){
  requireThat(Array.isArray(ids)&&ids.length<=1,'At most one attachment per message');const out=[];
  for(const id of ids){const r=await this.inspect(p,id,tx);if(recipient.kind==='agent')await tx.put('attachment_grant',hash(id+':'+recipient.id),{owner:p.owner,attachmentId:id,agentId:recipient.id,expires:r.expires});out.push(meta(r));}return out;
 }
 async bytesInternal(p,id){
  await this.actor(p);await this.budget(p.owner,0,1,'read');const r=await this.inspect(p,id);await this.budget(p.owner,this.charge(r.size),0,'file',id);
  const b=await this.store.getAttachmentBody(id);await this.inspect(p,id);requireThat(b,'Attachment expired',404);return {record:r,bytes:decrypt(this.app,b)};
 }
 async read(p,id,format='native'){requireThat(['native','resource'].includes(format),'Invalid attachment read format');const {record:r,bytes}=await this.bytes(p,id);const metadata=meta(r),base64=bytes.toString('base64');return {content:[{type:'text',text:JSON.stringify(metadata)},format==='native'&&r.mime.startsWith('image/')?{type:'image',data:base64,mimeType:r.mime}:format==='native'&&r.mime.startsWith('audio/')?{type:'audio',data:base64,mimeType:r.mime}:{type:'resource',resource:{uri:'botline://attachments/'+r.id,mimeType:r.mime,blob:base64}}],structuredContent:metadata};}
 async telegramInternal(p,bot,m,updateId){
  await this.budget(p.owner,0,1,'upload');
  const source={botId:bot.id,agentId:p.agentId,bindingId:bot.bindingId,humanId:String(m.from.id),humanHandle:(await this.store.list('human',p.owner)).find(h=>h.telegram_user_id===String(m.from.id))?.handle};
  const f=m.document??m.voice??m.audio??(Array.isArray(m.photo)?m.photo.at(-1):null);if(!f)return {error:'unsupported_media'};
  if(!Number.isSafeInteger(f.file_size)||f.file_size<=0||f.file_size>ATTACHMENT_POLICY.maxBytes)return {error:'attachment_too_large_or_unknown_size'};
  const requestId='tg_'+hash(bot.id+':'+updateId),prior=await this.store.get('attachment_upload',hash(p.owner+':'+p.agentId+':'+requestId));
  if(prior){const r=await this.inspect(p,prior.attachmentId);return {attachment:meta(r)};}
  await this.actor(p);await this.budget(p.owner,this.charge(f.file_size)*2,3);
  const check={owner:p.owner,uploader:p.agentId,expires:Date.now()+ATTACHMENT_POLICY.ttl,source};await this.allowed(p,check);
  const token=this.app.decrypt(bot.token);let bytes;
  try{
   const file=await this.app.telegram(token,'getFile',{file_id:f.file_id});requireThat(typeof file.file_path==='string'&&/^[A-Za-z0-9_/-]+\.[A-Za-z0-9]+$/.test(file.file_path)&&!file.file_path.split('/').includes('..')&&!file.file_path.startsWith('/'),'File path rejected');
   const response=await (this.app.attachmentFetch??fetch)('https://api.telegram.org/file/bot'+token+'/'+file.file_path,{redirect:'error',signal:AbortSignal.timeout(15000)});requireThat(response.ok,'File unavailable');const length=response.headers?.get('content-length');if(length!==null&&length!==undefined)requireThat(Number(length)<=f.file_size,'File exceeds limit');
   const reader=response.body.getReader(),chunks=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;requireThat(size<=f.file_size&&size<=ATTACHMENT_POLICY.maxBytes,'File exceeds limit');chunks.push(Buffer.from(value));}}finally{await reader.cancel().catch(()=>{});}
   bytes=Buffer.concat(chunks);requireThat(bytes.length===f.file_size,'File size mismatch');
  }catch{return {error:'attachment_download_failed'};}
  await this.allowed(p,check);return {attachment:await this.persist(p,bytes,m.document?.file_name??(m.voice?'voice.ogg':m.audio?(m.audio.file_name??'audio.bin'):'photo.jpg'),requestId,source)};
 }
}
