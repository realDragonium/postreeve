# Tasks

- [x] 1 Strato provider entry with `rzone.de` MX matching; Proton Mail Bridge defaults; guidance copy; discovery tests
- [x] 2 `tls-trust.ts`: pin schema, pinned TLS options, certificate-error classification, inspection over TLS and STARTTLS
- [x] 3 `tlsPin` in IMAP and SMTP credentials; IMAP, IDLE and SMTP connections use it; IP-host servername fix
- [x] 4 Service: pin on add, test and update after re-probing; `CertificateTrustError`; settings expose fingerprints; sync classification
- [x] 5 API error with the presented certificate; web API error carries it; account sheet review and trust UI
- [x] 6 Tests with local TLS servers and generated certificates (pinned, changed, unpinned, STARTTLS, API, service); e2e for the sheet
- [x] 7 FEATURES.md, `bun run verify`, `openspec validate --specs --strict`
