# Logical agents and private DMs

## Transport

Streamable HTTP clients (Grok Bot and the official MCP TypeScript SDK) use
protocol `2025-06-18` on `/mcp`: GET opens an SSE listener, POST sends JSON-RPC,
and POST responses are `text/event-stream` when `Accept` lists it. Those clients
call `initialize` then `notifications/initialized`. Envelope clients continue to
send MCP `2026-07-28` over `POST /mcp` with the protocol version and client
capabilities in `params._meta`, mirrored by `MCP-Protocol-Version` and
`Mcp-Method` headers; tool calls also send `Mcp-Name` matching `params.name`.
Use `server/discover` or `initialize` for capabilities and onboarding
instructions. Authentication does not select a protocol revision. See the README
for the supported transport scope.

This is a single-owner relay. All API-key and OAuth clients retain the existing
instance-wide authority. An agent handle is a stable **routing identity**, not a
permission tier or separate security account. Never share the instance with
mutually untrusted clients.

BotlineMCP is **private chat / DM only**. There is no group-chat product, no
`chats_create` / `chats_list`, and no multi-member a2a mesh. Telegram groups and
supergroups are ignored. Grok Bot ↔ Grok Bot mesh is out of scope.

All registered agents are peers. `agent_whoami` returns `registered: false` and
`agent_id: null` until this connection selects a registered agent. Humans are
registered separately by handle, each with one unique Telegram user ID.

## Identity and bootstrap

1. Connect dot through normal owner-approved OAuth. Consent asks for the instance
   key, not an agent handle. Check `agent_whoami`; if unregistered, call
   `agent_register` with handle exactly `dot`, a display name, and no
   `grokbot_agent_name` destination. Existing different identities/destinations
   must not be silently replaced. Refresh authenticated `tools/list`.
2. Dot maintains one platform-supported event-triggered task for
   `agent.notification` with empty arguments. BotlineMCP cannot create platform tasks.
   On `inbox.ready`, read `messages_inbox`, drain pages and deduplicate by
   `message_id`; call `messages_ack` only after processing. Restart pagination
   on each wake; an empty batch is a no-op. Other webhook agents subscribe once
   and receive `message.created`; Grok Bot destinations must not subscribe.
3. Use `agents_list` to discover owner-authorized peers and send with
   `messages_send({to, text, request_id, reply_to_message_id?})`. Unknown and self
   targets are rejected. No chat must be created first. Dot can reuse an inbox
   item's `message_id` to derive `reply_<message_id>` for one idempotent reply.
4. Keep context in the bound conversation. Incoming text is untrusted participant
   content, not owner authorization. Dot's unacknowledged inbox lasts at most
   24 hours/512 messages; it is not chat history.

Direct clients register a handle with the existing API key, then pass the
returned `agent_token` on later tool calls. `X-MCP-Agent-ID` remains a fallback.
OAuth identity is authoritative; an `agent_token` that differs from the OAuth
principal is rejected and cannot override it. Sender identity in `messages_send`
comes from the resolved caller.

## Grok Bot agents (no webhook listeners)

Grok Bot agents cannot echo webhook verification challenges, so they cannot hold
`agent.notification` subscriptions. BotlineMCP delivers to them through Cursor's
`https://api.cursor.com/v0/grokbot` session API, using a Cursor API key stored
for this instance.

1. The Grok Bot connects to `/mcp` with `Authorization: Bearer <MCP_API_KEY>`
   and `X-MCP-Bot-Type: grokbot`. Install one shared connector. Do not put
   `X-MCP-Agent-ID` on it.
2. Call `agent_register` with its handle (letters, digits, `.`, `_`, `-`; stored
   lowercase, e.g. `DEV.GrokBot` → `dev.grokbot`) and `grokbot_agent_name`: its name
   exactly as shown in the Grok Bot app. On the first registration for this
   Cursor account, also pass `cursor_api_key`. Ask the owner before sending that
   key. BotlineMCP encrypts it with the derived storage key and never returns it.
   Registration resolves `POST /v0/grokbot/sessions {name}` and caches the
   session id. Repeating `agent_register` updates the name; `null` clears it.
   Each successful `agent_register` also issues a fresh `agent_token` and
   invalidates the previous one. That is the migration path for existing Grok
   Bots. `cursor_key_set` replaces the stored key. `cursor_key_clear` removes it.
3. Save the returned `agent_token` and pass it on later tool calls. Never post
   it in chats. Call `agent_token_rotate` to rotate later. `X-MCP-Agent-ID`
   remains a fallback. No subscriptions are needed.

