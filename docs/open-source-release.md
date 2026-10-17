# Open-source release checklist

This is a preparation checklist, not authorization to publish or deploy.
BotlineMCP is the selected repository name; MIT copyright is attributed to realTaki.
This is not a trademark-clearance claim. Verify the documented security-reporting options
and final publication scope before release.

## Scope and source provenance

The draft describes the 0.6.15 source snapshot. Record the exact reviewed source
commit and exported file manifest in release evidence, without copying private
operational logs or Git history into the public release.

The existing `docs/design-agent-onboarding.md` records the Grok Bot request-format
reference as the Cursor BDK `@cursor/bdk` extension's `lib/backend.js` and describes
the API as unpublished v0. That is a protocol-reference statement, not proof of
permission to redistribute third-party implementation code. The current tracked
snapshot contains no vendored BDK package or protocol file. Before release, confirm
whether any implementation was copied/adapted and retain any required upstream
notices. Do not characterize API access as an official SDK support agreement.

The Grok Bot adapter currently uses Cursor-hosted endpoints and a Cursor account
key to reach the user-facing xAI Grokbot integration. These naming/ownership layers
must not be silently collapsed into a claim of an official xAI API. A mistyped
registered Grok Bot name may create/select the wrong session; verify the intended
name before registration. Treat account-level key access as a broad trust decision.

Dependency review of the current lockfile found MIT packages except `split2` and
`pg-int8` (ISC), and development dependency `@electric-sql/pglite` (Apache-2.0).
Recheck licenses after dependency changes. Project MIT terms do not replace package
licenses, provider terms, trademarks or any required third-party notices. Do not
include `node_modules` in a source export.

## Name and identity checklist

- Use BotlineMCP for the public project name and `botline-mcp` for package metadata;
  use the verified repository destination and preserve the realTaki MIT attribution.
- Update public prose, package name and lockfile root metadata consistently.
  `private: true` prevents accidental npm publication; leave it unless publishing
  a package is a separate explicit decision.
- Review setup HTML, OAuth consent titles, connector instructions and MCP metadata
  for the old project label. Remove outdated group-chat wording.
- Do not blindly replace the existing cryptographic HKDF label, record namespaces,
  routing handles, token prefixes or OAuth identities. Those can be compatibility
  inputs, not cosmetic branding. Changing them requires an explicit migration plan.
- Do not invent a homepage, security email, badge, deploy button or repository URL
  before the actual public destination exists.

## Clean source export

A fresh snapshot is safer than publishing an operational checkout with its history.
Work in a new empty staging directory outside the deployment checkout. Do not
modify the current remote, deployment settings, runtime database or old history.

1. Pin the reviewed source revision and list its tracked paths. Use that reviewed
   manifest as the allowlist; do not copy the entire working directory or infer
   safety solely from `.gitignore`.
2. Export only reviewed application/test source, public static files, package
   manifests/lockfile, schema, deployment configuration, project guidance and
   sanitized documentation. Overlay the reviewed public README, CONTRIBUTING,
   SECURITY and completed MIT LICENSE.
3. Exclude `.git`, `.env`/`.env.*` except the empty `.env.example`, `.vercel`,
   `node_modules`, coverage/build output, local editor files, backups, archives,
   screenshots, logs, database dumps, runtime data, credentials and session state.
   Do not export untracked files simply because they look like source. In the
   reviewed workspace `src/access-notifications.js` and
   `test/access-notifications.test.js` are local-only retired artifacts and must
   not be included in the current tracked-source export.
4. Inspect every exported file and run a secret/identifier scan before initializing
   any new public repository. Scan values and context, not just token-shaped strings;
   tests contain synthetic credentials. Inspect URLs, personal IDs, emails and
   historical live-acceptance prose separately. Keep private audit evidence private.
5. Review `vercel.json` for old deployment-specific branch settings; a public sample
   should not silently carry an unrelated deployment policy. Treat any change to
   the running project's configuration as separate from a sanitized source export.
6. In the staged copy run `npm ci`, `npm run check`, and `npm test`. Remove generated
   dependencies/artifacts from the proposed release inventory afterward. Preserve
   a manifest/hash inventory of the files actually reviewed and tested.
7. Confirm no generated/test/runtime files will be committed, verify licensing
   and the documented security-reporting fallback, then obtain publication approval for the
   exact destination and source scope. Do not push, deploy, rewrite history or
   create a repository as a side effect of preparing these docs.

If previous history is intentionally retained instead, audit all reachable commits,
branches/tags and other publication surfaces independently. A clean current tree
is not proof of clean history. History rewriting does not revoke leaked secrets.

## Compatibility and release evidence

The owner reports verified use with **ChatGPT dot, xAI Grokbot and Telegram**.
Other agents may be implementable through the protocol, but have not been verified.
Record source checks, deployment revision and live results separately; historical
acceptance notes are not evidence that every current-version flow was tested.

Before release confirm:

- Required local checks pass on the exact export, using mocks/development data.
- Source provenance and copyright wording are reviewed; required notices retained.
- Credential, personal-data and artifact audit scope/limits are documented privately.
- No generic OAuth compatibility claim contradicts the ChatGPT redirect allowlist.
- No claim treats cross-type human-code handoff as independent hard 2FA.
- No claim promises immediate retry, idle-time erasure, E2EE, autonomous task creation
  or delivery based only on HTTP acceptance.
- Security reporting accurately describes available options; no fabricated contact or
  unverified enabled advisory endpoint is published.

Known code-review follow-ups are separate from this naming release:
protection against unbounded public OAuth registration/consent rows and explicit
long-term OAuth/legacy retention. Version 0.6.14 replaced reflected upstream errors
with fixed descriptions and corrected OAuth consent to describe private DMs. Configure platform-level rate limits, but do not represent
that as proof these application-level issues have been fixed.
