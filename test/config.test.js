import test from 'node:test';
import assert from 'node:assert/strict';
import {configuration} from '../src/config.js';
import {App} from '../src/app.js';
import {hash} from '../src/security.js';
const env={ASP_API_KEY:'a'.repeat(64),DATABASE_URL:'postgres://test',VERCEL_PROJECT_PRODUCTION_URL:'example.vercel.app'};
test('one manual key plus injected database and production domain derives stable encryption',()=>{const a=configuration(env),b=configuration(env);assert.equal(a.key,b.key);assert.equal(Buffer.from(a.key,'base64').length,32);assert.equal(a.origin,'https://example.vercel.app');assert.notEqual(a.key,env.ASP_API_KEY);assert.notEqual(configuration({...env,ASP_API_KEY:'b'.repeat(64)}).key,a.key);});
test('configuration rejects missing key/database, untrusted origin and unstable deployment fallback',()=>{assert.throws(()=>configuration({...env,ASP_API_KEY:''}));assert.throws(()=>configuration({...env,DATABASE_URL:''}));assert.equal(configuration({...env,PUBLIC_ORIGIN:'https://evil.test'}).origin,'https://example.vercel.app');assert.throws(()=>configuration({...env,VERCEL_PROJECT_PRODUCTION_URL:'example.com/path'}));assert.throws(()=>configuration({...env,VERCEL_PROJECT_PRODUCTION_URL:'',VERCEL_URL:'random.vercel.app'}));});
test('v2 encrypted secrets use the derived key and fail after ASP_API_KEY rotation',()=>{const cfg=configuration(env),a=new App(cfg);const plain='synthetic-test-secret';const current=a.encrypt(plain);assert(current.startsWith('v2.'));assert.equal(new App(configuration(env)).decrypt(current),plain);assert.throws(()=>new App(configuration({...env,ASP_API_KEY:'c'.repeat(64)})).decrypt(current));});
test('retired env aliases are not accepted',()=>{
 const {ASP_API_KEY,...base}=env;
 assert.throws(()=>configuration({...base,INSTANCE_KEY:ASP_API_KEY}));
 assert.throws(()=>configuration({...base,ADMIN_CODE:ASP_API_KEY}));
 const cfg=configuration({...env,ENCRYPTION_KEY:Buffer.alloc(32,9).toString('base64'),INSTANCE_KEY:'b'.repeat(64),ADMIN_CODE:'c'.repeat(64)});
 assert.equal(cfg.instanceKey,ASP_API_KEY);
 assert.equal(cfg.key,configuration(env).key);
 assert.equal(cfg.legacyKey,undefined);
 assert.equal(cfg.grokbotBridge,undefined);
});
test('instance hash follows ASP_API_KEY only',()=>{
 const cfg=configuration(env);
 assert.equal(new App(cfg).instanceKeyHash,hash(env.ASP_API_KEY));
});
