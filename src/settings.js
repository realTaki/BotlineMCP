import {INSTANCE_ID} from './config.js';
import {getAgent,normalizeAgentHandle} from './agents.js';
import {escapeHtml,hash,nonce,requireThat,same} from './security.js';

const COOKIE='__Host-mcp-settings';
const SESSION_KIND='settings_session';
const SESSION_MS=10*60*1000;
const MAX_FORM_BYTES=8192;
const TOKEN_LABEL='API KEY';
const COOKIE_FLAGS='Path=/; Secure; HttpOnly; SameSite=Strict';
const CSP="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function page(title,body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · BotlineMCP</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:38rem;margin:3rem auto;padding:0 1.25rem;color:#20252c;background:#f7f9fb}main{background:white;padding:2rem;border:1px solid #dce2e8;border-radius:12px}h1{margin-top:0;font-size:1.7rem}label{display:block;font-weight:600;margin:1.5rem 0 .5rem}input{display:block;box-sizing:border-box;width:100%;font:inherit;padding:.75rem;margin-top:.5rem;border:1px solid #758392;border-radius:6px}button{font:inherit;padding:.65rem 1rem;margin-top:1rem;border:0;border-radius:6px;background:#174a75;color:white}a{color:#174a75}.note{color:#4b5866;font-size:.95rem}</style></head><body><main>${body}</main></body></html>`;
}

function loginForm(origin) {
  return page('Settings',`<h1>Settings</h1><p>Sign in to this private BotlineMCP instance before adding a Telegram bot.</p><p class="note">${TOKEN_LABEL} means this instance’s long-lived MCP_API_KEY. It grants authority over every bot in this instance. Enter it only on ${escapeHtml(origin)}. Never paste credentials into chat.</p><form method="post" action="/settings/login" autocomplete="off"><label for="api-key">${TOKEN_LABEL}<input id="api-key" type="password" name="api_key" maxlength="1024" autocomplete="off" spellcheck="false" autocapitalize="none" required></label><button type="submit">Continue</button></form>`);
}

function botForm(session) {
  return page('Add Telegram bot',`<h1>Add Telegram bot</h1><p>Your settings session expires after 10 minutes and permits one binding attempt.</p><p>By submitting, you authorize BotlineMCP to verify this bot with Telegram, store an encrypted working copy of its token, and register its Telegram webhook for the existing agent handle you choose. Each agent handle can bind at most one bot. Groups and supergroups are ignored. An existing webhook belonging to another service will not be replaced.</p><p class="note">Registered humans can DM every bound bot. Groups and supergroups are ignored. Unregistered users are denied. Unbinding deletes the stored bot token; rebinding requires entering the token again. Keep the bot token and recovery configuration in your own secure store; database loss or lost keys can make the working copy unrecoverable.</p><form method="post" action="/settings/bind" autocomplete="off"><input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}"><label for="agent-handle">Existing agent handle<input id="agent-handle" name="agent_handle" maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,63}" autocomplete="off" spellcheck="false" autocapitalize="none" required></label><p class="note">Use a handle already registered by your agent. This form does not create an agent.</p><label for="bot-token">Telegram Bot Token<input id="bot-token" type="password" name="token" maxlength="256" autocomplete="off" spellcheck="false" autocapitalize="none" required></label><button type="submit">Bind bot</button></form>`);
}

function checkSingleHeaders(req) {
  const seen=new Set();
  for(let i=0;i<(req.rawHeaders?.length??0);i+=2) {
    const name=req.rawHeaders[i].toLowerCase();
    if(!['origin','content-type','content-length'].includes(name))continue;
    requireThat(!seen.has(name),'Invalid request',400);seen.add(name);
  }
}

function cookieToken(req) {
  const raw=req.headers.cookie;
  if(raw===undefined||raw==='')return null;
  requireThat(typeof raw==='string'&&Buffer.byteLength(raw)<=4096,'Invalid request',400);
  const cookies=new Map();
  for(const piece of raw.split(';')) {
    const at=piece.indexOf('='),name=piece.slice(0,at).trim(),value=piece.slice(at+1).trim();
    requireThat(at>0&&/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)&&(name!==COOKIE||!cookies.has(name)),'Invalid request',400);
    cookies.set(name,value);
  }
  const value=cookies.get(COOKIE);
  if(value===undefined)return null;
  requireThat(/^[A-Za-z0-9_-]{43}$/.test(value),'Invalid request',400);
  return value;
}

