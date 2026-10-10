# Design

## Context

Identities are browser-local (`postreeve.local-identities.v1`). The web compose form sends only through drafts (`POST .../drafts/<id>/send`); `POST /api/messages/send` is used by WebMCP and API clients. Drafts already store `identity: { name, address }`, and provider Drafts-folder copies already write it as From. Senders (`SmtpMailSender`, `GmailMailClient`) hard-code the account address as From. Listings expose `deliveredTo`.

## Goals / Non-Goals

**Goals:** server-side identities, alternate From for draft sends over SMTP and Gmail, sensible reply defaults.

**Non-Goals:** importing Gmail Send-as addresses as identities, renaming identities, adding a catch-all address as an identity from the reader, alternate From on `POST /api/messages/send` or WebMCP, SMTP-side credentials per identity.

## Decisions

- **Storage**: new `identities` table `(tenant_id, id, account_id, name, address, created_at)`, unique on `(tenant_id, account_id, address)` with addresses lower-cased on write. Deleted explicitly in `deleteAccount`, like drafts. Adding an existing address returns the stored row, which makes the browser migration idempotent without client IDs (unlike drafts, an identity has a natural key).
- **Who resolves From**: the core resolves From when preparing a send — the primary address for direct sends, the draft identity for draft sends after checking it against the account and its identities. An empty draft identity name falls back to the stored identity (or account) name. The sender receives `SendMessageInput & { from?: OutboundAddress }`; absent `from` means the configured primary address, so existing sender callers keep working. The HTTP send contract does not gain a `from` field (YAGNI; nothing in the UI uses it).
- **Message-ID coordination**: senders compute `const from = input.from ?? primary` once and use it for the header and the SMTP envelope. The parallel sent-copies change derives the Message-ID domain from this same `from`.
- **Gmail**: `GET users/me/settings/sendAs` is allowed under `gmail.modify` (also `gmail.readonly`, `gmail.settings.basic`). Gmail silently rewrites an unauthorized From to the primary address, so the sender checks the list first and only for non-primary addresses. Accepted: `isPrimary`, or `verificationStatus` not `pending` (Workspace domain aliases may omit the status). Failures are `MailSendPreDispatchError`, so a draft lands in `failed`, not `uncertain`. No caching: one extra request per alternate-From send is cheap and avoids stale verification state.
- **SMTP**: the From address becomes `MAIL FROM`. A server that refuses an unauthorized sender rejects `MAIL FROM`, which is already classified pre-dispatch. Servers that accept and rewrite are outside Postreeve's control.
- **Reply default From** (web, pure function): first own address (primary or identity) found in source `deliveredTo`, then `to`, then `cc`; else primary. Own addresses also exclude recipients in reply and reply-all. Applies to new conversation forms only; a saved draft keeps its identity.
- **WebMCP**: unchanged. `agents/webmcp-tools` already keeps `send_message` narrow and explicitly excludes other identities; an agent gains nothing it cannot do via the human compose flow, and adding From would widen the approval surface.
- **Migration**: mirrors the drafts migration (`postreeve.local-identities.migrated.v1`), dropping malformed/primary/400 records and retrying the rest.

## Risks / Trade-offs

- [Gmail Send-as list unreadable (outage)] → the send fails before dispatch with a clear error; retry later.
- [SMTP server accepts but rewrites From] → not detectable; documented in the identity sheet that the provider must allow the address.
- [Identity removed while a draft uses it] → draft send is refused with 400; compose shows the saved identity and disables Send until another is chosen.

## Migration Plan

The table is created with `CREATE TABLE IF NOT EXISTS`; no data migration on the server. Browser identities migrate on next load. Rollback leaves an unused table.
