-- Schema reference for tests and manual inspection; application initialization creates it automatically.
-- No credentials belong in this repository.
CREATE TABLE IF NOT EXISTS mcp_records (
  kind text NOT NULL,
  id text NOT NULL,
  value jsonb NOT NULL,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS mcp_records_owner ON mcp_records (kind, (value->>'owner'));
CREATE INDEX IF NOT EXISTS mcp_records_denied_expiry ON mcp_records (((value->>'expires')::bigint))
  WHERE kind='denied_limit' OR (kind='update' AND value->>'denied'='true');
CREATE INDEX IF NOT EXISTS mcp_records_access_notice_expiry ON mcp_records (((value->>'expires')::bigint))
  WHERE kind='access_notice';
CREATE INDEX IF NOT EXISTS mcp_records_access_notice_bot ON mcp_records ((value->>'botId'))
  WHERE kind='access_notice';
-- Denied-message receipts expire after 7 days; hashed, bounded reply limiter state
-- expires after 10 minutes. Application initialization and denied traffic prune both.
-- Fixed permission-change notice intents expire after 7 days and are capped at
-- 4096 per bot. Initialization and access updates prune expired notice records.
-- Periodically purge expired OAuth and Settings sessions, terminal deliveries, and old
-- send receipts according to your retention policy. Keep pending deliveries and active subscriptions.