async function formFields(req,readBody,names) {
  requireThat(typeof req.headers['content-type']==='string'&&/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']),'Invalid request',415);
  const length=req.headers['content-length'];
  if(length!==undefined)requireThat(typeof length==='string'&&/^\d+$/.test(length)&&Number(length)<=MAX_FORM_BYTES,'Request too large',413);
  // Vercel's URL-encoded parser represents duplicate fields as arrays. Reject
  // arrays before readBody can stringify them and lose duplicate-field evidence.
  if(req.body!==undefined&&typeof req.body!=='string'&&!Buffer.isBuffer(req.body)) {
    requireThat(req.body&&typeof req.body==='object'&&!Array.isArray(req.body),'Invalid request');
    requireThat(Object.keys(req.body).length===names.length&&names.every(name=>Object.hasOwn(req.body,name)&&typeof req.body[name]==='string'),'Invalid request');
  }
  const fields=new URLSearchParams(await readBody(req,MAX_FORM_BYTES));
  requireThat([...fields].length===names.length&&names.every(name=>fields.getAll(name).length===1),'Invalid request');
  return Object.fromEntries(fields);
}

async function validSession(app,token) {
  if(!token)return null;
  const id=hash(token),session=await app.store.get(SESSION_KIND,id);
  if(!session)return null;
  if(!activeSession(app,session)) {await app.store.delete(SESSION_KIND,id);return null;}
  return session;
}

function activeSession(app,session) {
  return !!app.instanceKeyHash&&session.owner===INSTANCE_ID&&Number.isFinite(session.expires)&&session.expires>Date.now()&&same(session.authVersion,app.instanceKeyHash)&&typeof session.csrf==='string'&&/^[A-Za-z0-9_-]{43}$/.test(session.csrf);
}

function clearCookie(res) {res.setHeader('Set-Cookie',`${COOKIE}=; ${COOKIE_FLAGS}; Max-Age=0`);}

export async function settings(app,req,path,readBody,send,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Security-Policy',CSP);
  // Keep native form POST Origin headers available while omitting referrer paths.
  res.setHeader('Referrer-Policy','strict-origin');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Vary','Cookie');
  const html=(status,value)=>send(status,value,'text/html; charset=utf-8');
  try {
    checkSingleHeaders(req);
    requireThat(!new URL(req.url,app.origin).search,'Invalid request');
    const token=cookieToken(req);
    if(req.method==='GET'&&(path==='/settings'||path==='/settings/bot')) {
      const session=await validSession(app,token);
      if(session)return html(200,botForm(session));
      if(token)clearCookie(res);
      requireThat(path==='/settings','Authentication required',401);
      return html(200,loginForm(app.origin));
    }
    requireThat(['/settings/login','/settings/bind'].includes(path),'Not found',404);
    requireThat(req.method==='POST','Method not allowed',405);
    requireThat(typeof req.headers.origin==='string'&&req.headers.origin===app.origin,'Request rejected',403);
    if(path==='/settings/login') {
      const fields=await formFields(req,readBody,['api_key']);
      requireThat(fields.api_key.length>=32&&fields.api_key.length<=1024&&app.instanceKeyHash&&same(hash(fields.api_key),app.instanceKeyHash),'Authentication required',401);
      if(token)await app.store.delete(SESSION_KIND,hash(token));
      const fresh=nonce(),session={owner:INSTANCE_ID,expires:Date.now()+SESSION_MS,authVersion:app.instanceKeyHash,csrf:nonce()};
      await app.store.put(SESSION_KIND,hash(fresh),session);
      res.setHeader('Set-Cookie',`${COOKIE}=${fresh}; ${COOKIE_FLAGS}; Max-Age=${SESSION_MS/1000}`);
      res.setHeader('Location','/settings/bot');res.statusCode=303;return res.end();
    }
    const session=await validSession(app,token);
    requireThat(session,'Authentication required',401);
    const fields=await formFields(req,readBody,['csrf','token','agent_handle']);
    requireThat(same(fields.csrf,session.csrf),'Request rejected',403);
    requireThat(fields.token.length<=256&&/^\d+:[A-Za-z0-9_-]{20,}$/.test(fields.token),'Invalid request');
    const handle=normalizeAgentHandle(fields.agent_handle);
    const agent=await getAgent(app,INSTANCE_ID,'agent_'+hash(JSON.stringify([INSTANCE_ID,handle])));
    requireThat(agent,'Registered agent handle required');
    // Validate before consuming to prevent unauthenticated/CSRF denial of service.
    // The database DELETE ... RETURNING is atomic across concurrent workers.
    const consumed=await app.store.take(SESSION_KIND,hash(token));
    clearCookie(res);
    requireThat(consumed&&activeSession(app,consumed)&&same(consumed.csrf,fields.csrf),'Authentication required',401);
    let result;
    try {result=await app.bind(INSTANCE_ID,{token:fields.token},{agentId:agent.agent_id});}
    catch {return html(502,page('Binding unconfirmed','<h1>Binding could not be confirmed</h1><p>This one-use session has ended. Check telegram_bot_get with your connected agent before trying again. A Telegram request may have succeeded even if its response was lost. Do not automatically retry.</p><p><a href="/settings">Return to Settings</a></p>'));}
    const botId=/^\d+$/.test(result.bot_id)?result.bot_id:'unavailable';
    const username=typeof result.username==='string'&&/^[A-Za-z0-9_]{1,64}$/.test(result.username)?` (@${escapeHtml(result.username)})`:'';
    return html(200,page('Bot bound',`<h1>Bot bound</h1><p>Telegram bot ${escapeHtml(botId)}${username} is connected.</p><p>Ask your agent to verify telegram_bot_get, call human_register once with a confirmed human and telegram_user_id, and maintain its agent.notification inbox subscription. Registered humans can DM every bound bot. Groups are ignored. Unregistered users are denied. No bot token is needed for these steps.</p><p><a href="/settings">Return to Settings</a></p>`));
  } catch(error) {
    if(error.status===401)clearCookie(res);
    if(error.status===405)res.setHeader('Allow','POST');
    const status=[400,401,403,404,405,413,415].includes(error.status)?error.status:500;
    const message=status===401?'Authentication required or session expired.':status===403?'Request rejected.':'Unable to complete this settings request.';
    return html(status,page('Settings request',`<h1>${message}</h1><p><a href="/settings">Return to Settings</a></p>`));
  }
}

