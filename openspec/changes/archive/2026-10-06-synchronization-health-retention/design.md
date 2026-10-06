# Design

## Context
The durable index stores summaries and previews; message bodies remain fetched on demand. The current job has only a failure kind and update time. Startup can fail when one account cannot register.

## Decisions
Persist latest failure time and successful sync time alongside existing classified failure. Retry preserves actionable failure until success. Authentication failure pauses automatic attempts; credential replacement resumes synchronization. Derive disconnected from unavailable provider/canceled job, reauthorization from classified authentication failure, degraded from other failure or stale success, catching-up from incomplete coverage, otherwise healthy.

Keep fixed server-generated guidance, never raw provider messages, cursors or credentials. An unavailable account does not prevent other accounts starting; global vault construction errors remain fatal. Initialization validates key availability before account catches when encrypted accounts exist. A durable provider-unavailable marker pauses jobs without replacing their scheduling state, so restored configuration resumes eligible work while intentional cancellation and authentication pauses survive. Replacing verified credentials resets checkpoints but preserves failure and last-success evidence until page progress.

Configure maxAgeDays (30) and maxContentBytes (104857600) per account through environment defaults. Disposable preview content expires since last refresh and oldest-first when over budget; use UTF-8 byte counts. Preserve every indexed summary row and all canonical identity, location, conversation, draft, proposal and operation metadata. Exact per-account preview byte totals are maintained by SQLite insert/update/delete triggers, including canonical merges; oldest eligible previews are selected in bounded batches using a partial age index, avoiding a full mailbox scan per provider page. No attention model exists and none is introduced. Retention runs after writes and periodically even when providers are unavailable; clients see policy and retained byte count. This is a content bound, not a total database-file bound.

Expose dedicated synchronization API without changing liveness. UI and agents share inspect/retry and human reauthorization instructions. Agents receive no credential input and cannot approve proposals. Reauthorization remains existing Gmail consent or IMAP account management.

## Verification
Pure state classification and in-memory SQLite checks cover failed retry, successful recovery, authentication pause, restart, tenant/account isolation, exact UTF-8 budget, age expiry and unchanged metadata identity. API and WebMCP tests exercise real service contracts. Browser fixture exercises Settings and retry with deterministic providers.
