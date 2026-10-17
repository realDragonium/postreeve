import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { AgentScope } from "../../shared/agent-access";

const migrationVersion = 900001;

export function migrateAgentAccess(sqlite: Database): void {
  if (sqlite.query("SELECT 1 FROM schema_migrations WHERE version = ?").get(migrationVersion)) return;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_clients (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, redirect_uris TEXT NOT NULL,
        auth_method TEXT NOT NULL CHECK (auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
        secret_hash TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_grants (
        id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('oauth', 'token')),
        client_id TEXT REFERENCES agent_clients(id) ON DELETE CASCADE,
        name TEXT NOT NULL, redirect_host TEXT, scopes TEXT NOT NULL, account_ids TEXT,
        created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_codes (
        hash TEXT PRIMARY KEY NOT NULL,
        grant_id TEXT NOT NULL REFERENCES agent_grants(id) ON DELETE CASCADE,
        client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
        resource TEXT, expires_at TEXT NOT NULL, used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_tokens (
        hash TEXT PRIMARY KEY NOT NULL,
        grant_id TEXT NOT NULL REFERENCES agent_grants(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh', 'personal')),
        resource TEXT, scopes TEXT NOT NULL, expires_at TEXT, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_tokens_grant_idx ON agent_tokens(grant_id);
      CREATE TABLE IF NOT EXISTS agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, grant_id TEXT NOT NULL, agent_name TEXT NOT NULL,
        tool TEXT NOT NULL, account_id TEXT, outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
        summary TEXT NOT NULL, error TEXT,
        target_kind TEXT CHECK (target_kind IN ('batch', 'proposal')), target_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_events_created_idx ON agent_events(created_at);
    `);
    sqlite.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, CURRENT_TIMESTAMP)").run(migrationVersion);
  })();
}

export type ClientAuthMethod = "none" | "client_secret_post" | "client_secret_basic";
export type TokenKind = "access" | "refresh" | "personal";

export interface AgentClient {
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly authMethod: ClientAuthMethod;
  readonly secretHash: string | null;
  readonly createdAt: string;
}

export interface AgentGrant {
  readonly id: string;
  readonly kind: "oauth" | "token";
  readonly clientId: string | null;
  readonly name: string;
  readonly redirectHost: string | null;
  readonly scopes: readonly AgentScope[];
  /** `null` means every account, including ones added later. */
  readonly accountIds: readonly string[] | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export interface StoredCode {
  readonly grantId: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string | null;
  readonly expiresAt: string;
  readonly usedAt: string | null;
}

export interface StoredToken {
  readonly hash: string;
  readonly grantId: string;
  readonly kind: TokenKind;
  readonly resource: string | null;
  readonly scopes: readonly AgentScope[];
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface AgentEventInput {
  readonly grantId: string;
  readonly agentName: string;
  readonly tool: string;
  readonly accountId: string | null;
  readonly outcome: "ok" | "error";
  readonly summary: string;
  readonly error: string | null;
  readonly targetKind: "batch" | "proposal" | null;
  readonly targetId: string | null;
}

export interface AgentEvent extends AgentEventInput {
  readonly id: number;
  readonly createdAt: string;
}

const eventRetention = 5_000;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** 256 random bits with a type prefix, so a leaked value says what it is. */
export function newSecret(prefix: "pva_" | "pvr_" | "pvt_" | "pvc_" | "pvs_"): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

interface GrantRow {
  id: string; kind: "oauth" | "token"; client_id: string | null; name: string; redirect_host: string | null;
  scopes: string; account_ids: string | null; created_at: string; last_used_at: string | null; revoked_at: string | null;
}

function toGrant(row: GrantRow): AgentGrant {
  return {
    id: row.id, kind: row.kind, clientId: row.client_id, name: row.name, redirectHost: row.redirect_host,
    scopes: JSON.parse(row.scopes) as AgentScope[], accountIds: row.account_ids ? JSON.parse(row.account_ids) as string[] : null,
    createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at,
  };
}

export class AgentAccessStore {
  readonly #sqlite: Database;
  readonly #now: () => Date;

  constructor(sqlite: Database, now: () => Date = () => new Date()) {
    this.#sqlite = sqlite;
    this.#now = now;
  }

  now(): Date {
    return this.#now();
  }

  #iso(offsetMs = 0): string {
    return new Date(this.#now().getTime() + offsetMs).toISOString();
  }

  registerClient(input: { name: string; redirectUris: readonly string[]; authMethod: ClientAuthMethod }): { client: AgentClient; secret: string | null } {
    const secret = input.authMethod === "none" ? null : newSecret("pvs_");
    const client: AgentClient = {
      id: crypto.randomUUID(), name: input.name, redirectUris: [...input.redirectUris], authMethod: input.authMethod,
      secretHash: secret ? hashSecret(secret) : null, createdAt: this.#iso(),
    };
    this.#sqlite.query(`INSERT INTO agent_clients (id, name, redirect_uris, auth_method, secret_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(client.id, client.name, JSON.stringify(client.redirectUris), client.authMethod,
      client.secretHash, client.createdAt);
    return { client, secret };
  }

  getClient(id: string): AgentClient | null {
    const row = this.#sqlite.query("SELECT * FROM agent_clients WHERE id = ?").get(id) as {
      id: string; name: string; redirect_uris: string; auth_method: ClientAuthMethod; secret_hash: string | null; created_at: string;
    } | null;
    return row ? {
      id: row.id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[], authMethod: row.auth_method,
      secretHash: row.secret_hash, createdAt: row.created_at,
    } : null;
  }

  /** Open registration grants nothing, so registrations that never led to consent are dropped. */
  pruneUnusedClients(olderThanMs: number): void {
    this.#sqlite.query(`DELETE FROM agent_clients WHERE created_at < ?
      AND NOT EXISTS (SELECT 1 FROM agent_grants WHERE client_id = agent_clients.id)`).run(this.#iso(-olderThanMs));
  }

  createGrant(input: {
    kind: "oauth" | "token"; clientId: string | null; name: string; redirectHost: string | null;
    scopes: readonly AgentScope[]; accountIds: readonly string[] | null;
  }): AgentGrant {
    const grant: AgentGrant = { id: crypto.randomUUID(), ...input, createdAt: this.#iso(), lastUsedAt: null, revokedAt: null };
    this.#sqlite.query(`INSERT INTO agent_grants (id, kind, client_id, name, redirect_host, scopes, account_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(grant.id, grant.kind, grant.clientId, grant.name, grant.redirectHost,
      JSON.stringify(grant.scopes), grant.accountIds ? JSON.stringify(grant.accountIds) : null, grant.createdAt);
    return grant;
  }

  getGrant(id: string): AgentGrant | null {
    const row = this.#sqlite.query("SELECT * FROM agent_grants WHERE id = ?").get(id) as GrantRow | null;
    return row ? toGrant(row) : null;
  }

  listActiveGrants(): AgentGrant[] {
    return (this.#sqlite.query("SELECT * FROM agent_grants WHERE revoked_at IS NULL ORDER BY created_at DESC").all() as GrantRow[])
      .map(toGrant);
  }

  revokeGrant(id: string): boolean {
    const now = this.#iso();
    return this.#sqlite.transaction(() => {
      const changed = this.#sqlite.query("UPDATE agent_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes;
      this.#sqlite.query("UPDATE agent_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(now, id);
      this.#sqlite.query("DELETE FROM agent_codes WHERE grant_id = ?").run(id);
      return changed > 0;
    })();
  }

  touchGrant(id: string): void {
    this.#sqlite.query("UPDATE agent_grants SET last_used_at = ? WHERE id = ?").run(this.#iso(), id);
  }

  issueCode(input: Omit<StoredCode, "expiresAt" | "usedAt">, lifetimeMs: number): string {
    const code = newSecret("pvc_");
    this.#sqlite.query(`INSERT INTO agent_codes (hash, grant_id, client_id, redirect_uri, code_challenge, resource, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(hashSecret(code), input.grantId, input.clientId, input.redirectUri,
      input.codeChallenge, input.resource, this.#iso(lifetimeMs));
    return code;
  }

  /** Marks the code used and returns it as it was, so a replay is visible to the caller. */
  consumeCode(code: string): StoredCode | null {
    return this.#sqlite.transaction(() => {
      const hash = hashSecret(code);
      const row = this.#sqlite.query("SELECT * FROM agent_codes WHERE hash = ?").get(hash) as {
        grant_id: string; client_id: string; redirect_uri: string; code_challenge: string; resource: string | null;
        expires_at: string; used_at: string | null;
      } | null;
      if (!row) return null;
      if (!row.used_at) this.#sqlite.query("UPDATE agent_codes SET used_at = ? WHERE hash = ?").run(this.#iso(), hash);
      return {
        grantId: row.grant_id, clientId: row.client_id, redirectUri: row.redirect_uri, codeChallenge: row.code_challenge,
        resource: row.resource, expiresAt: row.expires_at, usedAt: row.used_at,
      };
    })();
  }

  issueToken(grantId: string, kind: TokenKind, scopes: readonly AgentScope[], resource: string | null, lifetimeMs: number | null): string {
    const token = newSecret(kind === "access" ? "pva_" : kind === "refresh" ? "pvr_" : "pvt_");
    this.#sqlite.query(`INSERT INTO agent_tokens (hash, grant_id, kind, resource, scopes, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(hashSecret(token), grantId, kind, resource, JSON.stringify(scopes),
      lifetimeMs === null ? null : this.#iso(lifetimeMs), this.#iso());
    return token;
  }

  findToken(token: string): StoredToken | null {
    const row = this.#sqlite.query("SELECT * FROM agent_tokens WHERE hash = ?").get(hashSecret(token)) as {
      hash: string; grant_id: string; kind: TokenKind; resource: string | null; scopes: string;
      expires_at: string | null; revoked_at: string | null;
    } | null;
    return row ? {
      hash: row.hash, grantId: row.grant_id, kind: row.kind, resource: row.resource,
      scopes: JSON.parse(row.scopes) as AgentScope[], expiresAt: row.expires_at, revokedAt: row.revoked_at,
    } : null;
  }

  revokeToken(hash: string): void {
    this.#sqlite.query("UPDATE agent_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL").run(this.#iso(), hash);
  }

  recordEvent(event: AgentEventInput): void {
    this.#sqlite.query(`INSERT INTO agent_events
      (grant_id, agent_name, tool, account_id, outcome, summary, error, target_kind, target_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event.grantId, event.agentName, event.tool, event.accountId,
      event.outcome, event.summary, event.error, event.targetKind, event.targetId, this.#iso());
    this.#sqlite.query(`DELETE FROM agent_events WHERE id <= (SELECT id FROM agent_events ORDER BY id DESC LIMIT 1 OFFSET ?)`)
      .run(eventRetention);
  }

  listEvents(limit: number): AgentEvent[] {
    return (this.#sqlite.query("SELECT * FROM agent_events ORDER BY id DESC LIMIT ?").all(limit) as Array<{
      id: number; grant_id: string; agent_name: string; tool: string; account_id: string | null; outcome: "ok" | "error";
      summary: string; error: string | null; target_kind: "batch" | "proposal" | null; target_id: string | null; created_at: string;
    }>).map((row) => ({
      id: row.id, grantId: row.grant_id, agentName: row.agent_name, tool: row.tool, accountId: row.account_id,
      outcome: row.outcome, summary: row.summary, error: row.error, targetKind: row.target_kind, targetId: row.target_id,
      createdAt: row.created_at,
    }));
  }
}
