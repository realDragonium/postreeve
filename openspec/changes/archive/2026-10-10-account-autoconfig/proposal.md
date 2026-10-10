# Proposal

## Why

Adding an IMAP/SMTP account requires typing hosts, ports and TLS settings by hand. A user connecting 5–10 addresses (iCloud, Fastmail, custom domains) to replace Apple Mail makes avoidable mistakes and has no hint that most of these providers reject the normal account password. No Linear issue; requested directly as part of the daily-driver work.

## What Changes

- New `POST /api/accounts/discover` takes an email address and proposes IMAP and SMTP settings from, in order: a built-in provider table (iCloud incl. me.com/mac.com, Fastmail, Yahoo, AOL, Zoho, GMX, Gmail), the domain's own Thunderbird autoconfig file, the Thunderbird ISPDB, and the domain's MX record matched against the same provider table (custom domains hosted at iCloud, Fastmail, Google or Zoho).
- Outbound lookups are HTTPS only, go to URLs derived from the email domain plus the fixed ISPDB host, never follow redirects, time out after a few seconds, read at most 64 KiB and never carry a password. Insecure (`plain`) server entries are ignored.
- The account sheet asks for name and email first, offers **Find settings**, fills the server fields with the proposal and names its source. Every field stays editable, and the existing verify-before-save behavior is unchanged.
- Fixed provider guidance: app-specific password instructions for iCloud, Fastmail, Yahoo, AOL and GMX/Zoho where relevant; Outlook.com/Hotmail and Proton Mail are recognized and explained as not supported by password sign-in yet; Gmail addresses (and Google-hosted domains) point to **Continue with Google** when it is configured. Provider responses are never echoed.
- README and FEATURES.md describe the faster onboarding.

Out of scope: OAuth for Microsoft, Proton Bridge certificate trust, per-account colors or reordering, autodiscovery on the Manage (edit) sheet.

## Capabilities

### New Capabilities

- `accounts/settings-discovery`: Proposing IMAP/SMTP settings and provider guidance from an email address, including the outbound-lookup safety limits.

### Modified Capabilities

None. Adding, testing and editing accounts (`accounts/imap-smtp-accounts`) keep their requirements; discovery only prefills the existing form. WebMCP tools are unchanged because they do not add accounts.

## Impact

- Server: new discovery module and route in `src/server/api.ts`; wiring in `src/server/index.ts`. Uses `fetch` and `node:dns/promises`; no new dependency.
- Shared contracts: discovery request/response schemas.
- Web: `AccountSetup` in `src/web/panels.tsx` and `src/web/api.ts`.
- Docs: README.md, FEATURES.md.
