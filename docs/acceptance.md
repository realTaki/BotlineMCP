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
   Confirm inbound payload, agent processing and visible reply as separate results.
5. For human configuration changes, verify the code is shown on the other agent's
   native channel and the human chooses whether to transfer it. Do not automate
   code relay or describe this as server-proven human presence.
6. Test outage/recovery or destructive unbind scenarios only when separately
   approved. Preserve credentials and existing routes; report ambiguous outcomes.

Keep runtime IDs, private domains, message bodies, credentials, account screenshots
and operational evidence out of the public source tree. Publish only a sanitized
summary with the source revision and exact verified scope.

## Settings binding diagnostics

Settings reports fixed nonsecret failure codes. A foreign webhook is rejected before any webhook change; disconnect it through its owning service with approval. Identity or webhook inspection failures also do not attempt a webhook write. Once a webhook write is attempted, a failed response or final persistence remains unconfirmed: inspect `telegram_bot_get` and do not automatically retry. Binding attempts still consume their one-use settings session. No credential, foreign webhook URL, or raw upstream error is displayed. Mock regression coverage is not a live Telegram binding acceptance test.
