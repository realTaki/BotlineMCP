# Assign an existing legacy bot to a registered agent

Prefer the server MCP path when the deployed tool supports it:

1. Reconnect OAuth normally if needed, register the intended agent through the normal MCP flow, and verify `agent_whoami`.
2. Establish an unexpired inbox `agent.notification` subscription with empty arguments. A legacy per-chat listener is not sufficient for error notifications.
3. Call `telegram_bot_bind({"existing_bot_id":"<bot_id>"})` as that registered agent. This path reuses the stored encrypted token inside the server, checks the existing Telegram webhook, and requests `message` and `my_chat_member` updates. It must not export a plaintext token or replace another service's webhook.
4. Verify binding, listener readiness, webhook update types, and an authorized test message separately. A successful database change does not prove Telegram delivery.

If the deployed tool does not yet support `existing_bot_id`, deploy the reviewed server change or wait. Do not manufacture an OAuth session, access token, refresh grant, agent record, or callback subscription in SQL to bypass missing connection or setup.

## Optional SQL path

Run the following only if the owner explicitly chooses database migration. This is an operational fallback, not an automatic migration. It uses the existing `asp_records(kind, id, value)` schema and changes only one `group_bot` routing record. It never creates an agent or credential, edits the encrypted bot token, or modifies legacy subscriptions.

Before running either block, replace `<bot_id>` with the existing numeric Telegram bot ID and `<agent_handle>` with the intended already-registered handle. Use only digits for the bot ID and letters, digits, underscore or hyphen for the handle; do not paste arbitrary SQL or credentials into either placeholder. Run in the intended instance database using the owner's normal secure database access. Do not put database credentials or result sets containing secrets into chat.

The first block is read-only and emits only existence/readiness booleans, the matching-agent count, and the currently assigned handle. It deliberately does not return tokens, callback URLs/secrets, OAuth grants, or raw JSON records.

```sql
-- legacy-migration:inspect
WITH parameters AS (
  SELECT '<bot_id>'::text AS bot_id,
         lower(btrim('<agent_handle>'))::text AS agent_handle
), bot AS (
  SELECT r.value FROM asp_records r, parameters p
  WHERE r.kind = 'bot' AND r.id = p.bot_id
), agents AS (
  SELECT r.id, r.value FROM asp_records r, parameters p, bot b
  WHERE r.kind = 'agent'
    AND r.value->>'owner' = b.value->>'owner'
    AND r.value->>'handle' = p.agent_handle
), main_listeners AS (
  SELECT s.id FROM asp_records s, agents a, bot b
  WHERE s.kind = 'group_subscription'
    AND s.id = encode(sha256(convert_to('[' || to_json(a.id)::text || ',"chat.created",null]', 'UTF8')), 'hex')
    AND s.value->>'owner' = b.value->>'owner'
    AND s.value->>'agentId' = a.id
    AND s.value->>'name' = 'agent.notification'
    AND s.value->>'chatId' IS NULL
    AND (s.value->>'expires')::numeric > extract(epoch FROM clock_timestamp()) * 1000
    AND jsonb_typeof(s.value->'url') = 'string'
    AND length(s.value->>'url') > 0
    AND jsonb_typeof(s.value->'secret') = 'string'
    AND length(s.value->>'secret') > 0
)
SELECT
  EXISTS (SELECT 1 FROM bot) AS bot_exists,
  COALESCE((SELECT value->'active' = 'true'::jsonb FROM bot), false) AS bot_active,
  COALESCE((SELECT jsonb_typeof(value->'token') = 'string' AND length(value->>'token') > 0 FROM bot), false) AS token_present,
  (SELECT count(*) FROM agents) AS matching_registered_agent_count,
  (SELECT a.value->>'handle'
   FROM asp_records r JOIN asp_records a
     ON a.kind = 'agent' AND a.id = r.value->>'agentId'
       AND a.value->>'owner' = r.value->>'owner'
   JOIN parameters p ON p.bot_id = r.id
   WHERE r.kind = 'group_bot') AS current_assigned_handle,
  EXISTS (SELECT 1 FROM asp_records r, agents a, parameters p
          WHERE r.kind = 'group_bot' AND r.value->>'agentId' = a.id AND r.id <> p.bot_id) AS other_bot_for_handle,
  EXISTS (SELECT 1 FROM main_listeners) AS valid_main_listener;
```

Proceed only when the bot exists and is active, its encrypted token is present, exactly one registered agent matches, no different handle owns this bot, that agent has no other bot, and its generic main listener is ready. The transaction repeats these checks under locks, so the read-only result is not permission to ignore a later failure.

**The next block activates relay routing.** A valid main listener is mandatory. It takes the same PostgreSQL advisory-lock key used by the server's bot-binding operations; transaction-level and session-level advisory locks coordinate on that key. Any ambiguity or failed prerequisite raises an exception. If a client stops on an error while leaving the transaction open, issue `ROLLBACK;` before doing anything else. Never continue by selectively executing later statements.

