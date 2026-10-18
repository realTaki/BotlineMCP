import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../public/index.html', import.meta.url),'utf8');
const script=readFileSync(new URL('../public/home.js', import.meta.url),'utf8');
export const SETUP_GUIDE=readFileSync(new URL('../public/setup.md', import.meta.url),'utf8');
export const LANDING_CSP="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const files=new Map([
 ['/',{body:html,type:'text/html; charset=utf-8'}],
 ['/index.html',{body:html,type:'text/html; charset=utf-8'}],
 ['/home.js',{body:script,type:'text/javascript; charset=utf-8'}],
 ['/setup.md',{body:SETUP_GUIDE,type:'text/markdown; charset=utf-8'}],
]);

export function tryLanding(req,res,path){
 const file=files.get(path);
 if(!file)return false;
 res.setHeader('Cache-Control','no-store');
 res.setHeader('Referrer-Policy','strict-origin');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',LANDING_CSP);
 if(req.method!=='GET'&&req.method!=='HEAD'){
  res.statusCode=405;
  res.setHeader('Allow','GET, HEAD');
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({error:'Method not allowed'}));
  return true;
 }
 res.statusCode=200;
 res.setHeader('Content-Type',file.type);
 res.end(req.method==='HEAD'?'':file.body);
 return true;
}

// Explicit HTML navigation only; preserve no-Accept and SSE client behavior.
export function tryMcpGuide(req,res){
 const accepted=String(req.headers.accept??'').split(',').map(part=>{
  const [type,...params]=part.trim().toLowerCase().split(';');
  const q=params.map(p=>p.trim()).find(p=>p.startsWith('q='));
  return {type,q:q?Number(q.slice(2)):1};
 });
 res.setHeader('Vary','Accept');
 if(!accepted.some(a=>a.type==='text/html'&&a.q>0)||accepted.some(a=>a.type==='text/event-stream'&&a.q>0))return false;
 res.statusCode=200;
 res.setHeader('Content-Type','text/html; charset=utf-8');
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',LANDING_CSP);
 res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>BotlineMCP setup</title><h1>Connect to this BotlineMCP instance</h1><p>Read the <a href="/setup.md">public setup guide</a> on this same server before authenticating. Public discovery does not grant instance access.</p><p>Obtain authorization and a secure credential path from the instance owner. Choose dot OAuth and wake/pull, Muse polling, Grok direct delivery, or a generic webhook receiver. Never paste secrets into chat.</p><p>MCP clients use POST on this /mcp endpoint; event-stream clients retain GET SSE. <a href="/">Service overview</a></p></html>');
 return true;
}
