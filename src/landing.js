import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../public/index.html', import.meta.url),'utf8');
const script=readFileSync(new URL('../public/home.js', import.meta.url),'utf8');
const guide=readFileSync(new URL('../public/setup.md', import.meta.url),'utf8');
export const LANDING_CSP="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
const files=new Map([
 ['/',{body:html,type:'text/html; charset=utf-8'}],
 ['/index.html',{body:html,type:'text/html; charset=utf-8'}],
 ['/home.js',{body:script,type:'text/javascript; charset=utf-8'}],
 ['/setup.md',{body:guide,type:'text/markdown; charset=utf-8'}],
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
