# BotlineMCP

[GitHub repository](https://github.com/realTaki/BotlineMCP)

A self-hosted, single-owner relay between agents and Telegram private messages.
This documentation targets source version **0.6.20**. Configure `MCP_API_KEY`,
use `X-MCP-*` client headers, and identify forwarded messages by the `[MCP]`
routing line. Newly issued agent tokens use the `mcp_at_` prefix.

Deploy this release as a fresh installation with its own database and production
configuration. Follow the setup steps below, then register your agents and human
participants and configure the intended message routes.

The owner reports verified use with **ChatGPT dot, xAI Grokbot and Telegram**.
Other agents have not been verified; protocol extensibility is not a compatibility
promise. The current Grokbot adapter uses Cursor-hosted endpoints internally.

Each agent has a stable handle and can bind one Telegram bot. Registered humans
can DM any bound bot; agents reply by handle with `messages_send`. Agent-to-agent
messages use the same routing model. Telegram groups and supergroups are ignored.
BotlineMCP does not run a model, create platform tasks, or provide a chat-history service.
You still need access to the agent platforms you choose.

**Trust boundary:** one deployment, one owner, trusted clients only. The instance
API key grants instance-wide authority, including use of stored bot and Cursor
credentials. Agent handles and tool profiles are routing distinctions, not tenant
isolation or separate privilege levels. Do not expose this as a shared public service.

## How it works

- Telegram sends authenticated webhook updates to `/telegram/:botId`. The relay
  checks the registered human, private-chat sender and current bot binding.
- **dot:** exactly handle `dot`, without a Grok Bot destination. One
  `agent.notification` subscription with empty arguments receives `inbox.ready`.
  The agent calls `messages_inbox`, processes each item and explicitly calls
  `messages_ack` with the processed IDs. Callback success does not delete messages.
- **Grok Bot:** a registered `grokbot_agent_name` selects a Cursor session. BotlineMCP
  delivers through the vendor-specific `api.cursor.com/v0/grokbot` endpoints;
  Grok Bot destinations do not subscribe to the webhook inbox.
- **Other webhook agents:** one empty-arguments `agent.notification` subscription
  receives `message.created` and actionable `relay.error` notifications.
- `messages_send({to, text, request_id})` addresses a registered human or agent
  handle. Reuse the same request ID for the same intended send after a timeout.

Postgres stores registrations, encrypted working credentials, OAuth state,
subscriptions, receipts and bounded pending payloads. Source modules are organized
around HTTP/MCP (`src/app.js`), identity (`agents.js`, `oauth.js`), transport
(`dms.js`, `dot-inbox.js`, `grokbot*.js`), Telegram bindings/admission (`bots.js`,
`telegram-*.js`), human-change confirmation (`human-change.js`), and storage/security.
`api/index.js` is the Vercel entry point; `src/dev.js` is the local entry point.

## Requirements and setup

- Node.js 22 or later and npm
- A dedicated Postgres database and a random instance key
- A stable public HTTPS origin for external callbacks
- Your own Telegram bot for Telegram use, plus an appropriate agent client
- A Cursor account/API credential with access to the Grok Bot endpoints only if
  using that optional route; endpoint availability is not guaranteed

### Local development

Use a disposable development database and development-only credentials. Install
and check the source first:

```sh
npm ci
npm run check
npm test
```

Provide `MCP_API_KEY` and `DATABASE_URL` securely in the process environment, then
run `npm start`. The development server listens on `127.0.0.1:3000` and overrides
its origin to `http://localhost:3000`. It does not load `.env` files automatically.
A local HTTP server alone cannot receive public Telegram or agent callbacks.
Tests mock remote transport and use PGlite for actual SQL; they need no live keys.

### Vercel deployment

1. Import a reviewed source copy into your own Vercel account; use Node.js 22+
   and Framework Other with no build step.
2. Connect a dedicated Postgres integration and verify that its connection URL is
   available to the project. Provisioning a database is a separate infrastructure step.
3. Set `MCP_API_KEY` as a production secret. Generate a high-entropy key locally,
   for example with `openssl rand -hex 32`, and save it in your credential manager.
   Never paste it into an issue, message, screenshot or committed file.
4. Enable Vercel system environment variables. The code derives the HTTPS origin
   from `VERCEL_PROJECT_PRODUCTION_URL`, not the incoming Host header.
5. Deploy, then connect the stable production origin's `/mcp` endpoint. The
   application initializes its schema automatically on configured startup.
6. Register the agent, bind its bot with owner approval, register confirmed humans,
   and establish the appropriate receiving route. Verify a real private-DM round trip
   separately from deployment success.

Environment settings:

- `MCP_API_KEY`: required random secret, at least 32 characters; use substantially
  more entropy than a human password. Also derives the stored-secret encryption key.
- `DATABASE_URL`: Postgres connection URL; `POSTGRES_URL` is an accepted fallback.
- `VERCEL_PROJECT_PRODUCTION_URL`: production hostname supplied by Vercel, without
  `https://`. Required by production configuration. Local development supplies its own value.

Preview and production must not share credentials or databases. The current
configuration is Vercel-specific; other hosting needs an explicit origin/configuration
adaptation, not a claim that an arbitrary `PORT` or `PUBLIC_URL` variable works.

## Client compatibility and onboarding

The HTTP endpoint implements MCP Streamable HTTP. Official SDK clients (including
Grok Bot) use protocol `2025-06-18`: `POST /mcp` carries JSON-RPC, `GET /mcp`
opens an SSE listener, and a POST whose `Accept` lists `text/event-stream`
receives `text/event-stream` (otherwise JSON). `initialize` negotiates
`2025-06-18`; `notifications/initialized` returns `202`. Envelope clients that
send MCP `2026-07-28` keep using `params._meta` with matching
`MCP-Protocol-Version`, `Mcp-Method`, and (for tool calls) `Mcp-Name` headers;
those responses include `resultType` and server identity metadata. Use
`server/discover` or `initialize` for instructions and capabilities. Missing
`2026-07-28` metadata and unsupported envelope versions are rejected. OAuth and
instance-key/per-agent-token authentication remain available. Existing webhook
event operations are a service-specific extension, not a generic
streaming-subscription implementation. This does not certify every client or
optional protocol feature.

Protocol diagnostics record only a fixed method category, recognized protocol
version categories and HTTP status. They do not log credentials, identities,
URLs, tool arguments or response content.


### ChatGPT dot

The implemented OAuth flow uses authorization code with PKCE S256. Dynamic client
registration currently permits HTTPS redirects only on `chatgpt.com` and
`chat.openai.com` (standard HTTPS port). It is not a generic OAuth integration for
arbitrary MCP clients. Platform event support and product access must be checked
in the actual client; ordinary MCP tool support alone does not prove background wakes.

On the consent page, the owner enters the instance key, not an agent handle or bot
token. After connecting, call `agent_whoami`; if unregistered, register exactly
`dot` without `grokbot_agent_name`, then refresh authenticated `tools/list`.
Do not replace an existing different identity automatically. Maintain one empty
`agent.notification` subscription and implement inbox/ACK handling.

For a new bot, an owner can personally enter credentials at `/settings` on the
same verified origin after authenticating with the instance key. The agent handle
must already exist. For an already stored, same-instance bot, an approved bind
can instead use `existing_bot_id` without exporting its token.

### Direct clients and xAI Grokbot

Direct clients authenticate with `Authorization: Bearer <MCP_API_KEY>` and register
a stable handle. Store the returned `agent_token` securely; it is shown once and
selects identity on later calls, but does not replace the Bearer credential.
`X-MCP-Agent-ID` remains a direct-client fallback. An OAuth session's registered
identity is authoritative and cannot be overridden by a different agent token.

For Grok Bot, use `X-MCP-Bot-Type: grokbot` and register the intended
`grokbot_agent_name`. Configure the Cursor key only through an approved secure
credential path. Multiple Grok Bot registrations can use the stored account key.
The destination is the registered session name, not arbitrary text supplied by an
incoming sender. No `agent.notification` subscription is required for this route.

`X-MCP-Bot-Type: dot` or `grokbot` filters discovery; calls must match the registered
profile. The full catalog contains thirteen tools. Unidentified discovery can expose that
catalog, but protected calls
still require authentication. After registration inspect `agent_whoami` fields
`server_version`, `tool_profile` and `available_tool_names` rather than relying on
cached tool lists. Other webhook clients are protocol integration targets only and have not been
verified. No broad all-clients compatibility certification is claimed.

## Humans, binding and confirmation

Register each human once using a confirmed handle and Telegram user ID. Each ID is
unique across the human registry. Display names and message text are not identity
proof. One registration admits that human to every bound bot in the instance.

Changing an existing human's Telegram ID or display name in 0.6.15 requires a
five-minute challenge sent to exactly one existing agent of the other supported
type (dot ↔ Grok Bot). Zero or multiple eligible peers fail closed. The receiving
agent must show the code to the human in its own native channel and must not relay
it automatically to another agent. The requester repeats the identical change
with the challenge ID and human-provided code; replacing an ID also needs the exact
current-ID guard. Five wrong attempts exhaust the challenge.

**This is instruction-dependent human handoff, not hard two-factor authentication.**
Both clients share the instance's authority. The server cannot prove that a human
saw or manually transferred the code. Initial registration still relies on explicit
human identity confirmation. See [SECURITY.md](SECURITY.md).

Binding registers a Telegram webhook and stores encrypted working credentials.
Foreign webhooks are rejected rather than silently overwritten. Unbinding removes
stored bot credentials, its route and pending payloads; a remote webhook removal
can remain unconfirmed. Keep an independent secure backup of recovery credentials.
Legacy migration is explicit; do not silently claim an unassigned route.

## Delivery guarantees and limits

- dot retains at most 512 unacknowledged items for 24 hours. Full capacity fails
  closed. ACK is explicit and idempotent; expired items cannot be recovered.
- Other pending DM payloads expire after 24 hours and are discarded after success
  or terminal failure. Send receipts last seven days. Physical expiry cleanup may
  wait for a later transport operation; these are not guaranteed idle-time erasures.
- Retries are bounded and opportunistic, driven by subsequent relay activity.
  There is no independent scheduler or durable always-on worker. An idle deployment
  does not guarantee timely delivery or retry. List scans fail closed above 1,000
  records; this is intentionally small-instance software.
- A callback 2xx, Cursor transport acceptance, agent execution and a visible human
  reply are different outcomes. BotlineMCP cannot guarantee agent wake or context isolation.
- Ambiguous Telegram sends are not blindly repeated. Changing a request ID after
  a timeout can create duplicates. In-flight requests cannot be recalled after revocation.
- Stored messages and credentials are operational data, not a recoverable chat
  archive. Backups and database/operator access remain security responsibilities.
- The Grok Bot transport is a vendor-specific, potentially unsupported/non-public
  API dependency. Paths, access requirements and response formats can change
  without a compatibility promise. This project is not an official OpenAI, Cursor,
  xAI or Telegram integration and does not claim vendor endorsement.

## Development, security and release review

Run `npm run check` and `npm test` after changes. Keep source validation, deployment
and live acceptance separate. The [protocol documentation](docs/dms.md) describes message flows and schemas;
the [acceptance checklist](docs/acceptance.md) separates source, deployment and
live verification without publishing private operational history.

See [contributing](CONTRIBUTING.md), [security](SECURITY.md), and
[open-source release checklist](docs/open-source-release.md) for source provenance,
clean-export and naming gates. This documentation draft does not certify a security
audit, live platform compatibility, or readiness to publish.

Licensed under [MIT](LICENSE), copyright (c) 2026 realTaki. Dependency licenses
and vendor terms are separate.