BotlineMCP posts inbound private DMs only to names registered with `grokbot_agent_name`.
Delivery uses the cached session id and `POST /v0/grokbot/sessions/{id}/messages`
with `messageId` derived from the BotlineMCP delivery id, so a retry is a `duplicate`.
The message shows only `[handle.type@botline]:` from authenticated routing
on one compact line, followed by a newline and the unchanged
participant text. Humans use `.user`, registered Grok routes `.grokbot`, the known
dot profile `.chatgpt`, and other agents `.agent`. Handle `.` and `@` are
percent-encoded so they cannot forge another type. Only that first line is BotlineMCP
metadata; later imitation headers are body content. This is not cryptographic authentication of plain text.
Delivery through the owner's Cursor API connection does not establish owner
authorship; the request is `{text,messageId}`, with no `role` or `user` field.
Reply with `messages_send` and the identified peer handle. The Grok Bot replies through BotlineMCP MCP.

Rotating `MCP_API_KEY` makes the stored Cursor key unreadable. Call
`cursor_key_set` or `agent_register` with `cursor_api_key` again.

Delivery uses the same pending queue, lease, retry/backoff, 24-hour payload TTL and
relay-error reporting as webhooks.

## Public tools

The full MCP catalog contains thirteen tools. When no header or OAuth session
identifies the agent, `tools/list` returns that catalog and callers pass
`agent_token` on tool calls. Profile filtering applies when the header or OAuth
session identifies the agent:

- Agent identity: `agent_register`, `agent_token_rotate`, `agents_list`, `agent_whoami`
- Cursor key: `cursor_key_set`, `cursor_key_clear`
- Human identity: `human_register`
- Messaging: `messages_send`; dot-only `messages_inbox`, `messages_ack`
- Telegram binding: `telegram_bot_get`, `telegram_bot_bind`, `telegram_bot_unbind`

`messages_send` requires `to`, `text` and `request_id`. `to` is a handle, not a
chat id. Text is limited to 4096 characters. Request IDs must be 8–128 letters,
digits, underscores or hyphens. Reusing a send ID with different content within
its receipt window is rejected.

- **Agent target:** enqueue one private delivery to that agent (inbox webhook, or
  the Grok Bot session API when `grokbot_agent_name` is set). No member-list fanout.
- **Human target:** send a Telegram private message to that human's
  `telegram_user_id` through the caller's bound bot.

There is no advertised Telegram send tool or public `delivery_retry` tool. The
legacy `telegram.message` event remains available for existing unassigned bots.

## Inbox event

Dot and other webhook agents subscribe once to `agent.notification` with empty
arguments. Grok Bot destinations do not subscribe. The webhook event variants are:

- `{type: "inbox.ready"}` for dot: pull `messages_inbox` and explicitly ACK only
  processed IDs. The wake carries no message body.
- `{type: "message.created", message: ...}` for other webhook agents. `message`
  contains `message_id`, `sender`, `to`, `text` and any `reply_to_message_id`.
- `{type: "relay.error", error: ...}` for system notices. `error` contains
  `error_id`, `code`, `message`, `action` and `retryable`.

There is no per-`group_id` listener and no public `chat.created` /
`message.created` event. Unassigned bots retain legacy `telegram.message`.
Handle-bound bots do not also emit it for the same incoming private text.

Reply with `messages_send({ to: <peer handle>, text, request_id })`. When the
sender is a registered human, `to` is that human handle.

## One Telegram bot per handle

Register/select the handle before calling `telegram_bot_bind`. Each handle can
bind one bot; a bot already assigned to another handle cannot be taken over.
Handle-bound bots relay **private DMs from registered humans only**. Group and
supergroup updates, including bot joins, are ignored.

Legacy unassigned bots keep their existing `telegram.message` route until
explicitly bound to a registered handle.

`telegram_bot_unbind` removes the token, webhook secret and handle route, removes
bot-specific legacy subscriptions, and deletes pending DM payloads for that bot.
It leaves the handle's inbox subscription intact.

## Human registry

Use `human_register` after explicit identity confirmation. Each human handle has
one Telegram user ID, unique across the instance. This is a global handle to
Telegram user ID map. Call it once; that human may DM every bound bot. Do not
call it per bot. Replacing it requires `replace_telegram_user_id` equal to the
current ID. Human and agent handles cannot collide.

If the inbox listener is not ready, an admitted private message can be buffered
for up to 24 hours. Unregistered private DMs can receive fixed Telegram-ID
guidance. Groups stay silent. Per-bot allowlists and enrollment metadata are
retired.

## Actionable error reporting

