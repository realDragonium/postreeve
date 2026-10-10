# Design

## Context

`AccountSetup` (`src/web/panels.tsx`) is a single form for new and existing IMAP accounts; it already prefills SMTP host/username/password from IMAP. The API (`src/server/api.ts`) takes its collaborators as constructor arguments, and tests inject doubles. IMAP (`imapflow`) and SMTP (`nodemailer`) treat `secure: true` as implicit TLS and `secure: false` as an upgrade with STARTTLS; both verify certificates.

## Goals / Non-Goals

**Goals:** one request turns an address into a full proposal; lookups are deterministic to test; outbound requests cannot be steered to arbitrary URLs.

**Non-Goals:** OAuth for Microsoft; trusting Proton Bridge's self-signed certificate; RFC 6186 SRV lookups; caching results; ISPDB lookups by MX base domain (needs a public-suffix list).

## Decisions

**Server-side discovery, client-side copy.** The browser's CSP only allows `'self'`, and autoconfig hosts send no CORS headers, so lookups run on the server. The server returns only structured data (`provider` ID, `source`, validated settings); all user-facing copy is a fixed map in the web client keyed by provider ID. Nothing from a remote document reaches the UI except validated hostnames, ports and usernames that go into editable fields.

**Module shape.** `src/server/accounts/discovery.ts` exports `createAccountDiscovery({ fetch, resolveMx })` returning `discover(email)`. The provider table lives in `src/server/accounts/providers.ts` as data: `{ id, domains, mxSuffixes, settings | null }`. `createApi` accepts the discovery function in `ApiOptions` and defaults to one built from the global `fetch` and `dns.promises.resolveMx`, so `index.ts` needs no change. Tests pass stubs, so no test touches the network.

**Provider table (usernames are always the full address).**

| ID | Domains | MX suffix | IMAP | SMTP |
|---|---|---|---|---|
| icloud | icloud.com, me.com, mac.com | mail.icloud.com | imap.mail.me.com 993 TLS | smtp.mail.me.com 587 STARTTLS |
| fastmail | fastmail.com, fastmail.fm | messagingengine.com | imap.fastmail.com 993 TLS | smtp.fastmail.com 465 TLS |
| yahoo | yahoo.com, ymail.com, rocketmail.com | yahoodns.net | imap.mail.yahoo.com 993 TLS | smtp.mail.yahoo.com 465 TLS |
| aol | aol.com | — | imap.aol.com 993 TLS | smtp.aol.com 465 TLS |
| zoho | zoho.com, zohomail.com | zoho.com | imap.zoho.com 993 TLS | smtp.zoho.com 465 TLS |
| zoho (EU) | zoho.eu, zohomail.eu | zoho.eu | imap.zoho.eu 993 TLS | smtp.zoho.eu 465 TLS |
| gmx | gmx.com | — | imap.gmx.com 993 TLS | mail.gmx.com 587 STARTTLS |
| gmx (DE) | gmx.de, gmx.net, gmx.at, gmx.ch | gmx.net | imap.gmx.net 993 TLS | mail.gmx.net 587 STARTTLS |
| gmail | gmail.com, googlemail.com | google.com, googlemail.com | imap.gmail.com 993 TLS | smtp.gmail.com 465 TLS |
| outlook | outlook.com, hotmail.com, live.com, msn.com | outlook.com | — | — |
| proton | proton.me, protonmail.com, protonmail.ch, pm.me | protonmail.ch | — | — |

iCloud documents the local part as the usual IMAP username but accepts the full address; using the full address everywhere keeps one rule that also works for MX-matched custom domains. Outlook.com personal accounts no longer accept password (basic) authentication for IMAP/SMTP, so they get guidance instead of settings. Proton needs Bridge on localhost with a self-signed certificate that the current TLS verification rejects; offering its settings would always fail. AOL's MX lives under `yahoodns.net` and resolves to Yahoo, whose servers differ, so AOL has no MX suffix and a Yahoo MX match proposes Yahoo's servers (correct for Yahoo-hosted custom domains).

**Lookup order and concurrency.** Exact domain match returns immediately. Otherwise the two autoconfig URLs, ISPDB and MX run concurrently, each with its own 5 s timeout; the result is the first usable one in the order autoconfig (subdomain, then well-known), ISPDB, MX. Worst case is about 5 s instead of 15–20 s sequentially. The email address is not sent as `?emailaddress=`: Thunderbird does, but static files do not need it and omitting it discloses less.

**Request hardening.** Domain normalized through `new URL("https://" + domain).hostname` (lowercase, punycode), then rejected unless it has at least two labels of `[a-z0-9-]` and a non-numeric TLD. `fetch(url, { redirect: "manual", credentials: "omit", signal })`; any non-200 (including 3xx) is no answer. Body read through the stream with a 64 KiB cap. No XML dependency: a small parser extracts `<incomingServer type="imap">` / `<outgoingServer type="smtp">` blocks and their `hostname`, `port`, `socketType`, `username`, `authentication` children, decoding the five XML entities. Hostnames must be DNS names (no IP literals, no `localhost`). Authentication must include `password-cleartext` or `password-encrypted`, or be absent.

**UI.** Name and email move to the top of the new-account sheet with a **Find settings** chip next to email; lookup is explicit only (no auto-run on blur), so it never overwrites fields the user typed unless asked. On success it sets all eight connection fields and marks SMTP host/username as edited so later IMAP edits no longer overwrite them. A status line names the source; guidance renders under it. Gmail on a configured server shows the guidance pointing at the existing **Continue with Google** block, which stays at the top.

**Account list at ~10 accounts.** The sidebar already scrolls, lists accounts in creation order and shows the email with `kind · name`. No change; rail colors use 6 hues, so collisions are expected at 10 accounts — recorded as a follow-up proposal, not done here.

## Risks / Trade-offs

- [Preset data goes stale] → Fields stay editable and the connection test reports failure before saving.
- [Autoconfig publishes a wrong or hostile server] → Only TLS/STARTTLS entries are accepted, the user sees the proposal before connecting, and credentials are only sent when the user connects.
- [Domain-derived URL reaches an internal host via DNS] → Only fixed paths on `autoconfig.<domain>`/`<domain>` over HTTPS with certificate validation, no redirects, GET only, small bodies, and responses reduced to hostnames/ports; the server runs on loopback for the local user who typed the address.
- [STARTTLS is opportunistic in the existing IMAP/SMTP clients] → Unchanged existing behavior; out of scope here.
