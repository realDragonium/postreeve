# Proposal

## Why

Two defects found while building the daily-use web app:

- **The interface font never loaded in production.** `index.html` linked the Google Fonts stylesheet, but the server's CSP allows only same-origin styles (`style-src 'self' 'unsafe-inline'`), so every page load logged a CSP violation and fell back to the system font.
- **A reply sometimes used the account's main address instead of the alias the message was delivered to.** `identities.spec.ts` failed in about a third of runs on the base branch.

## What Changes

- Bundle Instrument Sans (400 to 700) from `@fontsource/instrument-sans` and drop the Google Fonts links. No CSP change; the installed app also gets the font offline, and opening Postreeve makes no third-party request.
- After the local draft and identity migrations, cancel any in-flight list fetch before invalidating it, so the migrated items appear.
- Compose follows the default From address when identities load after it opened, until the person picks one.

These restore behavior the specs already require (compose/identities: replies default to the delivered identity), so no spec changes.