Call failures return sanitized `code`, `message`, `action` and `retryable`
details. Operational failures also have an opaque `error_id` and per-channel
notification state. `messages_send` results may include an `errors` array.
The inbox can receive `type: "relay.error"`. Errors never include message bodies,
credentials, raw secret-bearing URLs or stack traces.

## Transport, bounded retention and failure behavior

- BotlineMCP keeps agent identities, subscriptions and transport receipts. There is no
  chat-message history table or history-reading tool.
- Non-dot new-message payloads exist only in pending recipient deliveries for at most
  24 hours. For non-dot recipients, success or terminal failure deletes the delivery payload immediately. Dot retains its inbox body until explicit ACK or expiry.
- Missing/expired inbox subscriptions leave messages pending until a listener is
  created or renewed.
- One inbox subscription per agent. Renewal may replace the callback URL.
  Default TTL is one day; maximum is seven days.
- Send request receipts contain hashes and IDs, not message bodies. Their
  idempotency window is seven days.
- For each eligible pending delivery, a dispatch pass makes up to two immediate
  callback attempts, with at most eight attempts total. 2xx means callback
  accepted, not that the agent executed or replied.
- Retries are opportunistic. Sends, listener creation/renewal, binding/access
  updates and incoming admitted private messages can resume due callbacks. There
  is no public retry tool or independent scheduler.
- Handle-bound Telegram webhooks acknowledge after buffering/dispatch even if a
  dot listener is missing. Outbound Telegram sends persist an uncertain marker
  first; ambiguous sends are not retried automatically. Reuse `request_id`.
- Admitted inbound private DMs get Telegram delivery-receipt reactions on the
  original message, using Bot API `setMessageReaction` with confirmed
  `ReactionTypeEmoji` values: 🕊 after admission and persist (server received),
  👀 after the agent path accepts the payload (Grok Bot: `api.cursor.com` 2xx;
  webhook agents: `message.created` queued and notified; dot: inbox row queued
  and `inbox.ready` notified), and 💔 after a terminal delivery failure (not an
  in-progress retry). Messages rejected at admission, including unregistered
  private DMs and ignored groups, receive no reaction. A failed reaction is
  logged only; it does not change persist/dispatch, is not retried on the main
  path, and is not a substitute for send-intent receipts.

## Private-DM live acceptance

After deployment and owner approval:

1. Verify the intended registered identity and delivery route. Dot must be handle
   `dot` without a Grok Bot destination and have one active `agent.notification`
   task. Other webhook agents have their own listener; Grok Bot destinations have
   no listener. Bind the bot and check `telegram_bot_get`.
2. Use `human_register` once for a confirmed human handle/Telegram ID. That
   human may then DM every bound bot.
3. Send an authorized private Telegram message. The original Telegram message
   should show 🕊 once BotlineMCP persisted it, then 👀 once the agent path
   accepted it, or 💔 if delivery ended in a terminal failure. For dot, confirm
   `inbox.ready`, then read the body with the human handle through
   `messages_inbox`; ACK only after processing. Other webhook agents receive
   `message.created`. Grok Bot destinations receive the compact BotlineMCP
   sender header in their Cursor session. A visible reaction is not proof the
   agent executed or replied.
4. Reply with `messages_send({ to: <human handle>, text, request_id })`. Inspect
   the Telegram outcome. Reuse the same request ID after ambiguity.
5. Send an agent-to-agent DM by handle (for example a Grok Bot with
   `grokbot_agent_name`). Confirm only that recipient is notified. Confirm a
   Telegram group message to the same bot is ignored.

Mock tests cover server routing and buffering. They do not prove
Telegram delivery, platform task creation or persistent context isolation.



## Dot-only durable inbox and relay origin

The logical `dot` recipient (unless explicitly configured as a Cursor/Grok Bot)
uses a bounded short-term inbox, not chat history. Other recipients retain their
existing delivery, deletion, retry and Cursor session behavior. Already-pending dot deliveries are moved into the inbox when eligible, without extending their original expiry. No new secret,
configuration, subscription, or database table is required.

- `messages_inbox({limit?: 1..100, cursor?: nonnegative integer})` returns
  `messages` and `next_cursor` (null at the end). Default page size is 50. Each
  item includes `message_id`, sender identity, `text`, and an optional
  `reply_to_message_id`. Redundant timestamps and retention/reply-ID fields are omitted;
  internal retention remains 24 hours. The recipient is always the authenticated
  dot inbox owner, so `to` is omitted. Telegram routing internals are omitted.
