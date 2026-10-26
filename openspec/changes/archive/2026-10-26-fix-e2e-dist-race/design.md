# Design

## Decisions

1. **Build once in `globalSetup` rather than adding retries or locks.** Every spec that needs `dist` reads the same bundle, so there is nothing to rebuild per spec. A global build also gives `indexed-search.spec.ts`, which never built and relied on another spec having done it, a bundle it can count on.
2. **Keep the revocation test's tolerant loop.** It accepts the sign-in screen appearing before any click because background requests can notice the revoked session first. That is correct app behavior, not a flake.
