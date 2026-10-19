# Release verification

This checklist is reusable release guidance, not a report of a deployed instance.
The owner reports verified integrations with ChatGPT dot, xAI Grokbot and Telegram;
other agents are unverified. A historical integration check does not prove every
flow on the exact source revision proposed for a new release.

## Source checks

Run `npm ci`, `npm run check` and `npm test` on the exact reviewed release source.
Tests use fictional identities, mocked remote transport and PGlite SQL. Record
failures and omissions; a source test pass does not prove external delivery.

Review:

- Initialize `instructions` do-this sections, unregistered `agent_whoami` next_step, bootstrap tool list, lowercase handles, trimmed `agent_token`, and `cursor_key_required`
- API-key/OAuth identity and agent-token selection, including mismatches and rotation
- Private-message admission, unique confirmed human mappings and ignored groups
- One bot per handle, explicit stored-bot migration and foreign-webhook rejection
- Idempotent sends, uncertain outcomes and concurrent binding/registry changes
- dot mailbox pagination, recipient isolation, explicit ACK and expiry/capacity
- Grok Bot session routing and fixed, nonsecret upstream-error handling
- Existing-human change challenge binding, attempt limits, expiry and atomic consumption
- Callback target validation, signature verification and bounded opportunistic retries
- Final source inventory, credentials/personal-data review and third-party provenance

Review [SECURITY.md](../SECURITY.md) for known limits. A code-review concern is not
fixed merely because it is documented or because unrelated tests pass.

## Deployment and live checks

Perform only with explicit authorization, development accounts where possible,
and a clear list of intended external messages and configuration changes.

1. Verify deployed version and the intended origin, authenticated identity and
   filtered tool list. Keep deployment proof separate from source-test results.
2. Verify each intended receiving route: dot event subscription and inbox/ACK,
   or the registered Grok Bot session. BotlineMCP cannot create platform tasks itself.
3. Bind the approved bot; verify bot state and webhook update types independently.
   Register the human only after confirming their Telegram identity.
4. Follow the [private-DM live acceptance procedure](dms.md#private-dm-live-acceptance).
   Confirm inbound payload, Telegram receipt reactions (🕊 / 👀 / 💔), agent
   processing and visible reply as separate results. A reaction is not proof the
   agent ran.
5. For human configuration changes, verify the code is shown on the other agent's
   native channel and the human chooses whether to transfer it. Do not automate
   code relay or describe this as server-proven human presence.
6. Test outage/recovery or destructive unbind scenarios only when separately
   approved. Preserve credentials and existing routes; report ambiguous outcomes.

Keep runtime IDs, private domains, message bodies, credentials, account screenshots
and operational evidence out of the public source tree. Publish only a sanitized
summary with the source revision and exact verified scope.

## Settings binding diagnostics

Settings reports fixed nonsecret failure codes. A foreign webhook is rejected before any webhook change; Settings then offers a separate, five-minute, one-use migration confirmation showing only the old host. The user re-enters the same token personally and explicitly confirms the bot, target instance and handle. The server rechecks actor, binding generation and old webhook fingerprint under its binding lock before replacing the webhook with setWebhook (drop_pending_updates:false), then checks getWebhookInfo. It never calls deleteWebhook first. Other handles’ bindings cannot be taken. Telegram has no conditional webhook update, so external changes between inspection and writing cannot be made atomic; already in-flight requests may still reach the old service. Cancellation and expired/changed confirmation perform no webhook write. Identity or webhook inspection failures also do not attempt a webhook write. Once a webhook write is attempted, a failed response or final persistence remains unconfirmed: inspect `telegram_bot_get` and do not automatically retry. Binding attempts still consume their one-use settings session. No credential, foreign webhook URL, or raw upstream error is displayed. Mock regression coverage is not a live Telegram binding acceptance test.

Input rejection codes distinguish request/cookie/form structure, bot-token format, handle format, and unregistered handles without echoing submitted fields. An input rejection does not attempt a Telegram webhook change. The OAuth dot identity and Settings handle lookup share the same instance namespace and are covered with a parsed-form regression test.

## Muse regression acceptance (offline)

- Drain 51/101/512 messages across pages; poll again before ACK after a worker
  crash, and verify only explicitly ACKed messages disappear. A failed later
  page must not be reported as a successful partial poll.
- Reuse an explicit send request ID after an uncertain result; do not mint a new ID.
- Fill two Muse inboxes to 500 messages each, send the 1001st aggregate message,
  then read/ACK and send to another profile using the actual SQL store.
- Revoke/replace the human, rotate the binding generation, and unbind: old
  Telegram payloads must not remain readable; unrelated agent messages survive.
- Reject converting existing Grok/webhook handles to Muse, preserve dot/Grok
  human confirmation routes, and keep confirmation codes human-mediated.

These are mocked transport and PGlite checks, not production or live integration
acceptance. Live registration, credential changes and messaging need separate authorization.

### Server-generated inbox sender headers

Dot and Muse `messages_inbox` keep the object schema (`message_id`, `sender`,
`reply_to_message_id`, and server `confirmation` when present). `sender.platform`
is retained; `text` is now `[handle.platform@botline]:`, a newline, then the
unaltered original body, using the same formatter as Grok delivery. Only this
first line is generated from server routing metadata; any header-like body lines
remain untrusted text. Never parse the body to infer identity or authorization.
Muse uses `muse`, dot `chatgpt`, Grok `grokbot`, humans `user`; unknown historical
agent platforms remain `agent`. This is registered routing identity, not independent
platform attestation or human consent. Storage retains the original body, so reads
do not stack headers. ACK and deduplication still use `message_id`, not text.

## Onboarding regression checks

`test/onboarding.test.js` checks both HTTP entrypoints for explicit HTML setup
navigation, same-origin links, SSE/no-Accept compatibility and Origin rejection.
It checks anonymous discovery instructions and anonymous business-tool rejection,
and that hosted/self-host instructions share the canonical public guide. These are
local mocked checks, not live registration, credential entry, receiver subscription,
paid provisioning or message acceptance. Validate those only with explicit authorization.


## Small attachment release verification

Offline PGlite tests exercise the real Store tables/transactions and encrypted
bytea storage, actual 2 MiB production MCP request parsing and native image/blob
results, recipient-only grants, ACK/expiry behavior, source-human/binding revocation,
quota reservations under concurrency, and rollback of grants on failed enqueue.
Synthetic Telegram mocks cover safe getFile paths, stream bounds, duplicate webhook
ingestion, multipart sends and uncertain outcomes without automatic resend. The
Muse CLI tests save synthetic bytes, verify integrity, and refuse overwrite.

These tests do not send actual Telegram photos/documents, contact external agents,
validate every MCP client's image rendering/download UI, or establish the production
provider plan/remaining billing allowance. Production checks are public read-only
version/discovery checks; real attachment delivery requires separate user permission.
