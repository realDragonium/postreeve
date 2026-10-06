import type { Database } from "bun:sqlite";
import { z } from "zod";
import { messageSummarySchema, type CanonicalMessage, type CanonicalMessageSummary, type MailProviderKind, type MessageRef } from "../../shared/contracts";
import { toCanonicalObservation, type ProviderMessageSummary } from "../mail/provider";
import { syncPageSchema, syncScopeKey, type SyncAccount, type SyncPage, type SyncScope, type SyncFailureKind } from "../mail/synchronization";
import type { MailboxSnapshot } from "../db/store";

const jobSchema = z.object({
  tenant_id: z.string(), account_id: z.string(), provider: z.enum(["gmail", "imap"]),
  state: z.enum(["queued", "running", "retry", "canceled"]), generation: z.string(),
  due_at: z.number(), lease_until: z.number().nullable(), attempts: z.number(),
  error: z.enum(["provider", "reauthorization", "invalid-data"]).nullable(),
  coverage: z.enum(["partial", "catching-up", "complete"]), updated_at: z.number(),
});
export type SyncJob = z.infer<typeof jobSchema>;
export interface SyncClaim extends SyncAccount { readonly generation: string }
interface ScopeRow { scope: string; cursor: string | null; due_at: number; coverage: "partial" | "catching-up" | "complete" }
const indexedContentSchema = messageSummarySchema.omit({ ref: true, canonicalId: true, canonicalAliases: true, read: true, flagged: true });