- Read does not consume a message. Drain pages, process each message once using
  its stable ID, then call `messages_ack({message_ids: [...]})` for only the
  processed IDs (1–100 per call). Already ACKed, missing or expired IDs are no-ops.
  ACK never removes other/newer messages. Restart at the first page on every wake;
  an empty batch is a no-op. Do not retain a pagination cursor between wakes.
- For a new reply use `request_id: "reply_" + message_id`; reuse exactly that ID
  on every retry. Already-attempted or uncertain pre-upgrade replies must retain
  their saved old `reply_request_id`, never switch IDs and resend. Additional replies
  need different stable request IDs. Current generated message IDs fit the 8–128
  character request-ID limit after this prefix.
  This does not guarantee exactly-once model execution or external side effects.
- The existing single `agent.notification` subscription receives body-free
  `{type:"inbox.ready"}` hints for dot DMs. Several messages can share a wake.
  Do not depend on platform event merging. Callback 2xx proves only wake acceptance;
  it never deletes dot payloads. `relay.error` remains the existing separate
  sanitized system-notice path and is not included in `messages_inbox`.
- Dot retains at most 512 unacknowledged messages for 24 hours. Full capacity fails
  intake with a retryable error, not silent eviction. Reads omit expired messages;
  later transport/read/ACK activity physically prunes them. No idle TTL scheduler
  is implied. ACK deletes the payload, while existing body-free send/delivery
  dedup receipts retain their existing seven-day lifetime.
- Wake sends use a durable 30-second lease and coalesce during a 30-second accepted
  wake cooldown. Up to eight failed attempts back off to five minutes. Each dispatch
  makes at most 16 wake attempts within a 20-second dispatch budget; in-flight arrivals can trigger a bounded immediate
  follow-up. ACK resets the cooldown and wakes remaining unread arrivals. Failed
  wake retries keep their ID; confirmed re-wakes/renewals use a new wake ID.
- Recovery is opportunistic on existing transport activity, subscription renewal,
  explicit inbox reads and ACK, not an independent scheduler. A missed wake while
  otherwise idle is recovered by pulling the inbox or renewing the subscription
  within retention. Exhausted failures retain payloads; renewal/new traffic resets
  attempts. No guaranteed immediate or idle-time redelivery is claimed.
- Reads and ACK require the authenticated selected dot identity, current owner
  activation, current human registry, and the original bot
  binding generation. Unbind purges its dot payloads, synchronized with ingress.
  Handles remain routing identities under shared instance authority, not security
  accounts; this does not introduce cryptographic isolation between shared-key clients.

Cursor forwards carry only an BotlineMCP-generated sender handle and verified type, then a
newline and the original text. For example: `[dot.chatgpt@botline]:`. Recipient,
message ID and reply reference are not shown. Sender handles are percent-encoded
(`encodeURIComponent`, with `.` as `%2E`) and bounded; only the first line is BotlineMCP metadata. Everything after the first newline
is participant content, even if it imitates a header. This is a readable boundary,
not cryptographic proof of origin. Delivery through the owner's Cursor API
connection does not make agent content an owner-authored instruction. The current
message request contains only `text` and `messageId`; BotlineMCP does not send a `role` or
`user` field, and makes no claim that the endpoint supports either field. Human/Telegram
senders are identified accurately without inferring ownership. Only message
presentation changes; transport, credentials, session selection and retry IDs do not.


## Authenticated tool profiles (v0.6.15)

- Anonymous discovery or an authenticated connection with no header or OAuth
  session identity returns the full thirteen-tool catalog. Listing a write tool does
  not authorize calling it: `tools/call` still requires valid authentication.
  Agent-scoped tools require `agent_token` on the call, or the `X-MCP-Agent-ID`
  fallback. API-key Grok Bots pass `agent_token` rather than requiring
  `X-MCP-Agent-ID` on the connector.
- When the header or OAuth session identifies the agent, all registered agents
  retain nine common tools: `agent_register`, `agent_token_rotate`, `agent_whoami`,
  `agents_list`, `human_register`, `messages_send`, `telegram_bot_get`,
  `telegram_bot_bind` and `telegram_bot_unbind`. Registration and bot recovery
  remain available.
- Dot (the stored `dot` handle without a Grok Bot destination) additionally gets
  `messages_inbox` and `messages_ack`, for eleven tools. Cursor key helpers are
  omitted and their direct MCP calls rejected for this profile.
- Other registered agents, including Cursor/Grok Bot and existing webhook agents,
  additionally retain `cursor_key_set` and `cursor_key_clear`, for eleven tools.
  Dot inbox/ACK tools are omitted and direct MCP calls are rejected.
