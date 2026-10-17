Self-signed certificates generated with `openssl req -x509 -newkey rsa:2048 -nodes -days 36500` for
`tests/tls-trust.test.ts`. They exist only to test certificate pinning against local TLS servers and are
not used anywhere else. `pinned` is the certificate an owner trusts; `other` stands in for a changed one.
