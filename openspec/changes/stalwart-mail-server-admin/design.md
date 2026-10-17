# Design

## Context

See proposal.md for motivation. Facts that shape the approach:

- **Pinned version: Stalwart v0.16.26** (released 2026-10-11, the latest stable; 1.0 has not shipped). Source read at tag `v0.16.26`; behavior below was confirmed against that release binary running locally on throwaway data.
- **v0.16 removed the REST management API.** All administration is JMAP: `POST <admin-url>/jmap/` with `using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]` and methods named `x:<Object>/get|set|query`. Auth is HTTP Basic or `Authorization: Bearer <api key>`. The small remaining REST surface (`/api/auth`, `/api/schema`, live SSE streams) is for the web UI. Anything written against the pre-0.16 `/api/principal` API is dead, so Postreeve targets 0.16 only and checks for the `urn:stalwart:jmap` capability.
- **Wire encoding** (from `crates/registry`): variant objects carry `"@type"` (`{"@type":"User"}`); object lists are maps keyed by index (`{"0": {...}}`); sets are `{"value": true}`; durations are milliseconds; singletons use the id `singleton`; updates accept JSON-pointer keys (`"credentials/0/secret"`).
- `GET /jmap/session` returns `primaryAccounts["urn:stalwart:jmap"]`, the admin's own account id, and an `apiUrl` built from the *public* hostname. Postreeve always posts to `<configured admin URL>/jmap/` and ignores `apiUrl`, because the admin URL is the tailnet address.
- feat/identities-folders (wildcard `*@domain` identities) has not been pushed, so there is nothing to build on yet. Today's identity schema requires a plain email address.
- feat/remote-mcp is pushed but not merged. Its shared tool layer takes `WebMcpTool` definitions.

### What the Stalwart API covers, and what Postreeve uses

| Area | Stalwart objects | Postreeve |
|---|---|---|
| Domains | `x:Domain` (name, aliases, `catchAllAddress`, `dkimManagement`, `dnsManagement`, server-built `dnsZoneFile`) | list, add, delete, catch-all |
| Mailboxes | `x:Account` `@type: User` (name, `domainId`, description, `credentials`, `aliases`, `quotas.maxDiskQuota`, `usedDiskQuota`) | list, create, rename, quota, reset password, aliases, delete |
| App passwords | `x:AppPassword/set` with the target account as `accountId` (admin has `Impersonate`); the response returns the secret once | one-step Postreeve account |
| Lists | `x:MailingList` (name, domainId, recipients) | list, create, edit recipients, delete |
| DKIM | `x:DkimSignature` (`Dkim1RsaSha256`/`Dkim1Ed25519Sha256`, selector, stage, privateKey, publicKey); automatic rotation via `Domain.dkimManagement` | list, generate, delete |
| DNS | `Domain.dnsZoneFile`: BIND text with MX, SPF, DKIM, DMARC, SRV, MTA-STS, TLS-RPT, autoconfig/autodiscover, CAA when ACME is on | checklist + live check |
| Queue | `x:QueuedMessage` (recipients with status, retryCount, `nextRetry`); retry = set `nextRetry` to a past date (what the web UI does), cancel = destroy | list, retry, cancel |
| Reports | `x:DmarcExternalReport`, `x:TlsExternalReport` (received); `x:*InternalReport` (outgoing) | received reports, read-only |
| Spam | `x:SpamSettings` singleton (`enable`, `scoreSpam`, `scoreReject`, `scoreDiscard`, …); `x:MemoryLookupKey` namespaces `trusted-domains`, `blocked-domains` | the switch, three thresholds, two domain lists |

