# Design

## Context

ImapFlow and nodemailer both merge an optional `tls` object into `tls.connect`, for implicit TLS and after STARTTLS. Node and Bun call `checkServerIdentity` only after the chain verifies, so a self-signed certificate never reaches it while `rejectUnauthorized` is on.

## Decisions

- **Pinning without disabling verification.** A pinned connection passes `ca: [...tls.rootCertificates, pinnedPem]` and a `checkServerIdentity` that accepts only the pinned SHA-256 fingerprint. The self-signed certificate becomes a trust anchor, so the chain verifies. A publicly issued certificate reached by IP still verifies through the public roots, and the fingerprint check replaces the host-name check in both cases. Any other certificate fails, either at the chain (an unknown self-signed one) or at the fingerprint check. `rejectUnauthorized: false` is used only by the read-only inspection probe, which closes the socket after reading the certificate and never sends credentials. Verified against Bun 1.4 and Node with generated certificates.
- **Not supported**: a leaf issued by a private CA that is not in the root store, because the chain cannot verify from the leaf alone. The owner can add that CA to the system store; recorded as a known limit.
- **What is stored**: `{ fingerprint, certificate }` per service inside the encrypted credentials (`tlsPin`), so pins are removed with the account and need no migration. The PEM is required as the trust anchor.
- **The browser never supplies the certificate.** The client sends only the reviewed fingerprint (colons optional). The server probes the certificate again and pins it only when the fingerprints match, so a certificate swapped between review and save is refused with the new certificate shown.
- **Inspection** (`inspectCertificate`) handles implicit TLS and both STARTTLS dialects (IMAP `a1 STARTTLS`, SMTP `EHLO`/`STARTTLS`), with a 10-second limit, no SNI for IP hosts, and cleanup of late sockets. It is injectable through `PostreeveContext.inspectCertificate`.
- **Error shape**: `CertificateTrustError` maps to 400 `{ error, code: "certificate_untrusted", certificate }`. Other connection failures keep the fixed messages that reveal no provider detail. The certificate is server-public data, not a secret. IMAP is checked first, so trusting both services of one server takes two tests. That keeps the flow identical to the existing one.
- **Classification** walks the error and its `cause` chain for OpenSSL and Node verification codes, plus a `CERT_PIN_MISMATCH` code of our own, with message patterns as a fallback because wrappers may drop codes.
- **A changed certificate in background synchronization** is classified as `reauthorization`. That kind already pauses automatic retries and points the owner to account settings, which is the right action: the owner must review the new certificate. A new failure kind would ripple through the sync store and health contracts for no behavior difference. The IMAP reauthorization instructions now mention reviewing a changed certificate.
- **Update semantics**: an absent fingerprint keeps the stored pin, `null` removes it, and an equal fingerprint keeps the stored pin without probing. Removing trust still has to pass the connection test, so a self-signed server cannot be left unpinned by accident.
- **IP hosts under Bun**: ImapFlow sets `servername: false` for IP literals, and Bun's `tls.connect` throws on that. `imapTlsOptions` clears it to `undefined` for IP hosts. This affected every IMAP-over-TLS connection to an IP address, pinned or not.
- **Strato**: `imap.strato.de:993` and `smtp.strato.de:465`, both implicit TLS, with the full address as username, per Strato's FAQ and third-party guides that agree. Custom domains are matched by MX suffix `rzone.de` (`smtpin.rzone.de`, `mailin.rzone.de`). Strato's German folder names (Gesendete Objekte, Entwürfe, Papierkorb, Spamverdacht) are already in the special-folder name list, so detection works whether or not Strato's Dovecot advertises SPECIAL-USE. That could not be confirmed from public docs.
- **poste.io** needs no provider entry: its MX is the owner's own host. Hand entry with 993/465 (or 587 STARTTLS) works, and certificate trust covers its self-signed default. Its Dovecot SPECIAL-USE configuration could not be confirmed from public docs, so name detection and folder overrides cover either case.
- **Proton Mail Bridge** defaults (`127.0.0.1:1143`/`1025`, STARTTLS) are proposed with guidance to check them in the Bridge app.

## Risks / Trade-offs

- [Owner trusts a MITM certificate] → the sheet shows the fingerprint and asks the owner to compare it with the server's. Trust is per account and per service and never automatic.
- [Pinned certificate renewed (e.g. Let's Encrypt on poste.io)] → connections fail loudly and synchronization pauses until the owner reviews and trusts the new one. For a publicly valid certificate on its own host name, the owner can stop trusting instead.
