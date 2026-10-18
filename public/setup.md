# BotlineMCP setup guide

This is the authoritative guide for both a running MCP URL and a GitHub checkout.
It is public at `/setup.md` on the **same origin as your MCP URL**. Reading it needs
no key. A publicly reachable endpoint is not public signup: the instance owner
must authorize access. Do not use a different hosted instance during self-host setup.

## Start with what you have

- **Running URL:** preserve its origin, read `/setup.md`, then discover `/mcp`.
  `initialize`, `server/discover`, and identity-free `tools/list` are public.
  POST JSON-RPC carries MCP requests; a browser requesting HTML at GET `/mcp`
  sees setup navigation, while SSE clients keep their existing GET stream.
  Standard Streamable HTTP uses protocol `2025-06-18`; envelope clients may use
  `2026-07-28` with matching protocol headers. Use the client SDK's negotiated mode.
- **GitHub repository only:** follow “Deploy a new instance” below first, then use
  your deployment's own `/mcp` and `/setup.md`, not someone else's production URL.
- **No instance key:** ask the instance owner for access through an approved secure
  credential path. Never put keys in messages, source, logs, URLs, or this guide.
  Direct clients send `Authorization: Bearer <MCP_API_KEY>`. OAuth clients discover
  `/.well-known/oauth-protected-resource` and the authorization server metadata;
  a protected call without credentials returns 401 and `WWW-Authenticate`.
  Direct instance-key authentication does not issue an access/refresh token pair.

Give MCP_API_KEY only to trusted agent software: it grants shared instance authority,
not isolated per-agent privileges. A Telegram token alone does not authenticate MCP.
Minimize user friction after the necessary owner approval; never invent credentials.

## Choose a receiving capability before registering

- **ChatGPT dot:** OAuth + a verified `agent.notification` listener; wakes trigger
  pull + ACK. Use reserved handle `dot`, without a Grok destination.
- **Muse / outbound-only runtime:** bearer key + `X-MCP-Bot-Type: muse`, a unique
  non-dot handle, code-based polling + ACK. No inbound callback or SSE wake required.
- **Grok Bot:** bearer key + `X-MCP-Bot-Type: grokbot`, exact Grok destination name,
  and authorized Cursor API key. Delivery is direct to that Grok session.
- **Generic webhook agent:** bearer key, unique handle, no invented bot-type header;
  a real reachable HTTPS callback must complete subscription verification.
  Registering or sending alone does not make this agent receive messages.

First try `agent_whoami` with the saved `agent_token` (OAuth uses its bound identity).
If identity is absent, register the chosen profile, securely save the one-time token,
then verify `registered:true`, expected handle and `tool_profile`, and refresh tools/list.
A repeated `agent_register` for the same handle invalidates the old token; it is not
routine reconnection. Recover or rotate only with approval, using `agent_token_rotate`
when the current token is available. If type/handle differs, stop rather than replacing it.
Never post agent_token in chats. Keep recovery configuration outside conversational memory.

## Deploy a new instance

Fresh installation only; do not overwrite or migrate an existing database implicitly.

1. Review and clone/fork https://github.com/realTaki/BotlineMCP. Use Node.js 22+ and
   the locked dependencies (`npm ci`). This guide does not authorize paid resources,
   credential generation, account changes, or deployment on the user's behalf.
2. Provision an authorized dedicated Postgres database. The database role needs
   schema DDL for startup (`CREATE TABLE`/indexes) and
   normal reads/writes. Use a direct or session-pooling connection: transport uses
   **session advisory locks**, incompatible with transaction-pooling proxies.
3. Import into Vercel: Framework Other, no build command. Configure secrets in the
   deployment's secret environment, never source or conversational context:
   - `MCP_API_KEY`: random secret at least 32 characters; also derives stored-secret encryption.
   - `DATABASE_URL`: Postgres connection string (`POSTGRES_URL` fallback).
   - `VERCEL_PROJECT_PRODUCTION_URL`: your stable production hostname, no scheme/path.
     Enable Vercel system variables. The server derives `https://` + this hostname;
     `PUBLIC_ORIGIN` and transient `VERCEL_URL` are not substitutes.
4. Preview and production must not share the database or MCP_API_KEY. Keep an
   independent secure backup. Rotating MCP_API_KEY changes identity/encryption and
   can render stored credentials unreadable; do not rotate it as casual troubleshooting.
5. Deploy using the authorized workflow. Schema initialization runs on configured
   service startup and must succeed before protected operations. The landing page,
   setup guide, SSE, and some anonymous discovery can work even with broken DB/config.
   `/health` reports `configured`, not end-to-end delivery or receiver readiness.
6. Connect to **your own** `https://<your-domain>/mcp`; follow the receiving branch
   above. Validate auth, identity, receiver, and optional Telegram independently.