export class SynchronizationStore {
  constructor(
    readonly sqlite: Database,
    readonly reconcile: (snapshot: MailboxSnapshot) => CanonicalMessage[],
    readonly move: (tenantId: string, provider: MailProviderKind, previous: MessageRef, current: MessageRef) => boolean,
    readonly canonical: (tenantId: string, id: string) => CanonicalMessage | null,
  ) { this.#migrate(); }

  schedule(tenantId: string, accountId: string, now: number, replace = false): void {
    this.sqlite.transaction(() => {
      const account = this.sqlite.query("SELECT kind FROM accounts WHERE id = ?").get(accountId) as { kind: MailProviderKind } | null;
      if (!account) return;
      this.sqlite.query(`INSERT INTO sync_jobs(tenant_id,account_id,provider,state,generation,due_at,lease_until,attempts,error,coverage,updated_at)
        VALUES(?,?,?,'queued',?,?,NULL,0,NULL,'partial',?) ON CONFLICT(tenant_id,account_id) DO NOTHING`)
        .run(tenantId, accountId, account.kind, crypto.randomUUID(), now, now);
      if (replace) {
        this.sqlite.query("DELETE FROM sync_scopes WHERE tenant_id=? AND account_id=?").run(tenantId, accountId);
        this.sqlite.query("DELETE FROM sync_scans WHERE tenant_id=? AND account_id=?").run(tenantId, accountId);
        this.sqlite.query(`UPDATE sync_jobs SET state='queued',generation=?,due_at=?,lease_until=NULL,attempts=0,error=NULL,coverage='partial',updated_at=?
          WHERE tenant_id=? AND account_id=?`).run(crypto.randomUUID(), now, now, tenantId, accountId);
      }
    }).immediate();
  }

  jobs(tenantId: string): SyncJob[] {
    return z.array(jobSchema).parse(this.sqlite.query("SELECT * FROM sync_jobs WHERE tenant_id=? ORDER BY due_at,account_id").all(tenantId));
  }

  cancel(tenantId: string, accountId: string, now: number): void {
    this.sqlite.query(`UPDATE sync_jobs SET state='canceled',generation=?,lease_until=NULL,updated_at=? WHERE tenant_id=? AND account_id=?`)
      .run(crypto.randomUUID(), now, tenantId, accountId);
  }

  retry(tenantId: string, accountId: string, now: number): void {
    this.sqlite.query(`UPDATE sync_jobs SET state='queued',generation=?,due_at=?,lease_until=NULL,attempts=0,error=NULL,updated_at=? WHERE tenant_id=? AND account_id=?`)
      .run(crypto.randomUUID(), now, now, tenantId, accountId);
  }

  release(claim: SyncClaim, now: number): void {
    this.sqlite.query(`UPDATE sync_jobs SET state='queued',generation=?,due_at=?,lease_until=NULL,updated_at=?
      WHERE tenant_id=? AND account_id=? AND generation=? AND state='running'`)
      .run(crypto.randomUUID(), now, now, claim.tenantId, claim.accountId, claim.generation);
  }

  claim(tenantId: string, now: number, leaseMs: number): SyncClaim | null {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query(`SELECT * FROM sync_jobs WHERE tenant_id=? AND
        ((state IN ('queued','retry') AND due_at<=?) OR (state='running' AND lease_until<=?)) ORDER BY due_at,account_id LIMIT 1`)
        .get(tenantId, now, now);
      if (!row) return null;
      const job = jobSchema.parse(row);
      const generation = crypto.randomUUID();
      this.sqlite.query(`UPDATE sync_jobs SET state='running',generation=?,lease_until=?,updated_at=? WHERE tenant_id=? AND account_id=?`)
        .run(generation, now + leaseMs, now, tenantId, job.account_id);
      return { tenantId, accountId: job.account_id, provider: job.provider, generation };
    }).immediate();
  }

  current(claim: SyncClaim, now: number): boolean {
    return this.sqlite.query(`SELECT 1 FROM sync_jobs WHERE tenant_id=? AND account_id=? AND provider=? AND generation=? AND state='running' AND lease_until>?`)
      .get(claim.tenantId, claim.accountId, claim.provider, claim.generation, now) !== null;
  }

  discover(claim: SyncClaim, scopes: readonly SyncScope[], now: number, maxScopes: number): void {
    if (scopes.length > maxScopes) throw new Error("Synchronization scope limit exceeded");
    this.sqlite.transaction(() => {
      this.#requireClaim(claim, now);
      const insert = this.sqlite.query(`INSERT INTO sync_scopes(tenant_id,account_id,scope,cursor,due_at,coverage) VALUES(?,?,?,NULL,?,'partial')
        ON CONFLICT(tenant_id,account_id,scope) DO NOTHING`);
      for (const scope of scopes) insert.run(claim.tenantId, claim.accountId, syncScopeKey(scope), now);
      // Missing scopes are scheduling facts only; provider-confirmed snapshots own removals.
      const keys = new Set(scopes.map(syncScopeKey));
      const existing = this.scopes(claim);
      for (const scope of existing) if (!keys.has(scope.scope)) {
        this.sqlite.query("DELETE FROM sync_scopes WHERE tenant_id=? AND account_id=? AND scope=?").run(claim.tenantId, claim.accountId, scope.scope);
        this.sqlite.query("DELETE FROM sync_scans WHERE tenant_id=? AND account_id=? AND scope=?").run(claim.tenantId, claim.accountId, scope.scope);
      }
    }).immediate();
  }

  scopes(account: Pick<SyncAccount, "tenantId" | "accountId">): ScopeRow[] {
    return this.sqlite.query("SELECT scope,cursor,due_at,coverage FROM sync_scopes WHERE tenant_id=? AND account_id=? ORDER BY due_at,scope")
      .all(account.tenantId, account.accountId) as ScopeRow[];
  }

  commit(claim: SyncClaim, scope: SyncScope, rawPage: SyncPage, now: number, pollMs: number, limit: number): void {
    if (JSON.stringify(rawPage).length > 2 * 1024 * 1024) throw new Error("Synchronization page byte limit exceeded");
    const page = syncPageSchema.parse(rawPage);
    const counts = [page.messages.length, page.removed.length, page.moves.length, page.locationSets.length,
      page.snapshots.length, page.snapshots.reduce((total, snapshot) => total + snapshot.seen.length, 0)];
    if (counts.some(count => count > limit)) throw new Error("Synchronization page item limit exceeded");
    if (page.hasMore && page.cursor === null) throw new Error("Continuing synchronization requires a cursor");
    const scopeKey = syncScopeKey(scope);
    const assertRef = (ref: MessageRef) => {
      if (ref.accountId !== claim.accountId || (scope.kind === "mailbox" && ref.mailbox !== scope.mailbox)) {
        throw new Error("Synchronization reference crossed its account or mailbox scope");
      }
    };
    for (const message of page.messages) assertRef(message.ref);
    for (const ref of page.removed) assertRef(ref);
    for (const move of page.moves) { assertRef(move.previous); assertRef(move.current); }
    if (page.locationSets.length && (claim.provider !== "gmail" || scope.kind !== "account")) throw new Error("Location sets require a Gmail account scope");
    for (const snapshot of page.snapshots) {
      if (scope.kind === "mailbox" && syncScopeKey(snapshot.scope) !== scopeKey) throw new Error("Snapshot crossed its mailbox scope");
      for (const ref of snapshot.seen) {
        assertRef(ref);
        if (snapshot.scope.kind === "mailbox" && ref.mailbox !== snapshot.scope.mailbox) throw new Error("Snapshot reference crossed its mailbox");
      }
    }
    this.sqlite.transaction(() => {
      this.#requireClaim(claim, now);
      const existing = this.sqlite.query("SELECT cursor FROM sync_scopes WHERE tenant_id=? AND account_id=? AND scope=?")
        .get(claim.tenantId, claim.accountId, scopeKey) as { cursor: string | null } | null;
      if (!existing) throw new Error("Synchronization scope no longer exists");
      if (page.hasMore && page.cursor === existing.cursor) throw new Error("Synchronization cursor did not progress");
      for (const parsedMessage of page.messages) {
        const { providerConversationId, canonicalReceivedAt, referenceSequences, ...summary } = parsedMessage;
        const message: ProviderMessageSummary = { ...summary,
          ...(providerConversationId === undefined ? {} : { providerConversationId }),
          ...(canonicalReceivedAt === undefined ? {} : { canonicalReceivedAt }),
          ...(referenceSequences === undefined ? {} : { referenceSequences }) };
        const canonical = this.reconcile({ ...claim, mailbox: message.ref.mailbox,
          observations: [toCanonicalObservation(claim.tenantId, claim.provider, message)], authoritative: false })[0]!;
        this.#index(claim, canonical.id, message, now);
      }
      for (const move of page.moves) this.move(claim.tenantId, claim.provider, move.previous, move.current);
      for (const ref of page.removed) this.#remove(claim, ref);
      for (const set of page.locationSets) {
        this.sqlite.query(`DELETE FROM message_locations WHERE tenant_id=? AND account_id=? AND provider='gmail' AND provider_id=?
          AND mailbox NOT IN (SELECT value FROM json_each(?))`).run(claim.tenantId, claim.accountId, set.providerId, JSON.stringify(set.mailboxes));
      }
      for (const snapshot of page.snapshots) this.#snapshot(claim, snapshot);
      this.sqlite.query(`UPDATE sync_scopes SET cursor=?,due_at=?,coverage=? WHERE tenant_id=? AND account_id=? AND scope=?`)
        .run(page.cursor, page.hasMore ? now : now + pollMs, page.coverage, claim.tenantId, claim.accountId, scopeKey);
    }).immediate();
  }

  finish(claim: SyncClaim, now: number, pollMs: number): void {
    if (!this.current(claim, now)) return;
    const scopes = this.scopes(claim);
    const coverage = scopes.some(s => s.coverage === "catching-up") ? "catching-up"
      : scopes.length > 0 && scopes.every(s => s.coverage === "complete") ? "complete" : "partial";
    const due = Math.min(now + pollMs, ...scopes.map(s => s.due_at));
    this.sqlite.query(`UPDATE sync_jobs SET state='queued',due_at=?,lease_until=NULL,attempts=0,error=NULL,coverage=?,updated_at=?
      WHERE tenant_id=? AND account_id=? AND generation=? AND state='running'`).run(due, coverage, now, claim.tenantId, claim.accountId, claim.generation);
  }

  fail(claim: SyncClaim, now: number, kind: SyncFailureKind, retryMs: number): void {
    this.sqlite.query(`UPDATE sync_jobs SET state='retry',due_at=?,lease_until=NULL,attempts=attempts+1,error=?,updated_at=?
      WHERE tenant_id=? AND account_id=? AND generation=? AND state='running'`).run(now + retryMs, kind, now, claim.tenantId, claim.accountId, claim.generation);
  }

  indexed(tenantId: string, accountId: string, mailbox: string, limit = 100): CanonicalMessageSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid indexed read limit");
    const rows = this.sqlite.query(`SELECT * FROM (
      SELECT i.message_id,i.content,i.received_at,l.uid_validity,l.uid,l.modseq,l.provider_id,l.read,l.flagged,
        ROW_NUMBER() OVER (PARTITION BY i.message_id ORDER BY l.uid DESC,l.uid_validity DESC,l.provider_id DESC,l.id DESC) AS representative
      FROM indexed_messages i JOIN message_locations l ON l.tenant_id=i.tenant_id AND l.account_id=i.account_id AND l.message_id=i.message_id
      WHERE i.tenant_id=? AND i.account_id=? AND l.mailbox=?)
      WHERE representative=1 ORDER BY received_at DESC,message_id DESC LIMIT ?`)
      .all(tenantId, accountId, mailbox, limit) as Array<{ message_id: string; content: string; uid_validity: string; uid: number; modseq: string | null; provider_id: string | null; read: number; flagged: number }>;
    return rows.map(row => {
      const canonical = this.canonical(tenantId, row.message_id);
      if (!canonical) throw new Error("Indexed canonical message missing");
      return { ...indexedContentSchema.parse(JSON.parse(row.content)),
        canonicalId: canonical.id, canonicalAliases: canonical.aliases, conversationId: canonical.conversationId,
        messageId: canonical.messageId ?? "", inReplyTo: canonical.inReplyTo, references: canonical.references,
        ref: { accountId, mailbox, uidValidity: row.uid_validity, uid: row.uid, modseq: row.modseq,
          ...(row.provider_id ? { providerId: row.provider_id } : {}) }, read: row.read === 1, flagged: row.flagged === 1 };
    });
  }

  #requireClaim(claim: SyncClaim, now: number): void { if (!this.current(claim, now)) throw new Error("Synchronization claim expired or was canceled"); }
  #remove(claim: SyncAccount, ref: MessageRef): void {
    this.sqlite.query(`DELETE FROM message_locations WHERE tenant_id=? AND account_id=? AND provider=? AND mailbox=? AND
      ((? IS NOT NULL AND provider_id=?) OR (? IS NULL AND uid_validity=? AND uid=?))`)
      .run(claim.tenantId, claim.accountId, claim.provider, ref.mailbox, ref.providerId ?? null, ref.providerId ?? null,
        ref.providerId ?? null, ref.uidValidity, ref.uid);
  }
  #index(claim: SyncAccount, id: string, message: ProviderMessageSummary, now: number): void {
    const content = indexedContentSchema.parse(message);
    const addresses = (items: typeof content.from) => items.slice(0, 100).map(a => ({ name: a.name.slice(0,256), address: a.address.slice(0,512) }));
    const bounded = { ...content, subject: content.subject.slice(0,2048), preview: content.preview.slice(0,4096),
      from: addresses(content.from), to: addresses(content.to), cc: content.cc ? addresses(content.cc) : undefined,
      replyTo: content.replyTo ? addresses(content.replyTo) : undefined, deliveredTo: content.deliveredTo?.slice(0,100),
      references: content.references?.slice(-100), messageId: content.messageId.slice(0,1024), inReplyTo: content.inReplyTo?.slice(0,2048) };
    const serialized = JSON.stringify(bounded);
    if (serialized.length > 128 * 1024) throw new Error("Indexed summary exceeds content limit");
    this.sqlite.query(`INSERT INTO indexed_messages(tenant_id,account_id,message_id,received_at,content,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(tenant_id,account_id,message_id) DO UPDATE SET received_at=excluded.received_at,content=excluded.content,updated_at=excluded.updated_at`)
      .run(claim.tenantId, claim.accountId, id, message.receivedAt, serialized, now);
  }
  #snapshot(claim: SyncAccount, snapshot: z.infer<typeof syncPageSchema>["snapshots"][number]): void {
    const key = syncScopeKey(snapshot.scope);
    const prior = this.sqlite.query("SELECT generation,completed_generation FROM sync_scans WHERE tenant_id=? AND account_id=? AND scope=?")
      .get(claim.tenantId, claim.accountId, key) as { generation: string; completed_generation: string | null } | null;
    if (prior?.completed_generation === snapshot.generation) throw new Error("Snapshot generation already completed");
    if (snapshot.phase === "start" || snapshot.phase === "start-and-complete") {
      if (prior?.generation !== snapshot.generation) {
        this.sqlite.query("DELETE FROM sync_candidates WHERE tenant_id=? AND account_id=? AND scope=?").run(claim.tenantId, claim.accountId, key);
        this.sqlite.query("DELETE FROM sync_seen WHERE tenant_id=? AND account_id=? AND scope=?").run(claim.tenantId, claim.accountId, key);
        this.sqlite.query(`INSERT INTO sync_scans(tenant_id,account_id,scope,generation) VALUES(?,?,?,?)
          ON CONFLICT(tenant_id,account_id,scope) DO UPDATE SET generation=excluded.generation`).run(claim.tenantId, claim.accountId, key, snapshot.generation);
        this.sqlite.query(`INSERT INTO sync_candidates(tenant_id,account_id,scope,location_id,revision)
          SELECT tenant_id,account_id,?,id,sync_revision FROM message_locations
          WHERE tenant_id=? AND account_id=? AND provider=? AND (? IS NULL OR mailbox=?)`)
          .run(key,claim.tenantId,claim.accountId,claim.provider,
            snapshot.scope.kind === "mailbox" ? snapshot.scope.mailbox : null,
            snapshot.scope.kind === "mailbox" ? snapshot.scope.mailbox : null);
      }
    } else if (prior?.generation !== snapshot.generation) throw new Error("Snapshot generation does not match committed repair");
    for (const ref of snapshot.seen) {
      this.sqlite.query(`INSERT OR IGNORE INTO sync_seen(tenant_id,account_id,scope,location_id)
        SELECT ?,?,?,id FROM message_locations WHERE tenant_id=? AND account_id=? AND provider=? AND mailbox=? AND
        ((? IS NOT NULL AND provider_id=?) OR (? IS NULL AND uid_validity=? AND uid=?))`)
        .run(claim.tenantId, claim.accountId, key, claim.tenantId, claim.accountId, claim.provider, ref.mailbox,
          ref.providerId ?? null, ref.providerId ?? null, ref.providerId ?? null, ref.uidValidity, ref.uid);
    }
    if (snapshot.phase === "complete" || snapshot.phase === "start-and-complete") {
      this.sqlite.query(`DELETE FROM message_locations WHERE tenant_id=? AND account_id=? AND provider=? AND (? IS NULL OR mailbox=?)
        AND EXISTS(SELECT 1 FROM sync_candidates candidate WHERE candidate.tenant_id=message_locations.tenant_id
          AND candidate.account_id=message_locations.account_id AND candidate.location_id=message_locations.id
          AND candidate.revision=message_locations.sync_revision AND candidate.scope=?)
        AND id NOT IN (SELECT location_id FROM sync_seen WHERE tenant_id=? AND account_id=? AND scope=?)`)
        .run(claim.tenantId, claim.accountId, claim.provider, snapshot.scope.kind === "mailbox" ? snapshot.scope.mailbox : null,
          snapshot.scope.kind === "mailbox" ? snapshot.scope.mailbox : null, key, claim.tenantId, claim.accountId, key);
      this.sqlite.query("UPDATE sync_scans SET completed_generation=? WHERE tenant_id=? AND account_id=? AND scope=?")
        .run(snapshot.generation, claim.tenantId, claim.accountId, key);
      this.sqlite.query("DELETE FROM sync_candidates WHERE tenant_id=? AND account_id=? AND scope=?").run(claim.tenantId, claim.accountId, key);
      this.sqlite.query("DELETE FROM sync_seen WHERE tenant_id=? AND account_id=? AND scope=?").run(claim.tenantId, claim.accountId, key);
    }
  }
  #migrate(): void {
    const columns = this.sqlite.query("PRAGMA table_info(message_locations)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "sync_revision")) {
      this.sqlite.exec("ALTER TABLE message_locations ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 0");
    }
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS indexed_messages(tenant_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,received_at TEXT NOT NULL,content TEXT NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,account_id,message_id),FOREIGN KEY(tenant_id,message_id) REFERENCES messages(tenant_id,id));
      CREATE INDEX IF NOT EXISTS indexed_messages_received ON indexed_messages(tenant_id,account_id,received_at,message_id);
      CREATE TABLE IF NOT EXISTS sync_jobs(tenant_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(provider IN ('imap','gmail')),state TEXT NOT NULL CHECK(state IN ('queued','running','retry','canceled')),
        generation TEXT NOT NULL,due_at INTEGER NOT NULL,lease_until INTEGER,attempts INTEGER NOT NULL,error TEXT,
        coverage TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,account_id));
      CREATE TABLE IF NOT EXISTS sync_scopes(tenant_id TEXT NOT NULL,account_id TEXT NOT NULL,scope TEXT NOT NULL,cursor TEXT,due_at INTEGER NOT NULL,coverage TEXT NOT NULL,
        PRIMARY KEY(tenant_id,account_id,scope),FOREIGN KEY(tenant_id,account_id) REFERENCES sync_jobs(tenant_id,account_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS sync_scans(tenant_id TEXT NOT NULL,account_id TEXT NOT NULL,scope TEXT NOT NULL,generation TEXT NOT NULL,
        PRIMARY KEY(tenant_id,account_id,scope),FOREIGN KEY(tenant_id,account_id) REFERENCES sync_jobs(tenant_id,account_id) ON DELETE CASCADE);
      CREATE UNIQUE INDEX IF NOT EXISTS message_locations_sync_ownership ON message_locations(tenant_id,account_id,id);
      CREATE TABLE IF NOT EXISTS sync_candidates(tenant_id TEXT NOT NULL,account_id TEXT NOT NULL,scope TEXT NOT NULL,location_id TEXT NOT NULL,revision INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,account_id,scope,location_id),
        FOREIGN KEY(tenant_id,account_id,location_id) REFERENCES message_locations(tenant_id,account_id,id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id,account_id,scope) REFERENCES sync_scans(tenant_id,account_id,scope) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS sync_seen(tenant_id TEXT NOT NULL,account_id TEXT NOT NULL,scope TEXT NOT NULL,location_id TEXT NOT NULL,
        PRIMARY KEY(tenant_id,account_id,scope,location_id),
        FOREIGN KEY(tenant_id,account_id,location_id) REFERENCES message_locations(tenant_id,account_id,id) ON DELETE CASCADE,
        FOREIGN KEY(tenant_id,account_id,scope) REFERENCES sync_scans(tenant_id,account_id,scope) ON DELETE CASCADE);
    `);
    const scanColumns = this.sqlite.query("PRAGMA table_info(sync_scans)").all() as Array<{ name: string }>;
    if (!scanColumns.some(column => column.name === "completed_generation")) {
      this.sqlite.exec("ALTER TABLE sync_scans ADD COLUMN completed_generation TEXT");
    }
  }
}