**Left to Stalwart's own web admin on purpose:** network listeners and ports, TLS certificates and ACME providers, automatic DNS providers (`x:DnsServer`), the spam rule set, classifier training, DNSBLs and LLM settings, MTA routing, throttles, queues and hooks, Sieve system scripts, storage backends, clustering, tenants and roles, OIDC/LDAP directories, groups, masked email, telemetry, logs and traces, IP allow/block lists, outgoing (internal) reports, and bootstrap/recovery. These are set once per server, are dangerous to get wrong from a second UI, or have no day-to-day use for a one-person mail setup. Postreeve links to the Stalwart admin URL for them.

## Goals / Non-Goals

**Goals:**
- Everything the owner does weekly on a mail server, from Postreeve, without credentials leaving the server process.
- Deterministic tests against a fake Stalwart JMAP endpoint that speaks the exact wire encoding above, plus an opt-in test against a real throwaway instance.

**Non-Goals:**
- Supporting Stalwart before 0.16, or other servers (poste.io, Mailcow). The client sits behind a small interface so another backend can be added later.
- Automatic DNS publishing. Stalwart can do it with provider credentials; Postreeve only shows and checks.
- Running the migration. The runbook and scripts are inventory and dry-run helpers; the owner runs them.

## Decisions

1. **One module, own tables.** `src/server/stalwart/` holds the JMAP client, zone parser, DNS checker, store and service; routes mount under `/api/mail-servers`. Shared files change by a few lines: `index.ts` (mount), `credentials.ts` (generic `encryptSecret`/`decryptSecret`), `SettingsView.tsx` (one section). Schema migration `910001` creates `mail_servers` and `mail_server_proposals`, following the `agent-access` pattern of a module-owned migration. *Alternative:* extend `accounts` with a server kind. Rejected: a mail server is not a mailbox and must not appear in the account list or sync runner.

2. **Admin credential: API key recommended, Basic allowed.** An API key (`x:ApiKey`) can be revoked in Stalwart without changing the admin password and can carry narrowed permissions. Basic auth stays as a fallback for first setup. Either one is sealed with the existing AES-256-GCM vault key. *Alternative:* OAuth device flow against Stalwart. Rejected for now: more moving parts for one user, and API keys already give revocation.

3. **Admin URL policy.** HTTPS required, except loopback, RFC 1918, CGNAT/Tailscale (`100.64.0.0/10`) and `*.ts.net`, where `http` is allowed because the transport is already private. The owner's admin UI is tailnet-only, which is exactly this case.

4. **One-step account uses an app password, never the mailbox password.** Postreeve creates `x:AppPassword` named `Postreeve` on the new mailbox (verified: an admin can do this through `accountId` impersonation, and the app password works for IMAP login). If the Postreeve account cannot connect, Postreeve revokes that app password and reports a partial success. This keeps the human password out of Postreeve and lets the owner revoke Postreeve's access in Stalwart alone. IMAP 993 and SMTP 465 with implicit TLS against the server's mail hostname, which defaults to the session's `apiUrl` host and can be edited.

5. **Identity registration by exact address; wildcard when available.** An alias or catch-all registers an identity on the Postreeve account whose email equals the target mailbox. For the catch-all, Postreeve tries `*@domain` through the shared `createIdentityInputSchema`. Today that schema rejects it, so the response reports `skipped` with the reason, and the same code starts registering wildcards as soon as feat/identities-folders lands, with no change here.

6. **Typed confirmation on the server, not only in the UI.** Delete routes take `{ confirm: "<name>" }` and compare it server-side, so a script or agent that reaches the API cannot skip it. Domain delete refuses while mailboxes or lists exist (Stalwart returns `objectIsLinked`; Postreeve counts them first so the message is clear), then removes DKIM keys and the domain. Postreeve never cascades into mailbox deletion.

7. **DKIM keys generated in Postreeve.** Stalwart's `x:DkimSignature/set` requires a private key; `node:crypto` makes RSA-2048 or Ed25519 PKCS#8 PEM, which is sent once inside `{"@type":"Text","secret": pem}` and dropped. New domains use automatic DKIM management, so Stalwart generates keys itself; manual generation is for adding a selector or an extra algorithm.

