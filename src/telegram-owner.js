import {hash,requireThat} from './security.js';
import {normalizeAgentHandle} from './agents.js';

const positiveId=value=>Number.isSafeInteger(value)&&value>0;
const publicHuman=record=>({handle:record.handle,display_name:record.display_name,type:'human',telegram_user_id:record.telegram_user_id,provenance:record.provenance,configured_at:record.configured_at});
export const humanRecordId=(owner,handle)=>hash(JSON.stringify([owner,handle]));
export const humanKey=humanRecordId;
export async function getHuman(app,owner,handle){
 if(handle===undefined)return null;
 const human=await app.store.get('human',humanKey(owner,normalizeAgentHandle(handle)));
 return human?.owner===owner?publicHuman(human):null;
}
export async function listHumans(app,owner){
 return (await app.store.list('human',owner)).map(publicHuman).sort((a,b)=>a.handle.localeCompare(b.handle));
}
export async function getHumanByTelegramId(app,owner,id){
 return (await listHumans(app,owner)).find(human=>human.telegram_user_id===id)??null;
}
export async function prepareHuman(store,owner,args={}){
 requireThat(typeof owner==='string'&&owner.length>0,'Authentication required',401);
 const handle=normalizeAgentHandle(args.human_handle);
 const displayName=args.human_display_name===undefined?handle:args.human_display_name;
 requireThat(typeof displayName==='string'&&displayName.trim().length>0&&displayName.length<=128,'Human display name must be 1–128 characters');
 requireThat(typeof args.telegram_user_id==='string'&&/^[1-9]\d*$/.test(args.telegram_user_id)&&positiveId(Number(args.telegram_user_id)),'A positive numeric Telegram user ID is required');
  const existing=await store.get('human',humanRecordId(owner,handle));
  requireThat(!existing||existing.telegram_user_id===args.telegram_user_id||args.replace_telegram_user_id===existing.telegram_user_id,'Replacing this handle requires its current Telegram user ID',409);
  requireThat(!(await store.list('agent',owner)).some(agent=>agent.handle===handle),'Human handle is already used by an agent',409);
  requireThat(!(await store.list('human',owner)).some(human=>human.telegram_user_id===args.telegram_user_id&&human.handle!==handle),'Telegram user ID is already assigned to another human handle',409);
  // Explicit configuration by an authenticated owner is provenance, not proof
  // that the owner controls the Telegram account. Never infer it from an incoming message.
  const record={owner,handle,display_name:args.human_display_name===undefined&&existing?existing.display_name:displayName.trim(),type:'human',telegram_user_id:args.telegram_user_id,provenance:'configured_by_authenticated_owner',configured_at:new Date().toISOString()};
  return {existing,record,human:publicHuman(record)};
}
export async function configureHuman(app,owner,args={}){
 return app.store.withLock('human:'+owner,async store=>{
  const {record,human}=await prepareHuman(store,owner,args);
  await store.put('human',humanKey(owner,record.handle),record);return human;
 });
}
export class TelegramOwner {
 constructor(app){this.app=app;}
 // BotlineMCP is private-DM only. Group and supergroup joins are ignored.
 async join(){return null;}
}
