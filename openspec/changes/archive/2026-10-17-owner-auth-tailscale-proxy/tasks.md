# Tasks

- [x] 1.1 Read `X-Forwarded-Proto`, `-Host` and `-For` from their rightmost entry when the proxy is trusted; drop the Fly headers
- [x] 1.2 Use the forwarded host for the public-URL match, expected origins and the WebAuthn RP; check both `Host` and `X-Forwarded-Host` in the host guard
- [x] 1.3 Tests: forwarded host and scheme through `tailscale serve`, rebinding with an added `X-Forwarded-Host`, rightmost `X-Forwarded-For`, identity headers never authenticate
- [x] 1.4 Update README and the specs; run `bun run verify`, the e2e suite and `bunx openspec validate --specs --strict`
