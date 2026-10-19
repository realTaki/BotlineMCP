import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {Store} from '../src/store.js';
import {App,handler} from '../src/app.js';
import {Readable} from 'node:stream';
import {createEntrypoint} from '../api/index.js';
import {Attachments,ATTACHMENT_POLICY,cleanFilename,mediaType} from '../src/attachments.js';
import {registerAgent} from '../src/agents.js';
import {Dms} from '../src/dms.js';
import {MuseInbox} from '../src/muse-inbox.js';
import {humanRecordId} from '../src/telegram-owner.js';
import {hash} from '../src/security.js';
const owner='mcp:admin';
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());let tail=Promise.resolve();
 const query=async(...a)=>{const r=await db.query(...a);return {...r,rowCount:r.affectedRows??r.rows.length};};
 const pool={query,connect:async()=>{const prev=tail;let release;tail=new Promise(r=>release=r);await prev;return {query,release};}};
 const store=Object.create(Store.prototype);store.pool=pool;await store.initialize();
 const app=new App({store,key:Buffer.alloc(32,7).toString('base64'),origin:'https://mcp.example',instanceKey:'x'.repeat(64),telegram:async()=>{throw Error('Unexpected Telegram request');}});
 const principals=[];for(const handle of ['alpha','bravo','charlie']){const r=await registerAgent(app,{owner,authType:'api_key'},{handle},{botType:'muse'});principals.push({owner,agentId:r.agent_id,token:r.agent_token,authType:'api_key'});}
 return {db,app,store,files:new Attachments(app),dms:new Dms(app),a:principals[0],b:principals[1],c:principals[2]};
}
const upload=(name='test.txt',text='synthetic',id='upload-0001')=>({name,data:Buffer.from(text).toString('base64'),request_id:id});
test('SQL attachment bytes encrypted; actual message grants only recipient; ACK preserves bytes and native resource',async t=>{
 const f=await fixture(t),a=await f.files.upload(f.a,upload());
 assert.equal(a.size,9);assert.equal(a.mime_type,'application/octet-stream');assert.equal((await f.store.getAttachmentBody(a.attachment_id)).includes(Buffer.from('synthetic')),false);
 await assert.rejects(f.files.read(f.b,a.attachment_id),/not shared/);
 await assert.rejects(f.files.read({...f.b,owner:'other'},a.attachment_id),/Authentication|unavailable/);
 const sent=await f.dms.send(f.a,{to:'bravo',attachment_ids:[a.attachment_id],request_id:'send-00001'});
 const inbox=new MuseInbox(f.app),messages=(await inbox.list(f.b,{})).messages;assert.equal(messages.length,1);assert.deepEqual(messages[0].attachments,[a]);assert.match(messages[0].text,/attachments_read/);assert.equal(JSON.stringify(messages).includes(upload().data),false);
 const result=await f.app.rpcCall(owner,'tools/call',{name:'attachments_read',arguments:{attachment_id:a.attachment_id}},f.b);assert.equal(result.content[1].resource.blob,upload().data);
 await inbox.ack(f.b,{message_ids:[sent.message_id]});assert.equal((await f.files.read(f.b,a.attachment_id)).content[1].resource.blob,upload().data);
 await assert.rejects(f.files.read(f.c,a.attachment_id),/not shared/);
 assert.equal((await f.dms.send(f.a,{to:'bravo',attachment_ids:[a.attachment_id],request_id:'send-00001'})).message_id,sent.message_id);
 await assert.rejects(f.dms.send(f.a,{to:'bravo',text:'changed',attachment_ids:[a.attachment_id],request_id:'send-00001'}),/different content/);
 const forwarded=await f.dms.send(f.b,{to:'charlie',attachment_ids:[a.attachment_id],request_id:'forward-0001'});assert.ok(forwarded.message_id);assert.equal((await f.files.read(f.c,a.attachment_id)).structuredContent.sha256,a.sha256);
});
test('upload idempotency, expiry, name and MIME sniffing; no active image or URL fetching',async t=>{
 const f=await fixture(t),a=await f.files.upload(f.a,upload('../../x\n.svg','<svg onload="bad"/>'));
 assert.equal(a.name,'x.svg');assert.equal(a.mime_type,'application/octet-stream');assert.deepEqual(await f.files.upload(f.a,upload('../../x\n.svg','<svg onload="bad"/>')),a);
 await assert.rejects(f.files.upload(f.a,upload('x.svg','changed')),/different attachment/);
 for(const data of ['https://example.com/private','====',''])await assert.rejects(f.files.upload(f.a,{...upload(),data}));
 assert.equal(cleanFilename('a/\u202eb.txt'),'b.txt');
 const png=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(png);png.writeUInt32BE(13,8);png.write('IHDR',12);png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);
 const image=await f.files.upload(f.a,{name:'wrong.txt',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHioAAAAASUVORK5CYII=',request_id:'upload-png1'});assert.equal((await f.files.read(f.a,image.attachment_id)).content[1].type,'image');png.writeUInt32BE(0xffffffff,16);assert.equal(mediaType(png),'application/octet-stream');
 const row=await f.store.getAttachment(a.attachment_id);row.expires=Date.now()-1;await f.db.query('UPDATE mcp_attachments SET expires=$1,metadata=$2 WHERE id=$3',[row.expires,row,a.attachment_id]);
 await assert.rejects(f.files.read(f.a,a.attachment_id),/expired/);await assert.rejects(f.files.upload(f.a,upload('../../x\n.svg','<svg onload="bad"/>')),/expired/);
 assert.equal(await f.store.getAttachmentBody(a.attachment_id),undefined);
});
test('atomic quota reservations enforce rolling/daily budgets, per-file reads and two concurrent operations',async t=>{
 const f=await fixture(t),a=await f.files.upload(f.a,upload());
 for(let i=0;i<10;i++)await f.files.read(f.a,a.attachment_id);await assert.rejects(f.files.read(f.a,a.attachment_id),/read limit/);
 let release;const gate=new Promise(r=>release=r);let count=0;let started;const ready=new Promise(r=>started=r);
 const block=()=>f.files.operation(f.a,async()=>{if(++count===2)started();await gate;});const running=[block(),block()];await ready;await assert.rejects(f.files.operation(f.a,async()=>{}),/concurrency/);release();await Promise.all(running);
 const day=Math.floor(Date.now()/86400000);await f.store.put('attachment_budget',owner,{owner,day,bytes:0,operations:0,history:[{day,bytes:ATTACHMENT_POLICY.monthlyBytes-10,uploads:0,reads:0}]});
 const attempts=await Promise.allSettled([f.files.budget(owner,8),f.files.budget(owner,8)]);assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
 await f.store.put('attachment_budget',owner,{owner,day,bytes:0,operations:499,history:[]});const daily=await Promise.allSettled([f.files.budget(owner),f.files.budget(owner)]);assert.equal(daily.filter(a=>a.status==='fulfilled').length,1);
});
async function telegramFixture(f){
 const bot={id:'123',owner,active:true,token:f.app.encrypt('synthetic-token'),groupAgentId:f.b.agentId,bindingId:'binding-1'};
 await f.store.put('bot',bot.id,bot);await f.store.put('group_bot',bot.id,{owner,agentId:f.b.agentId,bindingId:bot.bindingId});
 await f.store.put('human',humanRecordId(owner,'humanone'),{owner,handle:'humanone',telegram_user_id:'456',display_name:'Synthetic'});
 return {bot,m:{from:{id:456,is_bot:false},chat:{id:456,type:'private'},date:Math.floor(Date.now()/1000),message_id:7,document:{file_id:'opaque-file',file_name:'a.txt',file_size:3}}};
}
test('Telegram media-only/caption, safe fetch, source revocation, and duplicate ingestion',async t=>{
 const f=await fixture(t),{bot,m}=await telegramFixture(f);let gets=0,downloads=0;
 f.app.telegram=async(_,method)=>{if(method==='getFile'){gets++;return {file_path:'documents/file_1.txt'};}return {};};
 f.app.attachmentFetch=async(url,options)=>{downloads++;assert.equal(new URL(url).hostname,'api.telegram.org');assert.equal(options.redirect,'error');return new Response('abc');};
 await f.dms.receiveTelegram(bot,{...m,caption:'caption'},1);
 const received=(await new MuseInbox(f.app).list(f.b,{})).messages[0];assert.match(received.text,/caption/);assert.equal(received.attachments.length,1);assert.equal(JSON.stringify(received).includes('synthetic-token'),false);
 await f.dms.receiveTelegram(bot,m,1);assert.equal(gets,1);assert.equal(downloads,1);
 const id=received.attachments[0].attachment_id;assert.equal((await f.files.bytes(f.b,id)).bytes.toString(),'abc');
 await f.dms.send(f.b,{to:'alpha',attachment_ids:[id],request_id:'forward-tg1'});
 await f.store.delete('human',humanRecordId(owner,'humanone'));await assert.rejects(f.files.bytes(f.a,id),/revoked/);
 await f.store.put('human',humanRecordId(owner,'humanone'),{owner,handle:'humanone',telegram_user_id:'456'});await f.store.put('group_bot',bot.id,{owner,agentId:f.b.agentId,bindingId:'new-generation'});await assert.rejects(f.files.bytes(f.b,id),/revoked/);
});
test('Telegram rejects unsafe paths, redirects/oversize/unknown media and never leaks token errors',async t=>{
 const f=await fixture(t),{bot,m}=await telegramFixture(f);let downloads=0;
 f.app.attachmentFetch=async()=>{downloads++;return new Response('abcd');};
 for(const [i,path] of ['../file.txt','x/file.txt?token=secret','https://evil.example/x.txt','/x.txt','x/file.txt#x'].entries()){
  f.app.telegram=async()=>({file_path:path});const result=await f.files.telegram(f.b,bot,m,20+i);assert.deepEqual(result,{error:'attachment_download_failed'});
 }
 assert.equal(downloads,0);f.app.telegram=async()=>({file_path:'documents/file.txt'});
 assert.deepEqual(await f.files.telegram(f.b,bot,m,30),{error:'attachment_download_failed'});assert.equal(downloads,1);
 assert.deepEqual(await f.files.telegram(f.b,bot,{...m,document:{file_size:ATTACHMENT_POLICY.maxBytes+1}},31),{error:'attachment_too_large_or_unknown_size'});
 assert.deepEqual(await f.files.telegram(f.b,bot,{...m,document:null,video:{}},32),{error:'unsupported_media'});
});
test('concurrent duplicate Telegram updates cannot win with an error placeholder; only one download',async t=>{
 const f=await fixture(t),{bot,m}=await telegramFixture(f);let release,entered;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r);let reads=0;
 f.app.telegram=async(_,method)=>method==='getFile'?{file_path:'documents/a.txt'}:{};
 f.app.attachmentFetch=async()=>{reads++;entered();await gate;return new Response('abc');};
 const first=f.dms.receiveTelegram(bot,m,50);await ready;
 await assert.rejects(f.dms.receiveTelegram(bot,m,50),/processing/);await assert.rejects(f.dms.receiveTelegram(bot,m,50),/processing/);release();await first;
 const messages=(await new MuseInbox(f.app).list(f.b,{})).messages;assert.equal(messages.length,1);assert.equal(messages[0].attachments.length,1);assert.equal(messages[0].attachment_error,undefined);assert.equal(reads,1);
});
test('failed message enqueue rolls back grants; unauthorized guesses cannot consume per-file read budget',async t=>{
 const f=await fixture(t),a=await f.files.upload(f.a,upload());
 const original=f.dms.enqueue;f.dms.enqueue=async()=>{throw Error('capacity');};await assert.rejects(f.dms.send(f.a,{to:'bravo',attachment_ids:[a.attachment_id],request_id:'fail-grant1'}),/capacity/);f.dms.enqueue=original;
 for(let i=0;i<11;i++)await assert.rejects(f.files.bytes(f.b,a.attachment_id),/not shared/);assert.equal(await f.store.get('attachment_reads',hash(a.attachment_id)),undefined);
 assert.equal((await f.files.bytes(f.a,a.attachment_id)).bytes.toString(),'synthetic');
});
test('2 MiB upload traverses production body parsing and authenticated MCP; anonymous cannot upload',async t=>{
 const f=await fixture(t),entry=createEntrypoint(()=>({serve:handler(f.app),initialized:Promise.resolve()}),()=>f.app.origin);
 async function request(name,args,auth=true){const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{...args,agent_token:f.a.token}}});const req=Readable.from([Buffer.from(body)]);Object.assign(req,{url:'/mcp',method:'POST',headers:{'content-type':'application/json',accept:'application/json','mcp-protocol-version':'2025-06-18',...(auth?{authorization:'Bearer '+'x'.repeat(64)}:{})}});let output='';const res={setHeader(){},end(s){output+=s??'';},write(s){output+=s;}};await entry(req,res);return {status:res.statusCode,body:JSON.parse(output)};}
 const data=Buffer.alloc(2*1024*1024,90).toString('base64');assert.equal((await request('attachments_upload',{name:'a.bin',data,request_id:'http-upload1'},false)).status,401);
 const r=await request('attachments_upload',{name:'a.bin',data,request_id:'http-upload1'});assert.equal(r.status,200);assert.equal(r.body.result.structuredContent.size,2*1024*1024);
 const read=await request('attachments_read',{attachment_id:r.body.result.structuredContent.attachment_id});assert.equal(read.body.result.content[1].resource.blob,data);assert.ok(JSON.stringify(read.body).length<4500000);
 const tooBig=await request('attachments_upload',{name:'a.bin',data:Buffer.alloc(2*1024*1024+1).toString('base64'),request_id:'http-upload2'});assert.ok(tooBig.body.error);
});
test('Telegram outgoing media multipart succeeds or stays uncertain; same request never sends twice',async t=>{
 const f=await fixture(t),{bot}=await telegramFixture(f),file=await f.files.upload(f.b,upload());
 await f.store.put('bot','legacy',{id:'legacy',owner,active:true});await assert.rejects(f.app.invoke(owner,'telegram_send_message',{bot_id:'legacy',attachment_id:file.attachment_id,attachment_principal:f.b,attachmentPayload:{bytes:'forged'}},f.a),/messages_send/);
 // PGlite single checked-out connection exercises prefetch outside bot lock.
 let sends=0;f.app.attachmentFetch=async(url,options)=>{sends++;assert.equal((await f.store.get('attachment_leases',owner)).leases.length,1);assert.match(url,/\/sendDocument$/);assert.equal(options.body.get('document').size,9);assert.equal(options.body.get('caption'),'caption');return new Response(JSON.stringify({ok:true,result:{message_id:88}}));};
 const args={to:'humanone',text:'caption',attachment_ids:[file.attachment_id],request_id:'tg-outgoing1'};
 assert.equal((await f.dms.send(f.b,args)).status,'accepted');await f.dms.send(f.b,args);assert.equal(sends,1);
 f.app.attachmentFetch=async()=>{sends++;throw Error('synthetic-token private-path');};
 const uncertain={...args,request_id:'tg-outgoing2'};const r=await f.dms.send(f.b,uncertain);assert.equal(r.status,'uncertain');assert.equal(JSON.stringify(r).includes('synthetic-token'),false);await f.dms.send(f.b,uncertain);assert.equal(sends,2);
 await assert.rejects(f.dms.send(f.b,{...uncertain,text:'changed'}),/different content/);

});
test('storage counts ciphertext overhead; monthly attempts fail closed and cleanup releases expired payloads',async t=>{
 const f=await fixture(t),a=await f.files.upload(f.a,upload());assert.equal(await f.store.attachmentStoredBytes(owner),9+28);
 const max=ATTACHMENT_POLICY.maxStoredBytes;try{ATTACHMENT_POLICY.maxStoredBytes=40;await assert.rejects(f.files.upload(f.a,upload('other','file','storage-test')),/capacity/);}finally{ATTACHMENT_POLICY.maxStoredBytes=max;}
 const day=Math.floor(Date.now()/86400000);
 await f.store.put('attachment_budget',owner,{owner,day,bytes:0,operations:0,history:[{day:day-1,bytes:0,uploads:500,reads:0}]});await assert.rejects(f.files.upload(f.a,upload('new','data','monthly-test')),/rolling/);
 await f.store.put('attachment_budget',owner,{owner,day,bytes:0,operations:0,history:[{day:day-1,bytes:0,uploads:0,reads:3000}]});await assert.rejects(f.files.bytes(f.a,a.attachment_id),/rolling/);
 await f.store.pruneAttachments(Date.now()+86400001);assert.equal(await f.store.attachmentStoredBytes(owner),0);assert.equal(await f.store.getAttachment(a.attachment_id),undefined);
});
test('Dot inbox and Grok/webhook adapters preserve attachment metadata without binary duplication',async t=>{
 const f=await fixture(t),a=await f.files.upload(f.a,upload());
 const dot=await registerAgent(f.app,{owner,authType:'api_key'},{handle:'dot'},{botType:'dot'});
 await f.dms.send(f.a,{to:'dot',attachment_ids:[a.attachment_id],request_id:'dot-file-001'});
 const {DotInbox}=await import('../src/dot-inbox.js');assert.equal((await new DotInbox(f.app).list({owner,agentId:dot.agent_id},{})).messages[0].attachments[0].attachment_id,a.attachment_id);
 const generic=await registerAgent(f.app,{owner,authType:'api_key'},{handle:'webhook'});let event;
 f.app.post=async(_,h,body)=>{const x=JSON.parse(body);if(x.type==='verification')return {status:200,body:JSON.stringify({challenge:x.challenge})};event=x;return {status:200,body:''};};
 await f.dms.subscription({owner,agentId:generic.agent_id},{name:'agent.notification',arguments:{},delivery:{mode:'webhook',url:'https://callback.example',secret:'whsec_'+Buffer.alloc(32,8).toString('base64')}});
 await f.dms.send(f.a,{to:'webhook',attachment_ids:[a.attachment_id],request_id:'web-file-001'});assert.equal(event.data.message.attachments[0].attachment_id,a.attachment_id);
 const {grokbotText}=await import('../src/grokbot.js');assert.match(grokbotText({name:'message.created',data:event.data.message}),new RegExp(a.attachment_id));assert.equal(JSON.stringify(event).includes(upload().data),false);
});

