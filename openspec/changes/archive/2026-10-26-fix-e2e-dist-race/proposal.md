# Proposal

## Why

`owner-auth.spec.ts` failed in full e2e runs but passed alone. Two specs ran `bun run build` themselves: `owner-auth.spec.ts` in `beforeAll` and `installable-app.spec.ts` inside its test. `vite build` empties `dist` before writing it, and the owner-auth, indexed-search and synchronization fixture servers serve `./dist`. When one worker rebuilt while another worker's server was serving the bundle, that page got `404 Not Found` and the test timed out waiting for the sign-in or setup screen. Rebuilding `dist` in a loop while `owner-auth.spec.ts` runs fails 2 of its 3 repeats on main.

`identities.spec.ts` was also reported flaky. Its root cause, the identity migration's refetch joining the first in-flight fetch, was fixed in `2026-10-17-fix-font-and-identity-race`. Undoing that fix fails the migration test 8 of 12 times; main passes it every time, so it needs no change here.

## What Changes

- A Playwright `globalSetup` builds the production bundle once, before any worker starts.
- `owner-auth.spec.ts` and `installable-app.spec.ts` no longer build. `owner-auth.spec.ts` drops serial mode, which only existed to avoid parallel builds; each test already starts its own server.

Test tooling only, so no spec changes.
