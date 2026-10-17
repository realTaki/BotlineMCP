import {hkdfSync} from 'node:crypto';
import {requireThat} from './security.js';
export const INSTANCE_ID='asp:admin'; // Legacy storage namespace only; never an agent ID or role. Preserves existing ownership and grants.
export function configuration(env){
 const instanceKey=env.ASP_API_KEY;
 requireThat(typeof instanceKey==='string'&&instanceKey.length>=32,'Configure a random ASP_API_KEY of at least 32 characters',503);
 const databaseUrl=env.DATABASE_URL||env.POSTGRES_URL;
 requireThat(databaseUrl,'Connect a Postgres integration',503);
 const raw=env.VERCEL_PROJECT_PRODUCTION_URL?'https://'+env.VERCEL_PROJECT_PRODUCTION_URL:null;
 requireThat(raw,'Production domain is unavailable; enable Vercel system variables',503);
 const origin=new URL(raw);requireThat(origin.protocol==='https:'&&origin.origin===raw&&!origin.username&&!origin.password,'Invalid public origin',503);
 // Stable legacy derivation label: changing it would invalidate stored ciphertext.
 const key=Buffer.from(hkdfSync('sha256',instanceKey,'taki-asp/v1','stored-secret-encryption',32)).toString('base64');
 return {instanceKey,databaseUrl,origin:origin.origin,key};
}