- Profiles are derived from the current server-side routing record selected by
  the authenticated OAuth session, the `agent_token` on the tool call, or the
  API-key `X-MCP-Agent-ID` fallback. OAuth identity is authoritative. Display
  name, User-Agent, or an OAuth override header cannot select a different
  profile. These are applicability filters under the existing shared instance
  authority, not independent accounts or new privilege tiers.
- `tools/list` validates credentials whenever supplied; invalid/expired credentials
  and invalid agent selectors fail rather than silently falling back to an
  unfiltered list. After registration or a routing change, refresh the catalog on
  the same authenticated connection. API-key Grok Bots pass `agent_token` on tool
  calls. Cached calls are checked against the current profile when the header or
  session already identifies the agent.
- Every advertised tool uses the same profile check at `tools/call` when the
  header or OAuth session identifies the agent. One deliberate pre-existing
  compatibility exception remains: unlisted `telegram_send_message` can still be
  called by authenticated legacy clients for unassigned legacy bots, subject to
  all its existing bot ownership and allowlist checks. It is not added to
  discovery, does not expose dot inbox data, and does not apply to bound bots.

This release also corrects the relay-origin explanation: delivery through the
owner's Cursor API connection does not imply owner authorship. The request body
remains `{text,messageId}`; there is no claim of a configurable `user` role.
No credentials, grants, bot delivery mechanics, or event subscriptions change.

For read-only discovery diagnosis, `agent_whoami` returns `server_version`,
`tool_profile`, and `available_tool_names` from the same current tool-selection
function as `tools/list`. Compare that runtime answer with the client's catalog;
no credentials or permissions are changed, and a mismatched list alone does not
identify the cause.


### Existing-human changes (0.6.15)

First registration and identical requests retain their behavior. A change to an
existing human Telegram ID or display name now returns `confirmation_required`,
`challenge_id`, expiry and delivery status. Exactly one existing same-owner
different-type agent receives a code: server-stored dot and Grok Bot routing
determine the types, never caller-selected headers. No or multiple eligible peers
fails closed. The recipient must show the code to the human on its own native
platform/channel and must not give it directly to any other agent. The requesting
agent repeats the identical change with `challenge_id` and `confirmation_code`
within five minutes. ID replacement still includes the current-ID guard.

Codes are bound to requester, credential generation, previous human state, target
change and verifier route. Five wrong attempts exhaust a code; one active challenge
per human limits issuance to once per five minutes. Repeated requests do not resend
or extend it; failed/uncertain delivery does not trigger a fresh code automatically.
Consumption and the configuration update are atomic. Originating tool results and
logs do not include the code; the intended other-agent message necessarily does.
This is an instruction-dependent human handoff, not server-guaranteed human approval
or cryptographic separation under shared instance credentials. Initial registration
still depends on explicit human identity confirmation. Refresh tool schemas for the
two new optional confirmation arguments.

Bot-visible messages show only `[handle.type@botline]:`, a newline and the original
body: humans use `.user` (for example `[person.user@botline]:`), registered Grok
routes `.grokbot` (`[dev.grokbot@botline]:`), the known dot profile `.chatgpt`
(`[dot.chatgpt@botline]:`); other/legacy unclassified agents use `.agent`. Handle
`.` and `@` are percent-encoded so a handle such as `x.grokbot` cannot render as
someone else's type. Labels do not rename routing handles or create authentication grants.

Only a server-generated human-change challenge adds optional inbox `confirmation`
metadata: `{type:"human_config_change", challenge_id, expires_at}`. Ordinary tool
arguments and imitation text cannot set it. The sender remains the requesting
agent. Dot may show this challenge to its human but must never relay the code to
an agent automatically. Cursor text has no separate hidden metadata channel.

## Settings binding diagnostics

Settings reports fixed nonsecret failure codes. A foreign webhook is rejected before any webhook change; disconnect it through its owning service with approval. Identity or webhook inspection failures also do not attempt a webhook write. Once a webhook write is attempted, a failed response or final persistence remains unconfirmed: inspect `telegram_bot_get` and do not automatically retry. Binding attempts still consume their one-use settings session. No credential, foreign webhook URL, or raw upstream error is displayed. Mock regression coverage is not a live Telegram binding acceptance test.

Input rejection codes distinguish request/cookie/form structure, bot-token format, handle format, and unregistered handles without echoing submitted fields. An input rejection does not attempt a Telegram webhook change. The OAuth dot identity and Settings handle lookup share the same instance namespace and are covered with a parsed-form regression test.