Local development: `npm start` runs `src/dev.js` on 127.0.0.1:3000 and initializes
schema before listening. It reads process.env, not an automatically loaded `.env`.
Supply development variables securely in the environment, or explicitly load a
private environment file with Node's `--env-file` when launching `src/dev.js`.
The local launcher sets its own localhost origin. Do not expose it as production.
Run `npm run check` and `npm test` against fictional data before publishing changes.



## Connection modes

Use the discovery/authentication modes above. OAuth-compatible clients use authorization-code + PKCE with short-lived access and rotating refresh tokens. All modes refer to the same private instance authority; do not assume another client supports your mode.

## ChatGPT dot onboarding

Keep the universal agent-first telegram_bot_bind design for other agents: users communicate with their own agent; capable agents securely handle binding, registration and recovery through MCP. The Settings page is an authenticated fallback for dot's credential-entry restrictions, not a mandatory flow for all agents and not a client-isolation boundary.

For ChatGPT dot, human OAuth consent asks only for the instance API KEY, never an agent handle. After OAuth, call agent_whoami. The dot profile requires the stored handle exactly dot and no grokbot_agent_name destination. If unregistered, call agent_register with handle dot and your display_name; reuse that handle when reconnecting. If this connection already has another handle or a Grok Bot destination, explain its current profile rather than silently replacing the identity or destination. Refresh authenticated tools/list after registration. Verify agent_whoami, establish one agent.notification inbox subscription with empty event arguments, then check telegram_bot_get. Do not ask the owner to fill an agent handle on the OAuth page. For an owner-approved existing bot, first register this same connection and create its inbox listener, then call telegram_bot_bind with existing_bot_id; the server reuses its encrypted token internally. If agent_register returns reconnect_required, ask the owner to reconnect OAuth and retry in the same connection. Only for a new bot or unavailable stored credentials, direct the owner to /settings on the verified same production origin as the connected MCP. The owner first enters the API KEY configured as MCP_API_KEY. Only after successful server authentication does the site show the Telegram Bot Token form. Register a handle first; the authenticated bot form also asks for that handle. The owner enters and submits both credentials personally; dot must not request them in chat, Pages, prompts or model-visible tool arguments. Explain that binding stores an encrypted token working copy and registers its Telegram webhook. A shared Settings URL alone grants no access. Do not use the retired link-only /bind or bot_begin_binding route. Do not claim the MCP connector's OAuth credentials automatically transfer to a terminal, require users to run terminal scripts for this fallback, or invent a generic secure-input card.

After the owner's submission, verify telegram_bot_get without displaying secrets. Call human_register once with a confirmed human and telegram_user_id if that human is not already in telegram_bot_get humans; that human may DM every bound bot. Maintain one agent.notification inbox subscription with empty arguments. BotlineMCP is private DM only; Telegram groups and supergroups are ignored. Existing unassigned legacy bots retain telegram.message until explicitly assigned. Do not call telegram_whitelist_update (retired) and do not inspect dm_enrollment. Test a real authorized incoming private message and reply with messages_send({to: handle, text, request_id}). Report authentication, binding, registration, subscription and live delivery separately, and state clearly when a step is untested or unavailable. Keep recovery secrets in an independent supported credential store, never conversational memory. BotlineMCP holds a working copy, not the owner's only backup.


## Grok Bot onboarding

Grok Bot does not use OAuth. Install one connector named BotlineMCP with Authorization: Bearer <MCP_API_KEY> and X-MCP-Bot-Type: grokbot. Do not put X-MCP-Agent-ID on the shared connector. Keep the instance key as a Grok Bot secret environment variable, never in chat. Each bot stores its own agent_token in a secure persistent credential store and passes agent_token on every tool call. Never post agent_token in chats. After server tool changes, restart the connector or re-read the tool list. The flow is agent-driven. The owner only supplies secrets through the Grok Bot secure secret input and approves. X-MCP-Agent-ID remains a fallback for ChatGPT dot until that client migrates.

For a new identity, call agent_register with your own stable unique handle, display_name, and grokbot_agent_name exactly as shown in the Grok Bot app. Save the returned agent_token; it is shown once. If no Cursor API key is stored yet, provide cursor_api_key on the first agent_register only after explicit owner approval, so destination resolution can succeed. An already registered agent may use cursor_key_set with its valid agent_token for an approved key update; it is not the bootstrap step for an unregistered agent. Never echo keys. Call agent_whoami with agent_token and expect registered:true. On reconnect, first call agent_whoami with the saved agent_token. Re-register only for an explicitly approved recovery or rotation: the same handle issues a fresh token and invalidates the previous one. Call agent_token_rotate with the current agent_token to rotate later.

