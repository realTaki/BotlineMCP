import pg from 'pg';
import {DENIED_REPLY_POLICY,nextDeniedReplyState} from './denied-replies.js';
import {telegramHumanAllowed} from './telegram-policy.js';
export class Store {
  async telegramReactionSnapshot(botId,owner,agentId,chatId) {
    // One MVCC statement: no stale bot snapshot while awaiting human mappings.
    const result=await this.pool.query(`SELECT
      (SELECT value FROM mcp_records WHERE kind='bot' AND id=$1) AS bot,
      (SELECT value FROM mcp_records WHERE kind='group_bot' AND id=$1) AS route,
      (SELECT value FROM mcp_records WHERE kind='agent' AND id=$3) AS agent,
      (SELECT value FROM mcp_records WHERE kind='chat' AND id=$4) AS chat,
      COALESCE((SELECT jsonb_agg(value) FROM mcp_records WHERE kind='human' AND value->>'owner'=$2),'[]'::jsonb) AS humans`,[botId,owner,agentId,chatId]);
    return result.rows[0];
  }

  async pruneGroupTransport(now=Date.now()) {
    await this.pool.query("DELETE FROM mcp_records WHERE kind IN ('group_delivery','group_receipt','dot_inbox') AND (value->>'expires')::bigint<=$1",[now]);
  }
  // Use only on a Store whose connection is already checked out (withBotLock).
  // A second checkout here can deadlock the bounded pool. Session and xact
  // advisory locks use the same key space, so this serializes inbox ingress.
  async withHeldConnectionLock(key,fn) {
    await this.pool.query('SELECT pg_advisory_lock(hashtext($1))',[key]);
    try{return await fn(this);}finally{await this.pool.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);}
  }
  async withBotLock(key,fn) {
    const client=await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))',[key]);
      const locked=Object.create(Store.prototype);locked.pool=client;
      return await fn(locked);
    } finally {let unlockError;try{await client.query('SELECT pg_advisory_unlock(hashtext($1))',[key]);}catch(e){unlockError=e;throw e;}finally{client.release(unlockError);}}
  }
  async withLock(key,fn) {
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
      const tx=Object.create(Store.prototype);tx.pool=client;
      const result=await fn(tx);await client.query('COMMIT');return result;
    } catch(e) {try{await client.query('ROLLBACK');}catch{}throw e;}
    finally {client.release();}
  }
  constructor(url) { this.pool = new pg.Pool({connectionString:url,max:3,connectionTimeoutMillis:5000,idleTimeoutMillis:10000}); }
  async initialize() { await this.pool.query('CREATE TABLE IF NOT EXISTS mcp_records (kind text NOT NULL, id text NOT NULL, value jsonb NOT NULL, PRIMARY KEY(kind,id))'); await this.pool.query("CREATE INDEX IF NOT EXISTS mcp_records_owner ON mcp_records (kind, (value->>'owner'))"); await this.pool.query("CREATE INDEX IF NOT EXISTS mcp_records_denied_expiry ON mcp_records (((value->>'expires')::bigint)) WHERE kind='denied_limit' OR (kind='update' AND value->>'denied'='true')"); await this.pool.query('DROP INDEX IF EXISTS mcp_records_access_notice_expiry'); await this.pool.query('DROP INDEX IF EXISTS mcp_records_access_notice_bot'); await this.pruneDeniedReplies(); }
  async get(kind, id) { return (await this.pool.query('SELECT value FROM mcp_records WHERE kind=$1 AND id=$2',[kind,id])).rows[0]?.value; }
  async put(kind,id,value) { await this.pool.query('INSERT INTO mcp_records(kind,id,value) VALUES($1,$2,$3) ON CONFLICT(kind,id) DO UPDATE SET value=EXCLUDED.value',[kind,id,value]); }
  async insert(kind,id,value) { return (await this.pool.query('INSERT INTO mcp_records(kind,id,value) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id',[kind,id,value])).rowCount === 1; }
  async delete(kind,id) { await this.pool.query('DELETE FROM mcp_records WHERE kind=$1 AND id=$2',[kind,id]); }
  async list(kind,owner) {
    const rows=(await this.pool.query(`SELECT id,value FROM mcp_records WHERE kind=$1 AND ($2::text IS NULL OR value->>'owner'=$2) AND ($1 != 'delivery' OR value->>'state'='pending') LIMIT 1001`,[kind,owner ?? null])).rows;
    if(rows.length>1000) throw new Error('Store scan capacity exceeded; add pagination before scaling.');
    return rows.map(r=>({...r.value,id:r.id}));
  }
  async take(kind,id) { return (await this.pool.query('DELETE FROM mcp_records WHERE kind=$1 AND id=$2 RETURNING value',[kind,id])).rows[0]?.value; }
  async pruneDeniedReplies(now=Date.now()) {
    await this.pool.query(`DELETE FROM mcp_records WHERE (kind='denied_limit' OR kind='oauth_limit' OR (kind='update' AND value->>'denied'='true')) AND (value->>'expires')::bigint<=$1`,[now]);
  }
  async reserveDeniedReply(botId,updateId,senderId,chatId,now=Date.now()) {
    // Expiry cleanup runs on initialization and denied traffic, including other
    // bots' old records. No denied message text or raw sender/chat IDs are stored.
    await this.pruneDeniedReplies(now);
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The bot row serializes reservations across processes and restarts. Humans
      // are read in the same transaction so a concurrent human_register cannot
      // race a denial for a sender who is already registered.
      const bot=(await client.query("SELECT value FROM mcp_records WHERE kind='bot' AND id=$1 FOR UPDATE",[botId])).rows[0]?.value;
      let reserved=false;
      const humans=bot?(await client.query("SELECT value FROM mcp_records WHERE kind='human' AND value->>'owner'=$1",[bot.owner])).rows.map(r=>r.value):[];
      if(bot?.active&&!telegramHumanAllowed(humans,senderId)) {
        const receiptId=`${botId}:${updateId}`,receipt={owner:bot.owner,botId,denied:true,state:'suppressed',created:now,expires:now+DENIED_REPLY_POLICY.receiptTtl};
        const inserted=await client.query("INSERT INTO mcp_records(kind,id,value) VALUES('update',$1,$2) ON CONFLICT DO NOTHING RETURNING id",[receiptId,JSON.stringify(receipt)]);
        if(inserted.rowCount===1) {
          const previous=(await client.query("SELECT value FROM mcp_records WHERE kind='denied_limit' AND id=$1",[botId])).rows[0]?.value;
          const next=nextDeniedReplyState(previous,senderId,chatId,now);
          if(next) {
            await client.query("INSERT INTO mcp_records(kind,id,value) VALUES('denied_limit',$1,$2) ON CONFLICT(kind,id) DO UPDATE SET value=EXCLUDED.value",[botId,JSON.stringify(next)]);
            receipt.state='intent';
            await client.query("UPDATE mcp_records SET value=$2::jsonb WHERE kind='update' AND id=$1",[receiptId,JSON.stringify(receipt)]);
            reserved=true;
          }
        }
      }
      // Commit send intent before any Telegram side effect. A crash/ambiguous
      // send deliberately leaves it consumed; webhook retries cannot resend it.
      await client.query('COMMIT');
      return reserved;
    } catch(e) {try{await client.query('ROLLBACK');}catch{}throw e;}
    finally {client.release();}
  }
  async lease(kind,id,ttl=30000) {
    const now=Date.now(); return (await this.pool.query(`UPDATE mcp_records SET value=jsonb_set(value,'{leaseUntil}',to_jsonb($3::bigint)) WHERE kind=$1 AND id=$2 AND COALESCE((value->>'leaseUntil')::bigint,0)<$4 RETURNING value`,[kind,id,now+ttl,now])).rows[0]?.value;
  }
}

