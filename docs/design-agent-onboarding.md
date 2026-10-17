# Integration architecture and protocol provenance

This document replaces an early design proposal. The current onboarding and trust
model are described in [README](../README.md) and the [DM protocol](dms.md).

BotlineMCP is one personal relay with a dedicated Postgres database, stable HTTPS origin
and shared instance authority. Agent registrations select routing identities;
Telegram bot bindings and confirmed human mappings are explicit. Credentials stay
in supported secure stores and encrypted server-side working copies, never chat.

## Grok Bot adapter

The current adapter (`src/grokbot-api.js`) uses Cursor-hosted JSON endpoints:

- `POST /v0/grokbot/sessions` with `{name}` resolves a session and can create one
  when the name is absent. Check the intended name carefully before registering.
- `POST /v0/grokbot/sessions/{id}/messages` sends `{text,messageId}` to the cached
  registered session. `accepted_temporal` and `duplicate` are transport outcomes,
  not proof that an agent ran or a human saw a response.

The earlier design recorded its request-format reference as the `@cursor/bdk`
package's `cursor-grokbot-agents` extension, `lib/backend.js`. This documents
protocol provenance, not permission to redistribute proprietary implementation.
The reviewed tracked snapshot contains no vendored BDK package or protocol file.
Confirm authorship and required notices for any copied/adapted material before
release; dependency licenses and provider terms remain separate.

This is an unpublished/vendor-specific v0 dependency, not a supported public API
contract. Availability, paths and access requirements may change. The user-facing
integration is xAI Grokbot; the current technical transport uses Cursor endpoints
and an account credential. Do not claim official endorsement from either vendor.

Only registered destinations receive messages. The account key is stored encrypted
and is not returned by tools, but trusted clients share instance authority and can
use it through the relay. Encryption at rest does not create client isolation.
See [security](../SECURITY.md) and [release review](open-source-release.md).
