# Proposal

## Why

The owner's mail runs on Gmail, one custom domain at Strato, and several custom domains on self-hosted poste.io (Dovecot + Haraka). poste.io often serves its own self-signed certificate, or is reached by a LAN or tailnet IP that the certificate does not name. Postreeve refuses such servers outright, and the only workaround (turning verification off) would expose the mailbox password to anyone on the path. The same limitation blocks Proton Mail Bridge. Strato custom domains also get no settings proposal.

## What Changes

- A built-in Strato entry (`imap.strato.de:993` TLS, `smtp.strato.de:465` TLS, full address as username), matched through MX hosts under `rzone.de`.
- Proton Mail addresses propose Proton Mail Bridge's local defaults (`127.0.0.1:1143` and `127.0.0.1:1025`, STARTTLS) instead of "cannot connect".
- Opt-in certificate trust per account, for IMAP and SMTP separately. When a test, add or update fails certificate verification, the error carries the presented certificate (SHA-256 fingerprint, subject, issuer, validity, self-signed). The owner reviews it and checks **Trust this certificate**. The server pins the certificate only if it still presents that exact fingerprint. Pinned connections keep verification on, add the certificate as a trust anchor and require the exact fingerprint in place of the host-name check. A changed certificate fails with a review message, and synchronization pauses as reauthorization-required.
- IMAP over TLS to an IP address now connects under Bun. ImapFlow passes `servername: false` for IP hosts, which Bun rejects.

## Capabilities

### Modified Capabilities

- `accounts/settings-discovery`: Strato via MX, Proton Mail Bridge defaults.
- `accounts/imap-smtp-accounts`: certificate review and pinning, settings report pinned fingerprints.

## Impact

`src/server/mail/tls-trust.ts` (new), `src/server/mail/imap.ts`, `imap-idle.ts`, `smtp.ts` (one TLS-options line each), `src/server/security/credentials.ts` (optional `tlsPin` in the encrypted credentials), `src/server/core/postreeve.ts`, `src/server/core/errors.ts`, `src/server/api.ts`, `src/server/sync/runner.ts` (failure classification), `src/server/accounts/providers.ts`, `src/shared/contracts.ts`, `src/web/api.ts`, `src/web/account-discovery.ts`, `src/web/panels.tsx` (account sheet). No schema migration: pins live in the encrypted credential blob.