8. **DNS checklist from `dnsZoneFile`.** Stalwart already computes the exact records for its configuration (selectors, MTA-STS id, report addresses). Postreeve parses that BIND text (multi-string TXT in parentheses, relative and absolute names) instead of re-deriving it. Verification goes through a `DnsLookup` interface: DNS-over-HTTPS JSON (`https://cloudflare-dns.com/dns-query`, override with `POSTREEVE_DOH_URL`) by default because it bypasses stale local caches and split-horizon tailnet DNS (MagicDNS would otherwise answer for the tailnet, not the public internet); `POSTREEVE_DNS_RESOLVER=system` switches to `node:dns`. Lookups run with a concurrency of 6 and a 5-second timeout each.

9. **Spam: five settings and two lists.** Threshold semantics follow Stalwart (0 = off). Trusted domains ship with about 800 defaults, so the UI pages through them with a client-side filter and shows counts; the server fetches in pages of 500 (Stalwart's `maxObjectsInGet`).

10. **Agent proposals are their own record.** Message proposals (`actions/proposals`) are tied to one mailbox account and message references, so they cannot hold server operations. `mail_server_proposals` stores `{ title, operations[], status: pending|applied|failed|rejected, results[] }`. Agents can only create them. Approve and reject routes exist only in `/api/mail-servers/proposals/*`, which the same-origin guard already limits to the Postreeve page. Agent-proposed mailbox creation carries no password; the owner enters it at approval, so an agent never learns or chooses one. Apply runs operations in order and stops at the first failure, because later steps usually depend on earlier ones (domain before mailbox).

11. **Tool definitions now, registration at merge.** `src/server/stalwart/agent-tools.ts` exports `mailServerTools(services)` returning `WebMcpTool` objects with JSON Schemas made the same way as the existing tools. The WebMCP page tool set stays fixed at fifteen (agents/webmcp-tools is unchanged). When feat/remote-mcp merges, the coordinator adds these tools to its list: read-only tools under `mail:read`, `propose_mail_server_change` under `mail:propose`. This is a one-line integration, recorded here so it is not lost.

12. **Fake Stalwart for tests.** `tests/support/fake-stalwart.ts` implements the used subset of `x:` methods over a `fetch` function with Stalwart's id style, encoding, error shapes (`invalidProperties`, `primaryKeyViolation`, `objectIsLinked`) and `dnsZoneFile` output copied from the real server. An opt-in `tests/stalwart-live.test.ts` runs the same service against a real instance when `POSTREEVE_STALWART_TEST_URL` and `POSTREEVE_STALWART_TEST_KEY` are set; `scripts/stalwart-test-instance.sh` boots a throwaway v0.16.26 on high loopback ports.

## Risks / Trade-offs

- [Stalwart's JMAP management objects change between 0.16.x and 1.0] → Version pinned in docs and compose; the client checks the capability and surfaces Stalwart's own error text; the fake is built from the real v0.16.26 responses so a mismatch shows up in the live test.
- [The Postreeve web UI has no authentication yet, and this area can delete mailboxes] → Same loopback/tailnet-only deployment rule as the rest of Postreeve; server-side typed confirmation; credentials never returned. feat/owner-auth will put login in front of all of `/api`.
- [An admin API key in Postreeve is a high-value secret] → Vault encryption, never logged or returned, recommend a dedicated revocable key; docs say how to revoke it.
- [DNS-over-HTTPS sends record names to Cloudflare] → Names only, they are public DNS anyway; `POSTREEVE_DNS_RESOLVER=system` or `POSTREEVE_DOH_URL` for a different resolver.
- [Proposal operations go stale between preparation and approval] → Each operation is validated against Stalwart when applied; failure stops the rest and is recorded.

## Migration Plan

Schema migration `910001` only adds tables; rollback is dropping them. No existing data changes. The poste.io to Stalwart cutover is documented in `docs/migrate-poste-io.md` and is the owner's separate step.