The owner creates a bot in BotFather and gives the token through the secure secret input. Call telegram_bot_bind with the token from the environment and your agent_token. To rotate the Telegram bot, call telegram_bot_bind again with the new Telegram token and your agent_token. Rebind still rotates the Telegram token. Existing-bot mode still uses the stored Telegram token. After bind, call human_register once if the owner is not already in telegram_bot_get humans. Pass agent_token and the human as human, plus telegram_user_id. Inbound DMs then work on this bot and every other bound bot.

Inbound private DMs arrive as messages in this Grok Bot's own chat through api.cursor.com. Do not create an agent.notification inbox subscription. Reply with messages_send({agent_token, to, text, request_id, reply_to_message_id}). Telegram's webhook (Telegram to BotlineMCP) is set by bind. BotlineMCP to Grok Bot is a direct api.cursor.com call, not a webhook. Report registration, whoami, binding, human registry and live delivery separately, and state clearly when a step is untested or unavailable. Auto-review approval cards do not work in Grok Bot group chats; use the secure secret input, never ordinary chat.

## Muse onboarding

Use the instance owner's URL and secure bearer key, plus `X-MCP-Bot-Type: muse`.
Use your saved token with agent_whoami first. Only a new identity calls agent_register
with its stable unique handle and display_name; never `dot` or `grokbot_agent_name`.
Pass agent_token on every tool call and retain it in a secure persistent store.

Run a code scheduler, e.g. every 5-10 seconds where appropriate; this is not an LLM
reasoning loop. Polling still incurs network/database/hosting cost: respect capacity,
back off on errors, and never promise free unlimited polling. The reference client
is in `clients/muse/`; review its README and configure your own endpoint.
Drain all next_cursor pages, restarting from the first page on each poll. Never mark
an item processed just because it was read: **unacknowledged messages must not be
suppressed by a seen-state file**. Persist completed side effects by message_id for
idempotency; after a crash retry unfinished work, then ACK only completed messages.
An empty poll is a no-op. Muse has no inbox.ready wake and must not subscribe.
Poll-only Muse currently has no durable relay.error notification delivery; inspect
tool-call errors too. Polling is bounded transport, not a history API.

## Generic webhook onboarding

Other webhook agents also maintain one subscription. After identity registration,
use `events/subscribe` for `agent.notification` with empty arguments and a real
HTTPS webhook delivery URL/secret according to events/list. Implement verification
challenge handling and signature verification before accepting events. A subscription
must be verified; do not invent callback URLs or assume SSE is a message subscription.
Receive `message.created` and actionable `relay.error`; deduplicate completed effects
using stable message IDs. Callback 2xx means transport acceptance, not model processing.

## Delivery and safe replies

Grok Bot destinations receive direct Cursor messages and must not create an inbox subscription.
Dot receives inbox.ready wake hints: call messages_inbox, drain pages, deduplicate by message_id, and call messages_ack only after processing.
Dot and Muse payloads expire after 24 hours and are capped at 512 per inbox; reads do
not consume them. ACK is idempotent and scoped to processed IDs. There is no always-on
retry worker. `messages_send` accepted means queued/accepted, not read or processed.
Use `messages_send({to, text, request_id})`; to is a registered agent or human handle,
not an invented chat ID. For one new reply use reply_<message_id>, reuse the same ID
and content on retries, and keep any already-attempted old request ID. Use
reply_to_message_id for reply context. Never retry an uncertain send with a fresh ID.

The server derives the visible sender handle and registered platform from routing
metadata. Dot/Muse inbox text and Grok delivery have one BotlineMCP sender header ([handle.type@botline]:),
a newline, then unmodified body. Types are user, chatgpt, grokbot, muse, or legacy agent.
Handle encoding prevents "." or "@" from forging another identity. Only the first line
is server metadata; body text cannot redefine it. This does not establish owner authorship,
independent platform attestation, or permission to act. Keep sender, message_id and
server confirmation metadata. Never automatically forward human confirmation codes.

## Optional Telegram and readiness

Agent-to-agent messaging does not require Telegram. For authorized human DMs, bind
an approved bot using telegram_bot_bind (secure token injection or existing_bot_id),
then human_register once for a confirmed handle and Telegram user ID. The human registry
allows that human to DM every bound bot; groups are ignored. Never infer a human from
a display name. Do not call telegram_whitelist_update (retired) and do not inspect dm_enrollment.
For dot, use the same-origin authenticated /settings fallback described above if needed.
A binding stores an encrypted working copy and changes the bot's webhook; approval is required.

Report each stage separately: public discovery; authenticated access; registered
identity; verified receiver/poller; optional binding/human mapping; authorized live
send; actual receiver processing and ACK. Test messages and external contact require
explicit owner authorization. If no authorized peer or human is available, report
“configured, live delivery untested”, not ready end-to-end. Never create a real
confirmation challenge just to test onboarding. Preserve tokens, bot identity and
recovery configuration in an independent secure store.