```sql
-- legacy-migration:apply
BEGIN;
DO $migration$
DECLARE
  requested_bot_id text := '<bot_id>';
  requested_handle text := lower(btrim('<agent_handle>'));
  instance_owner text;
  locked_bot jsonb;
  selected_agent_id text;
  selected_agent jsonb;
  agent_count bigint;
  current_route jsonb;
  main_listener jsonb;
  main_listener_id text;
BEGIN
  IF requested_bot_id !~ '^[1-9][0-9]*$'
     OR length(requested_bot_id) > 16
     OR requested_bot_id::numeric > 9007199254740991
     OR requested_handle !~ '^[a-z0-9][a-z0-9_-]{1,63}$' THEN
    RAISE EXCEPTION 'Invalid bot ID or registered agent handle';
  END IF;

  SELECT value->>'owner' INTO instance_owner
    FROM asp_records WHERE kind = 'bot' AND id = requested_bot_id;
  IF instance_owner IS NULL OR instance_owner = '' THEN
    RAISE EXCEPTION 'Existing instance bot not found';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('bot-binding:' || instance_owner));

  SELECT value INTO locked_bot FROM asp_records
    WHERE kind = 'bot' AND id = requested_bot_id FOR UPDATE;
  IF locked_bot IS NULL
     OR locked_bot->>'owner' IS DISTINCT FROM instance_owner
     OR locked_bot->'active' IS DISTINCT FROM 'true'::jsonb
     OR locked_bot->'unbound' = 'true'::jsonb
     OR jsonb_typeof(locked_bot->'token') IS DISTINCT FROM 'string'
     OR COALESCE(length(locked_bot->>'token'), 0) = 0 THEN
    RAISE EXCEPTION 'Bot must be active and retain its encrypted token';
  END IF;

  SELECT count(*) INTO agent_count FROM asp_records
    WHERE kind = 'agent' AND value->>'owner' = instance_owner
      AND value->>'handle' = requested_handle;
  IF agent_count <> 1 THEN
    RAISE EXCEPTION 'Exactly one normally registered agent must match';
  END IF;
  SELECT id, value INTO selected_agent_id, selected_agent FROM asp_records
    WHERE kind = 'agent' AND value->>'owner' = instance_owner
      AND value->>'handle' = requested_handle FOR UPDATE;
  IF selected_agent->>'agentId' IS DISTINCT FROM selected_agent_id THEN
    RAISE EXCEPTION 'Registered agent identity is inconsistent';
  END IF;

  main_listener_id := encode(sha256(convert_to('[' || to_json(selected_agent_id)::text || ',"chat.created",null]', 'UTF8')), 'hex');
  SELECT value INTO main_listener FROM asp_records
    WHERE kind = 'group_subscription' AND id = main_listener_id FOR UPDATE;
  IF main_listener IS NULL
     OR main_listener->>'owner' IS DISTINCT FROM instance_owner
     OR main_listener->>'agentId' IS DISTINCT FROM selected_agent_id
     OR main_listener->>'name' IS DISTINCT FROM 'agent.notification'
     OR main_listener->>'chatId' IS NOT NULL
     OR COALESCE((main_listener->>'expires')::numeric, 0) <= extract(epoch FROM clock_timestamp()) * 1000
     OR jsonb_typeof(main_listener->'url') IS DISTINCT FROM 'string'
     OR COALESCE(length(main_listener->>'url'), 0) = 0
     OR jsonb_typeof(main_listener->'secret') IS DISTINCT FROM 'string'
     OR COALESCE(length(main_listener->>'secret'), 0) = 0 THEN
    RAISE EXCEPTION 'An unexpired main agent.notification listener is required';
  END IF;

  IF EXISTS (SELECT 1 FROM asp_records
             WHERE kind = 'group_bot' AND value->>'agentId' = selected_agent_id
               AND id <> requested_bot_id) THEN
    RAISE EXCEPTION 'The selected agent already has another bot';
  END IF;
  SELECT value INTO current_route FROM asp_records
    WHERE kind = 'group_bot' AND id = requested_bot_id FOR UPDATE;
  IF current_route IS NOT NULL THEN
    IF current_route->>'owner' IS DISTINCT FROM instance_owner
       OR current_route->>'agentId' IS DISTINCT FROM selected_agent_id THEN
      RAISE EXCEPTION 'This bot is already assigned to another agent';
    END IF;
    -- Same assignment is deliberately a no-op, preserving its binding generation.
  ELSE
    INSERT INTO asp_records(kind, id, value) VALUES (
      'group_bot', requested_bot_id,
      jsonb_build_object('owner', instance_owner, 'agentId', selected_agent_id,
        'bindingId', md5(random()::text || ':' || clock_timestamp()::text || ':' || txid_current()::text))
    );
  END IF;
END
$migration$;
COMMIT;
```

The generated `bindingId` is a non-secret routing generation, not an authentication credential. Repeating the same migration preserves it. Existing bot data and legacy subscriptions are untouched.

## Telegram webhook update is separate

SQL cannot call Telegram, verify that the encrypted token resolves to the requested bot, or change the webhook's `allowed_updates`. The server's `existing_bot_id` path performs that authoritative identity check before any binding write; prefer it to the SQL fallback. Database success alone does not enable `my_chat_member` delivery, create an inbox listener, or prove a message reached the agent.

Once the deployed MCP supports it, call `telegram_bot_bind({"existing_bot_id":"<bot_id>"})` through the normally authenticated, correctly registered agent. The server reuses the stored token, validates that the webhook is empty or belongs to this relay, and requests both `message` and `my_chat_member`. Do not extract/decrypt/export the bot token to run a manual Telegram request. Verify the resulting binding and an owner-authorized live test; leave OAuth setup and listener creation to their normal supported flows.