// These are structural byte fixtures, not playable recordings or codec acceptance.
function opusBytes(){
 const head=Buffer.alloc(19);head.write('OpusHead');head[8]=1;head[9]=1;head.writeUInt32LE(48000,12);
 const tags=Buffer.alloc(16);tags.write('OpusTags');
 const page=(packet,index)=>{const b=Buffer.alloc(28+packet.length);b.write('OggS');b[5]=index===0?2:index===2?4:0;b.writeUInt32LE(123,14);b.writeUInt32LE(index,18);b[26]=1;b[27]=packet.length;packet.copy(b,28);return b;};
 return Buffer.concat([page(head,0),page(tags,1),page(Buffer.from([0xf8,0xff,0xfe]),2)]);
}
function wavBytes(){const b=Buffer.alloc(46);b.write('RIFF');b.writeUInt32LE(38,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(2,40);return b;}
function mp3Bytes(){const frame=Buffer.alloc(417);Buffer.from([0xff,0xfb,0x90,0]).copy(frame);return Buffer.concat([frame,frame]);}
test('audio sniffing requires byte structure rather than filenames, declared MIME or lone signatures',()=>{
 assert.equal(mediaType(opusBytes()),'audio/ogg');assert.equal(mediaType(wavBytes()),'audio/wav');assert.equal(mediaType(mp3Bytes()),'audio/mpeg');
 const id3=Buffer.from([73,68,51,4,0,0,0,0,0,0]);assert.equal(mediaType(Buffer.concat([id3,mp3Bytes()])),'audio/mpeg');
 for(const b of [Buffer.from('OggSOpusHead'),Buffer.from('ID3'),Buffer.from('<audio src="evil"/>'),Buffer.from('<svg/>'),opusBytes().subarray(0,47),opusBytes().subarray(0,-1),wavBytes().subarray(0,-1),mp3Bytes().subarray(0,417)])assert.equal(mediaType(b),'application/octet-stream');
 const badOgg=opusBytes();badOgg[28+8]=99;assert.equal(mediaType(badOgg),'application/octet-stream');
 const badSequence=opusBytes();badSequence.writeUInt32LE(99,47+18);assert.equal(mediaType(badSequence),'application/octet-stream');
 const badWav=wavBytes();badWav.writeUInt16LE(99,32);assert.equal(mediaType(badWav),'application/octet-stream');
 const badMp3=mp3Bytes();badMp3[419]=0x94;assert.equal(mediaType(badMp3),'application/octet-stream');
 const badTag=Buffer.from(id3);badTag[6]=128;assert.equal(mediaType(Buffer.concat([badTag,mp3Bytes()])),'application/octet-stream');
});
test('recognized uploaded audio has one native block or explicit resource fallback with same bytes',async t=>{
 const f=await fixture(t),bytes=opusBytes(),a=await f.files.upload(f.a,{name:'misleading.txt',data:bytes.toString('base64'),request_id:'audio-upload-001'});
 assert.equal(a.mime_type,'audio/ogg');const native=await f.files.read(f.a,a.attachment_id);assert.equal(native.content.length,2);assert.deepEqual(native.content[1],{type:'audio',data:bytes.toString('base64'),mimeType:'audio/ogg'});
 const resource=await f.files.read(f.a,a.attachment_id,'resource');assert.equal(resource.content.length,2);assert.equal(resource.content[1].type,'resource');assert.equal(resource.content[1].resource.blob,bytes.toString('base64'));assert.deepEqual(resource.structuredContent,native.structuredContent);
 const rpc=await f.app.rpcCall(owner,'tools/call',{name:'attachments_read',arguments:{attachment_id:a.attachment_id,format:'resource'}},f.a);assert.equal(rpc.content.length,2);assert.equal(rpc.content[1].type,'resource');assert.equal(rpc.content[1].resource.blob,bytes.toString('base64'));
 const rpcNative=await f.app.rpcCall(owner,'tools/call',{name:'attachments_read',arguments:{attachment_id:a.attachment_id}},f.a);assert.equal(rpcNative.content[1].type,'audio');
 await assert.rejects(f.files.read(f.a,a.attachment_id,'url'),/Invalid attachment read format/);await assert.rejects(f.files.read(f.b,a.attachment_id),/not shared/);
 const catalog=(await import('../src/attachments.js')).attachmentTools.find(t=>t.name==='attachments_read');assert.deepEqual(catalog.inputSchema.required,['attachment_id']);assert.deepEqual(catalog.inputSchema.properties.format.enum,['native','resource']);
});
test('Telegram voice/audio metadata enters inbox without binary, captions survive and reads use actual MIME',async t=>{
 const f=await fixture(t),{bot,m}=await telegramFixture(f),bytes=opusBytes();let downloads=0;
 f.app.telegram=async(_,method,args)=>{if(method==='getFile'){assert.equal(args.file_id,'voice-file');return {file_path:'voice/file_1.oga'};}return {};};
 f.app.attachmentFetch=async()=>{downloads++;return new Response(bytes);};
 const voice={...m,document:undefined,voice:{file_id:'voice-file',file_size:bytes.length,mime_type:'text/html',duration:1}};
 await f.dms.receiveTelegram(bot,voice,901);await f.dms.receiveTelegram(bot,voice,901);assert.equal(downloads,1);
 const inbox=new MuseInbox(f.app),first=(await inbox.list(f.b,{})).messages[0];assert.equal(first.attachments[0].name,'voice.ogg');assert.equal(first.attachments[0].mime_type,'audio/ogg');assert.match(first.text,/attachments_read/);assert.equal(JSON.stringify(first).includes(bytes.toString('base64')),false);
 assert.equal((await f.files.read(f.b,first.attachments[0].attachment_id)).content[1].type,'audio');
 await f.dms.receiveTelegram(bot,{...voice,message_id:8,voice:undefined,audio:{file_id:'voice-file',file_size:bytes.length,file_name:'../../track\n\u202e.ogg',mime_type:'application/octet-stream'},caption:'A synthetic caption'},902);
 const audio=(await inbox.list(f.b,{})).messages.find(x=>x.attachments?.[0].name==='track.ogg');assert.ok(audio);assert.match(audio.text,/A synthetic caption/);assert.equal(audio.attachments[0].mime_type,'audio/ogg');
 f.app.attachmentFetch=async()=>new Response('not audio');
 const forged=await f.files.telegram(f.b,bot,{...voice,voice:undefined,audio:{file_id:'voice-file',file_size:9,mime_type:'audio/ogg'}},903);assert.equal(forged.attachment.name,'audio.bin');assert.equal(forged.attachment.mime_type,'application/octet-stream');assert.equal((await f.files.read(f.b,forged.attachment.attachment_id)).content[1].type,'resource');
 await f.store.delete('human',humanRecordId(owner,'humanone'));await assert.rejects(f.files.read(f.b,first.attachments[0].attachment_id),/revoked/);
});
test('Telegram voice preserves bounded download, unknown-size refusal and source recheck',async t=>{
 const f=await fixture(t),{bot,m}=await telegramFixture(f),bytes=opusBytes();let calls=0;
 f.app.telegram=async()=>{calls++;return {file_path:'voice/a.oga'};};
 const voice={...m,document:undefined,voice:{file_id:'voice-file',file_size:bytes.length}};
 for(const size of [undefined,0,-1,1.5,ATTACHMENT_POLICY.maxBytes+1])assert.deepEqual(await f.files.telegram(f.b,bot,{...voice,voice:{...voice.voice,file_size:size}},910),{error:'attachment_too_large_or_unknown_size'});
 assert.equal(calls,0);
 f.app.attachmentFetch=async()=>new Response(Buffer.concat([bytes,Buffer.from('extra')]));assert.deepEqual(await f.files.telegram(f.b,bot,voice,911),{error:'attachment_download_failed'});
 f.app.attachmentFetch=async()=>new Response(bytes.subarray(0,-1));assert.deepEqual(await f.files.telegram(f.b,bot,voice,912),{error:'attachment_download_failed'});
 f.app.attachmentFetch=async()=>{await f.store.put('group_bot',bot.id,{owner,agentId:f.b.agentId,bindingId:'new-binding'});return new Response(bytes);};await assert.rejects(f.files.telegram(f.b,bot,voice,913),/revoked/);
});
test('Telegram document and photo replies carry actual canonical target as multipart reply_parameters',async t=>{
 const f=await fixture(t),{bot,m}=await telegramFixture(f);
 f.app.telegram=async()=>({});
 await f.dms.receiveTelegram(bot,{...m,document:undefined,text:'synthetic question'},301);
 const incoming=(await new MuseInbox(f.app).list(f.b,{})).messages[0];
 const file=await f.files.upload(f.b,upload());
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHioAAAAASUVORK5CYII=';
 const photo=await f.files.upload(f.b,{name:'photo.png',data:png,request_id:'reply-photo-upload'});
 let sends=0;
 f.app.attachmentFetch=async(url,options)=>{
  assert.equal(new URL(url).pathname.endsWith(sends===0?'/sendDocument':'/sendPhoto'),true);
  assert.deepEqual(JSON.parse(options.body.get('reply_parameters')),{message_id:m.message_id});
  return new Response(JSON.stringify({ok:true,result:{message_id:88+(sends++)}}));
 };
 for(const [index,a] of [file,photo].entries()){
  const args={to:'humanone',text:'synthetic reply',attachment_ids:[a.attachment_id],reply_to_message_id:incoming.message_id,request_id:'multipart-reply-'+index};
  const sent=await f.dms.send(f.b,args);assert.equal(sent.status,'accepted');await f.dms.send(f.b,args);
 }
 assert.equal(sends,2);
});
