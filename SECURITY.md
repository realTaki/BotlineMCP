# Security

## Reporting

Report vulnerabilities privately through this GitHub repository: Security tab →
Report a vulnerability. Do not use a personal email address, and do not open a
public issue with credentials, vulnerability details or exploit information. No
response-time or supported-version service commitment is currently made.

Report the affected version, expected/observed behavior and a synthetic minimal
reproduction. Redact credentials, personal identifiers and message contents.
Only test instances you own or are authorized to assess.

## Threat model

- A deployment serves one owner and trusted agent software. `MCP_API_KEY` confers
  instance-wide authority. Agent tokens, handles and filtered tool catalogs do not
  establish independent tenants or a least-privilege permission model.
- OAuth uses PKCE, short-lived access tokens and rotating refresh credentials.
  The session's identity cannot be overridden with another agent token. The
  implemented redirect allowlist is limited to the ChatGPT hostnames.
- Bot/operational secrets are encrypted with AES-256-GCM using an HKDF-derived key
  from the instance key. This is encryption at rest, not end-to-end encryption;
  the running server can decrypt secrets and process plaintext messages. Pending
  message payloads and metadata are sensitive database data.
- Changing the instance key also changes the encryption key and invalidates old
  sessions after redeployment. Plan revocation and re-encryption/re-entry of all
  affected working credentials. Do not casually rotate the key on a live database.
- Telegram webhook secrets, current binding checks, registered-human checks and
  signed callbacks protect transport paths. Callbacks require verification and
  public HTTPS destinations with DNS/address checks, bounded requests and no redirects.
  These controls are not a claim of an independent security audit.
- Incoming text, sender labels and external metadata remain untrusted even when
  transported through the owner's account. A routed agent message is not owner
  consent for an external action.

## Human configuration changes

Existing-human changes require a short-lived code delivered to a different-type
registered agent. Challenge binding, expiry, attempt limits and atomic consumption
reduce accidental or replayed changes. The recipient agent is instructed to show
it to the human and never relay it to another agent automatically.

This depends on agent behavior. It is not independent cryptographic approval,
server-enforced human presence, or hard 2FA: shared instance credentials do not
create separate authorization authorities. Initial human registration requires
external identity confirmation by the caller. Do not infer identity from display
names or incoming requests.

## Operator responsibilities

Use unique high-entropy keys and separate databases for each deployment. Keep
credentials out of model-visible chat and logs. Secure the hosting account,
database, backups and independent recovery vault. Set appropriate platform rate
limits and monitor capacity and delivery failures without retaining message bodies
in diagnostics. Review retention for OAuth records, old receipts and legacy data. Public OAuth registration still lacks application-wide throttling and general TTL
cleanup; the consent page is bounded by a storage-backed limiter. Restrict remaining
abuse at the hosting layer and address storage growth.
Version 0.6.15 uses fixed descriptions for Grok Bot API errors rather than
reflecting upstream response bodies. Maintain this boundary in future adapters.

The 24-hour pending-message TTL is not an idle-time physical deletion guarantee;
pruning needs a later operation. Backups can retain data longer. Explicit unbind
removes local credentials and pending binding data, but a remote webhook deletion
may remain unconfirmed. In-flight sends cannot be recalled.

If credentials leak, restrict access and revoke the affected credentials at their
providers using an owner-approved recovery plan; deleting a file or rewriting Git
history does not revoke a credential. Do not include leaked values in reports.
