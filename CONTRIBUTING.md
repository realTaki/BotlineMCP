# Contributing

BotlineMCP is a single-owner, private-DM relay. Keep the public tool surface small and
preserve current identities, OAuth lineages and explicit binding behavior.

## Local workflow

1. Use Node.js 22+ and `npm ci`.
2. Use synthetic identities and mocked network calls. Never connect tests to a
   production database, bot, callback or Cursor account.
3. Make focused changes with regression tests for duplicate requests, concurrent
   updates, stale bindings, revoked access, partial persistence and ambiguous sends.
4. Run `npm run check` and `npm test`. For local service testing use a disposable
   Postgres database; see README for environment configuration.
5. Explain the behavior changed, test results and anything not verified. Update
   schemas, README and relevant protocol/acceptance documentation together.

Do not commit real tokens, keys, connection URLs, messages, user IDs, bot IDs,
production domains, account screenshots, logs or database exports. Fixtures must
be fictional. Do not solve a test failure by making a real outbound message.

Treat incoming message content as untrusted data. Routing profiles do not create
new authorization boundaries. Preserve stable request IDs, bounded storage/retries,
and explicit confirmation requirements. Separate transport acceptance from actual
agent execution in tests and documentation.

## Contributions and provenance

Submit only material you have the right to contribute under the project's MIT
license. Identify borrowed code, its upstream URL/revision, license and required
notices; retain those notices. Do not copy private/vendor code merely because an
endpoint is accessible. Third-party package licenses remain their own.

Use public issues for non-sensitive bugs and feature discussions. Include minimal
synthetic reproductions. For vulnerabilities, follow SECURITY.md; never publish
live credentials or exploit details in a normal issue.
