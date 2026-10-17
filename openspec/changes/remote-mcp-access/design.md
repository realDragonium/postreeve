# Design

## Context

WebMCP tools live in `src/server/webmcp/tools.ts` and call a `WebMcpServices` interface that the browser implements over `/api` (`src/web/webmcp.ts`). The server has no authentication today; owner login comes from the parallel `feat/owner-auth` workstream, which will export `requireOwner` and `getOwnerSession(c)` from `src/server/security/owner-auth.ts` and add `POSTREEVE_PUBLIC_URL`. Store migrations are hand-written SQL inside `Store`, versioned in `schema_migrations`, with Drizzle table definitions in `schema.ts`.

## Goals / Non-Goals

**Goals:**
- One tool layer for page and remote agents; remote picks a subset by scope.
- Spec-compliant MCP authorization that claude.ai, Claude Code and ChatGPT connectors can complete unaided.
- The human approval boundary holds for remote agents: no send, no approve, no apply.

**Non-Goals:**
- Multi-user or multi-tenant authorization. There is one owner.
- MCP sessions, server-initiated notifications, resources or prompts.
- Replacing browser-local WebMCP attribution.

## Decisions

### Shared tool layer: definitions carry scope and surface
`createPostreeveAgentTools(services)` returns definitions with `scope` (`read`, `propose`, `act`), `surfaces` (`webmcp`, `remote`) and `destructive`. `createPostreeveWebMcpTools` filters to the page surface and strips the extra fields before `registerTool`; the remote server filters by surface and the grant's scopes. `send_message` is page-only. Alternative: separate remote tool file calling the service directly. Rejected: two schemas drift, and FEATURES.md requires agent tools to mirror user workflows.

The server implements `WebMcpServices` over `PostreeveService` (`src/server/mcp/services.ts`), wrapped with the grant's account restriction. `showMailboxView` is a no-op there.

### Proposal tools on both surfaces
The task allows remote agents to prepare proposals. Exposing them only remotely would make the page the weaker agent surface for no safety gain, since creating a proposal changes no mail and only the UI's Accept approves. The `update_proposal` input schema only allows `status: "review"`, so approval is unrepresentable, and the service also refuses it.

### Scopes as three tiers
`mail:read`, `mail:propose`, `mail:act`. The consent page offers them as cumulative tiers because a person picks "how much can it do", not a scope matrix. `request_reauthorization` only returns instructions, so it is read. Folder changes, direct actions, undo and retry are act. The middle tier is the recommended default: the agent prepares and the owner accepts.

### Stateless Streamable HTTP with JSON responses
Each `POST /mcp` builds a low-level SDK `Server` and a `WebStandardStreamableHTTPServerTransport` with no session ID generator and `enableJsonResponse`. The low-level `Server` takes the shared JSON Schemas directly; `McpServer.registerTool` would need Zod shapes and re-derive schemas. Stateless fits a single Fly machine, needs no session store and survives restarts. GET/DELETE answer 405, which the transport spec allows.

### Own OAuth authorization server, tokens opaque and hashed
Postreeve is both resource and authorization server, as the MCP spec allows. Tokens are 32 random bytes, base64url, with a type prefix (`pva_`, `pvr_`, `pvt_`, `pvc_`, `pvs_`) so leaked tokens are identifiable. Storage is SHA-256: the tokens have 256 bits of entropy, so a slow hash adds nothing. Lookup by hash avoids timing leaks on comparison. Alternative: JWT access tokens. Rejected: revocation must take effect on the next call, which needs a lookup anyway.

Access tokens last 1 hour; refresh tokens rotate on every use and last 30 days; reuse of a rotated refresh token or a used code revokes the grant (OAuth 2.1 recommendation). PATs do not expire; the owner revokes them.

A grant is the "connected agent": one per consent or PAT, holding scopes, account restriction (null for all, including future accounts), name and last use. Tokens hang off a grant, so revoking a grant ends every token.

### Dynamic client registration is open
claude.ai and ChatGPT register themselves, so registration cannot require the owner. It grants nothing; consent does. When `token_endpoint_auth_method` is omitted the client is registered as public (`none`) and the response says so, because most MCP clients omit it and use PKCE; RFC 7591's `client_secret_basic` default would break them. Clients with no grant are pruned after 24 hours on each registration to bound open registration. Redirect URIs must be `https` or loopback `http`; loopback may vary the port (RFC 8252).

### Consent page is server-rendered HTML
It needs no SPA route, works with the existing CSP (no script, inline styles allowed) and `X-Frame-Options: SAMEORIGIN` prevents clickjacking. Pending requests live in memory for 10 minutes keyed by a random ID that doubles as CSRF token; the POST also requires the owner session and a same-origin `Origin`. A restart drops pending consents, which only means reloading the authorize page.

The page shows the client's self-declared name and its redirect host. The name is spoofable, the host is not; the owner judges both. Without a session the page asks the owner to sign in and reload rather than guessing the login route, which belongs to the owner-auth workstream.

### Owner-auth placeholder
`src/server/security/owner-auth.placeholder.ts` implements `getOwnerSession` (a session only for loopback `Host` names, matching today's trust model) and `requireOwner` (401 otherwise); `owner-auth.ts` re-exports it. The coordinator replaces `owner-auth.ts` at merge time. Hosted deployments without the real module get no consent and no settings API, which fails closed.

### Audit table and provenance
`agent_events` records every remote call (not just writes), because reads of mail are what an owner most wants to see from a remote agent. Summaries hold counts and names, never message content. The newest 5,000 rows are kept. Batch attribution is the event's `target_kind = 'batch'` row, so `operation_batches` and the core service stay unchanged. Activity hides those batch events as separate rows and uses them to label the batch rows instead.

### Mounting
`createAgentAccess` returns one Hono router for `/.well-known/*`, `/oauth/*`, `/mcp` and `/api/agent-access/*`. `index.ts` mounts it before the static fallback; `/api/agent-access` inherits the existing `/api/*` middleware. CORS (`*`, no credentials) applies to metadata, register, token, revoke and `/mcp`, never to authorize or `/api`.

## Risks / Trade-offs

- [Open DCR can fill the clients table] → prune ungranted clients after 24 hours; registration grants nothing.
- [Client name spoofing on the consent page] → show the redirect host prominently beside the name.
- [Prompt injection in mail drives an act-scope agent] → act tools are undoable and audited, no send or approve exists remotely, and the consent page recommends the propose tier.
- [`sameOriginGuard` compares `Origin` with `http://<Host>`, so page POSTs fail behind HTTPS] → owned by owner-auth (`src/server/security/*`); flagged to the coordinator, not changed here.
- [`allowedHostGuard` rejects the public host name] → also owner-auth's; it must admit the host of `POSTREEVE_PUBLIC_URL`.
- [In-memory pending consents do not survive restarts] → acceptable; the owner reloads.

## Migration Plan

Migration 900001 creates five new tables with `CREATE TABLE IF NOT EXISTS`; no existing data changes. Rollback: the tables are unused by older builds.
