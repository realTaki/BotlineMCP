import { createHash, createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const nonce = () => randomBytes(32).toString('base64url');
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function requireThat(ok, message = 'Invalid request', status = 400) { if (!ok) throw Object.assign(new Error(message), { status }); }
export function seal(text, key) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  return Buffer.concat([iv, c.update(text, 'utf8'), c.final(), c.getAuthTag()]).toString('base64');
}
export function unseal(value, key) {
  const b = Buffer.from(value, 'base64'), d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), b.subarray(0, 12));
  d.setAuthTag(b.subarray(-16)); return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString('utf8');
}
export function signingKey(secret) {
  requireThat(typeof secret === 'string' && /^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret), 'Invalid signing secret');
  const b = Buffer.from(secret.slice(6), 'base64'); requireThat(b.length >= 24 && b.length <= 64, 'Invalid signing secret'); return b;
}
export function signedHeaders(secret, subscriptionId, id, body, time = Math.floor(Date.now()/1000)) {
  return {'content-type':'application/json', 'webhook-id':id,'webhook-timestamp':String(time),'webhook-signature':`v1,${createHmac('sha256', signingKey(secret)).update(`${id}.${time}.${body}`).digest('base64')}`,'X-MCP-Subscription-Id':subscriptionId};
}
export function publicAddress(address) {
  try { const ip = ipaddr.process(address); return ip.range() === 'unicast'; } catch { return false; }
}
// Pin the validated IP to the socket; do not resolve again between validation and connection.
export async function callbackPost(url, headers, body) {
  const u = new URL(url);
  requireThat(u.protocol === 'https:' && !u.username && !u.password && !u.hash && (!u.port || u.port === '443'), 'Invalid callback URL');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(host, { all:true });
  requireThat(addresses.length > 0 && addresses.every(a => publicAddress(a.address)), 'Non-public callback blocked');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const req = https.request(u, {method:'POST',headers,agent:false,lookup: (_host, options, cb) => options?.all ? cb(null,[address]) : cb(null,address.address,address.family)}, res => {
      let data = '', size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 262144) { req.destroy(new Error('Response too large')); return; } data += chunk; });
      res.on('end', () => resolve({status:res.statusCode, body:data}));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Callback timeout')));
    req.on('error', () => reject(new Error('Callback connection failed'))); req.end(body);
  });
}
export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
