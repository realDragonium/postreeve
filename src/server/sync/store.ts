import { migrateSearchIndex, queryIndex, normalizedQuery, searchFields, type IndexedRow } from "./query";
import { SEARCH_BODY_LIMIT, SEARCH_HEADERS_LIMIT, type MailboxQueryInput, type MailboxCoverage } from "../../shared/mailbox-query";
import { defaultRetentionPolicy, retentionPolicySchema, type RetentionPolicy } from "../../shared/synchronization";
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { messageSummarySchema, type CanonicalMessage, type CanonicalMessageSummary, type MailProviderKind, type MessageRef } from "../../shared/contracts";
import { toCanonicalObservation, type ProviderMessageSummary } from "../mail/provider";
import { syncPageSchema, syncScopeKey, type SyncAccount, type SyncPage, type SyncScope, type SyncFailureKind } from "../mail/synchronization";
import type { MailboxSnapshot } from "../db/store";
import { isInbox, type NewMailArrival } from "../../shared/mailbox-events";

const jobSchema = z.object({
  tenant_id: z.string(), account_id: z.string(), provider: z.enum(["gmail", "imap"]),
  state: z.enum(["queued", "running", "retry", "canceled"]), generation: z.string(),
  due_at: z.number(), lease_until: z.number().nullable(), attempts: z.number(),
  error: z.enum(["provider", "reauthorization", "invalid-data"]).nullable(),
  coverage: z.enum(["partial", "catching-up", "complete"]), updated_at: z.number(),
  error_at: z.number().nullable(), last_success_at: z.number().nullable(), provider_unavailable: z.number().int().min(0).max(1),
});
export type SyncJob = z.infer<typeof jobSchema>;
export interface SyncClaim extends SyncAccount { readonly generation: string }
interface ScopeRow { scope: string; cursor: string | null; due_at: number; coverage: "partial" | "catching-up" | "complete" }
const indexedContentSchema = messageSummarySchema.omit({ ref: true, canonicalId: true, canonicalAliases: true, read: true, flagged: true });

export class SynchronizationStore {
  #retention: RetentionPolicy = defaultRetentionPolicy;

  get retention(): RetentionPolicy { return { ...this.#retention }; }
  configureRetention(policy: RetentionPolicy): void { this.#retention = retentionPolicySchema.parse(policy); }

  constructor(
    readonly sqlite: Database,
    readonly reconcile: (snapshot: MailboxSnapshot) => CanonicalMessage[],
    readonly move: (tenantId: string, provider: MailProviderKind, previous: MessageRef, current: MessageRef) => boolean,
    readonly canonical: (tenantId: string, id: string) => CanonicalMessage | null,
  ) { this.#migrate(); migrateSearchIndex(this.sqlite); }

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
        this.sqlite.query(`UPDATE sync_jobs SET state='queued',generation=?,due_at=?,lease_until=NULL,attempts=0,provider_unavailable=0,coverage='partial',updated_at=?
          WHERE tenant_id=? AND account_id=?`).run(crypto.randomUUID(), now, now, tenantId, accountId);
      }
    }).immediate();
  }

  jobs(tenantId: string): SyncJob[] {
    return z.array(jobSchema).parse(this.sqlite.query("SELECT * FROM sync_jobs WHERE tenant_id=? ORDER BY due_at,account_id").all(tenantId));
  }

  setProviderAvailable(tenantId: string, accountId: string, available: boolean, now: number): void {
    this.sqlite.query(`UPDATE sync_jobs SET provider_unavailable=?,generation=?,lease_until=NULL,
      state=CASE WHEN state='running' THEN 'queued' ELSE state END,due_at=?,updated_at=?
      WHERE tenant_id=? AND account_id=? AND provider_unavailable<>?`)
      .run(available ? 0 : 1, crypto.randomUUID(), now, now, tenantId, accountId, available ? 0 : 1);
  }

  cancel(tenantId: string, accountId: string, now: number): void {
    this.sqlite.query(`UPDATE sync_jobs SET state='canceled',generation=?,lease_until=NULL,updated_at=? WHERE tenant_id=? AND account_id=?`)
      .run(crypto.randomUUID(), now, tenantId, accountId);
  }

  retry(tenantId: string, accountId: string, now: number): void {
    this.sqlite.transaction(() => {
      this.sqlite.query(`UPDATE sync_jobs SET state='queued',generation=?,due_at=?,lease_until=NULL,attempts=0,updated_at=? WHERE tenant_id=? AND account_id=?`)
        .run(crypto.randomUUID(), now, now, tenantId, accountId);
      this.sqlite.query("UPDATE sync_scopes SET due_at=? WHERE tenant_id=? AND account_id=?").run(now, tenantId, accountId);
    }).immediate();
  }

  release(claim: SyncClaim, now: number): void {
    this.sqlite.query(`UPDATE sync_jobs SET state='queued',generation=?,due_at=?,lease_until=NULL,updated_at=?
      WHERE tenant_id=? AND account_id=? AND generation=? AND state='running'`)
      .run(crypto.randomUUID(), now, now, claim.tenantId, claim.accountId, claim.generation);
  }

  claim(tenantId: string, now: number, leaseMs: number): SyncClaim | null {
    return this.sqlite.transaction(() => {
      const row = this.sqlite.query(`SELECT * FROM sync_jobs WHERE tenant_id=? AND provider_unavailable=0 AND
        ((state IN ('queued','retry') AND (state<>'retry' OR error IS NOT 'reauthorization') AND due_at<=?) OR (state='running' AND lease_until<=?)) ORDER BY due_at,account_id LIMIT 1`)
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

  /** Makes a discovered scope and its queued job due now; paused, retrying and canceled jobs keep their schedule. */
  expedite(tenantId: string, accountId: string, scope: SyncScope, now: number): boolean {
    return this.sqlite.transaction(() => {
      const changed = this.sqlite.query("UPDATE sync_scopes SET due_at=MIN(due_at,?) WHERE tenant_id=? AND account_id=? AND scope=?")
        .run(now, tenantId, accountId, syncScopeKey(scope)).changes > 0;
      if (changed) {
        this.sqlite.query(`UPDATE sync_jobs SET due_at=MIN(due_at,?),updated_at=? WHERE tenant_id=? AND account_id=?
          AND state='queued' AND provider_unavailable=0`).run(now, now, tenantId, accountId);
      }
      return changed;
    }).immediate();
  }

  /** Returns the page's new arrivals: unread Inbox messages first indexed after the scope completed a snapshot. */
  commit(claim: SyncClaim, scope: SyncScope, rawPage: SyncPage, now: number, pollMs: number, limit: number): NewMailArrival[] {
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
    return this.sqlite.transaction(() => {
      this.#requireClaim(claim, now);
      const ready = this.sqlite.query("SELECT 1 FROM sync_scans WHERE tenant_id=? AND account_id=? AND scope=? AND completed_generation IS NOT NULL")
        .get(claim.tenantId, claim.accountId, scopeKey) !== null;
      const firstIndexed = new Set<string>();
      const arrivals = new Map<string, NewMailArrival>();
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
        if (ready && !firstIndexed.has(canonical.id) && this.sqlite.query("SELECT 1 FROM indexed_messages WHERE tenant_id=? AND account_id=? AND message_id=?")
          .get(claim.tenantId, claim.accountId, canonical.id) === null) firstIndexed.add(canonical.id);
        if (firstIndexed.has(canonical.id) && !message.read && isInbox(message.ref.mailbox) && !arrivals.has(canonical.id)) {
          const sender = message.from[0];
          arrivals.set(canonical.id, { canonicalId: canonical.id, mailbox: message.ref.mailbox,
            sender: sender ? sender.name || sender.address : "", subject: message.subject, receivedAt: message.receivedAt });
        }
        this.#index(claim, canonical.id, message, now);
      }
      this.enforceRetention(claim.tenantId, claim.accountId, now);
      for (const move of page.moves) this.move(claim.tenantId, claim.provider, move.previous, move.current);
      for (const ref of page.removed) this.#remove(claim, ref);
      for (const set of page.locationSets) {
        this.sqlite.query(`DELETE FROM message_locations WHERE tenant_id=? AND account_id=? AND provider='gmail' AND provider_id=?
          AND mailbox NOT IN (SELECT value FROM json_each(?))`).run(claim.tenantId, claim.accountId, set.providerId, JSON.stringify(set.mailboxes));
      }
      for (const snapshot of page.snapshots) this.#snapshot(claim, snapshot);
      this.sqlite.query(`UPDATE sync_scopes SET cursor=?,due_at=?,coverage=? WHERE tenant_id=? AND account_id=? AND scope=?`)
        .run(page.cursor, page.hasMore ? now : now + pollMs, page.coverage, claim.tenantId, claim.accountId, scopeKey);
      return [...arrivals.values()];
    }).immediate();
  }

  finish(claim: SyncClaim, now: number, pollMs: number, madeProgress = true): void {
    if (!this.current(claim, now)) return;
    const scopes = this.scopes(claim);
    const coverage = scopes.some(s => s.coverage === "catching-up") ? "catching-up"
      : scopes.length > 0 && scopes.every(s => s.coverage === "complete") ? "complete" : "partial";
    const due = Math.min(now + pollMs, ...scopes.map(s => s.due_at));
    this.sqlite.query(`UPDATE sync_jobs SET state='queued',due_at=?,lease_until=NULL,attempts=CASE WHEN ? THEN 0 ELSE attempts END,error=CASE WHEN ? THEN NULL ELSE error END,
      error_at=CASE WHEN ? THEN NULL ELSE error_at END,last_success_at=CASE WHEN ? THEN ? ELSE last_success_at END,coverage=?,updated_at=?
      WHERE tenant_id=? AND account_id=? AND generation=? AND state='running'`).run(due, madeProgress, madeProgress, madeProgress, madeProgress, now, coverage, now, claim.tenantId, claim.accountId, claim.generation);
  }

  fail(claim: SyncClaim, now: number, kind: SyncFailureKind, retryMs: number): void {
    this.sqlite.query(`UPDATE sync_jobs SET state='retry',due_at=?,lease_until=NULL,attempts=MIN(attempts+1,1000000),error=?,error_at=?,updated_at=?
      WHERE tenant_id=? AND account_id=? AND generation=? AND state='running'`).run(now + retryMs, kind, now, now, claim.tenantId, claim.accountId, claim.generation);
  }

  retainedContentBytes(tenantId: string, accountId: string): number {
    const row = this.sqlite.query("SELECT retained_content_bytes AS bytes FROM sync_jobs WHERE tenant_id=? AND account_id=?")
      .get(tenantId, accountId) as { bytes: number } | null;
    return row?.bytes ?? 0;
  }

  enforceRetention(tenantId: string, accountId: string, now: number): void {
    this.sqlite.transaction(() => {
      this.sqlite.query(`UPDATE indexed_messages SET content=json_set(content,'$.searchBody',NULL,'$.searchBodyAt',NULL)
        WHERE tenant_id=? AND account_id=? AND json_type(content,'$.searchBody')='text'
          AND COALESCE(json_extract(content,'$.searchBodyAt'),updated_at)<=?`)
        .run(tenantId, accountId, now - this.#retention.maxAgeDays * 86_400_000);
      this.sqlite.query(`UPDATE indexed_messages SET content=json_set(content,'$.preview','','$.searchPreview','','$.searchBody',NULL)
        WHERE tenant_id=? AND account_id=? AND updated_at<=? AND (json_extract(content,'$.preview')<>'' OR json_type(content,'$.searchBody')='text')`)
        .run(tenantId, accountId, now - this.#retention.maxAgeDays * 86_400_000);
      let excess = this.retainedContentBytes(tenantId, accountId) - this.#retention.maxContentBytes;
      while (excess > 0) {
        const oldest = this.sqlite.query(`SELECT message_id,(length(CAST(json_extract(content,'$.preview') AS BLOB))+COALESCE(length(CAST(json_extract(content,'$.searchBody') AS BLOB)),0)) AS bytes
          FROM indexed_messages WHERE tenant_id=? AND account_id=? AND (json_extract(content,'$.preview')<>'' OR json_type(content,'$.searchBody')='text')
          ORDER BY updated_at,message_id LIMIT 100`).all(tenantId, accountId) as Array<{ message_id: string; bytes: number }>;
        if (!oldest.length) throw new Error("Indexed content accounting is inconsistent");
        const expired: string[] = [];
        for (const row of oldest) {
          expired.push(row.message_id);
          excess -= row.bytes;
          if (excess <= 0) break;
        }
        this.sqlite.query(`UPDATE indexed_messages SET content=json_set(content,'$.preview','','$.searchPreview','','$.searchBody',NULL)
          WHERE tenant_id=? AND account_id=? AND message_id IN (SELECT value FROM json_each(?))`)
          .run(tenantId, accountId, JSON.stringify(expired));
      }
    }).immediate();
  }

  query(tenantId: string, input: MailboxQueryInput, fallbackIds: readonly string[] = []): { messages: CanonicalMessageSummary[]; nextCursor: string | null } {
    const result = queryIndex(this.sqlite, tenantId, normalizedQuery(input), fallbackIds);
    return { messages: result.rows.map(row => this.#summary(tenantId, row)), nextCursor: result.nextCursor };
  }

  coverage(tenantId: string, sources: MailboxQueryInput["sources"]): MailboxCoverage {
    const coverage = sources.map(source => {
      const scopes = this.scopes({ tenantId, accountId: source.accountId });
      const synchronized = scopes.some(scope => scope.coverage === "complete"
        && (scope.scope === syncScopeKey({ kind: "account" }) || scope.scope === syncScopeKey({ kind: "mailbox", mailbox: source.mailbox })));
      const row = this.sqlite.query(`SELECT COUNT(DISTINCT i.message_id) total,
        COUNT(DISTINCT CASE WHEN json_type(i.content,'$.searchBody')='text' THEN i.message_id END) bodies
        FROM indexed_messages i JOIN message_locations l ON l.tenant_id=i.tenant_id AND l.account_id=i.account_id AND l.message_id=i.message_id
        WHERE i.tenant_id=? AND l.account_id=? AND l.mailbox=?`).get(tenantId,source.accountId,source.mailbox) as { total: number; bodies: number };
      return { ...source, synchronized, indexedMessages: row.total, bodiesAvailable: row.bodies, fallback: "not-requested" as const };
    });
    return { sources: coverage, complete: coverage.every(source => source.synchronized && source.bodiesAvailable === source.indexedMessages), bodyTextLimit: SEARCH_BODY_LIMIT };
  }

  observe(account: SyncAccount, messages: readonly ProviderMessageSummary[], now: number): string[] {
    return this.sqlite.transaction(() => {
      const ids: string[] = [];
      for (const message of messages) {
        if (message.ref.accountId !== account.accountId) throw new Error("Indexed observation crossed account scope");
        const canonical = this.reconcile({ ...account, mailbox: message.ref.mailbox,
          observations: [toCanonicalObservation(account.tenantId, account.provider, message)], authoritative: false })[0]!;
        this.#index(account, canonical.id, message, now);
        ids.push(canonical.id);
      }
      this.enforceRetention(account.tenantId, account.accountId, now);
      return ids;
    }).immediate();
  }

  confirmedAction(account: SyncAccount, previous: MessageRef, current: MessageRef, read?: boolean): void {
    if (previous.accountId !== account.accountId || current.accountId !== account.accountId) throw new Error("Action crossed account scope");
    this.sqlite.transaction(() => {
      const row = this.sqlite.query(`SELECT l.message_id,i.content,l.read,l.flagged FROM message_locations l
        JOIN indexed_messages i ON i.tenant_id=l.tenant_id AND i.account_id=l.account_id AND i.message_id=l.message_id
        WHERE l.tenant_id=? AND l.account_id=? AND l.mailbox=? AND
        ((? IS NOT NULL AND l.provider_id=?) OR (? IS NULL AND l.uid_validity=? AND l.uid=?)) LIMIT 1`)
        .get(account.tenantId,account.accountId,previous.mailbox,previous.providerId ?? null,previous.providerId ?? null,
          previous.providerId ?? null,previous.uidValidity,previous.uid) as { message_id: string; content: string; read: number; flagged: number } | null;
      if (!row) return;
      const summary = indexedContentSchema.parse(JSON.parse(row.content));
      this.reconcile({ ...account, mailbox: current.mailbox, authoritative: false,
        observations: [toCanonicalObservation(account.tenantId, account.provider,
          { ...summary, ref: current, read: read ?? row.read === 1, flagged: row.flagged === 1 })] });
      if (account.provider === "gmail" && current.providerId && read !== undefined) {
        this.sqlite.query(`UPDATE message_locations SET read=?,sync_revision=sync_revision+1
          WHERE tenant_id=? AND account_id=? AND provider='gmail' AND provider_id=?`)
          .run(read, account.tenantId, account.accountId, current.providerId);
      }
      if (previous.mailbox !== current.mailbox || previous.uidValidity !== current.uidValidity || previous.uid !== current.uid) this.#remove(account, previous);
    }).immediate();
  }

  indexed(tenantId: string, accountId: string, mailbox: string, limit = 100): CanonicalMessageSummary[] {
    return this.query(tenantId, { sources: [{ accountId, mailbox }], limit }).messages;
  }

  #summary(tenantId: string, row: IndexedRow): CanonicalMessageSummary {
    const canonical = this.canonical(tenantId, row.message_id);
    if (!canonical) throw new Error("Indexed canonical message missing");
    return { ...indexedContentSchema.parse(JSON.parse(row.content)),
      canonicalId: canonical.id, canonicalAliases: canonical.aliases, conversationId: canonical.conversationId,
      messageId: canonical.messageId ?? "", inReplyTo: canonical.inReplyTo, references: canonical.references,
      ref: { accountId: row.account_id, mailbox: row.mailbox, uidValidity: row.uid_validity, uid: row.uid, modseq: row.modseq,
        ...(row.provider_id ? { providerId: row.provider_id } : {}) }, read: row.read === 1, flagged: row.flagged === 1 };
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
    const retained = this.sqlite.query("SELECT content FROM indexed_messages WHERE tenant_id=? AND account_id=? AND message_id=?")
      .get(claim.tenantId, claim.accountId, id) as { content: string } | null;
    const prior = retained ? z.object({ searchBody: z.string().nullable().optional(), searchBodyAt: z.number().nullable().optional(), searchHeaders: z.string().optional(),
      sortReceivedAt: z.string().optional(), sortSender: z.string().optional(), sortSubject: z.string().optional() }).parse(JSON.parse(retained.content)) : null;
    const bounded = { ...content,
      searchBodyAt: message.searchBody == null ? prior?.searchBodyAt ?? null : now,
      searchBody: message.searchBody == null ? prior?.searchBody ?? null : message.searchBody.toLowerCase().slice(0, SEARCH_BODY_LIMIT),
      searchHeaders: (message.searchHeaders ?? prior?.searchHeaders ?? [content.messageId, content.inReplyTo ?? "", ...(content.references ?? [])].join("\n")).toLowerCase().slice(0, SEARCH_HEADERS_LIMIT), subject: content.subject.slice(0,2048), preview: content.preview.slice(0,4096),
      from: addresses(content.from), to: addresses(content.to), cc: content.cc ? addresses(content.cc) : undefined,
      replyTo: content.replyTo ? addresses(content.replyTo) : undefined, deliveredTo: content.deliveredTo?.slice(0,100),
      references: content.references?.slice(-100), messageId: content.messageId.slice(0,1024), inReplyTo: content.inReplyTo?.slice(0,2048) };
    const searchable = searchFields(bounded);
    const serialized = JSON.stringify({ ...bounded, ...searchable,
      sortReceivedAt: prior?.sortReceivedAt ?? bounded.receivedAt,
      sortSender: prior?.sortSender ?? searchable.searchSenderSort,
      sortSubject: prior?.sortSubject ?? searchable.searchSubject });
    if (serialized.length > 256 * 1024) throw new Error("Indexed summary exceeds content limit");
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
    const jobColumns = this.sqlite.query("PRAGMA table_info(sync_jobs)").all() as Array<{ name: string }>;
    if (!jobColumns.some(column => column.name === "provider_unavailable")) {
      this.sqlite.exec("ALTER TABLE sync_jobs ADD COLUMN provider_unavailable INTEGER NOT NULL DEFAULT 0 CHECK(provider_unavailable IN (0,1))");
    }
    for (const column of ["error_at", "last_success_at"]) {
      if (!jobColumns.some(existing => existing.name === column)) this.sqlite.exec(`ALTER TABLE sync_jobs ADD COLUMN ${column} INTEGER`);
    }
    this.sqlite.exec("UPDATE sync_jobs SET error_at=updated_at WHERE error IS NOT NULL AND error_at IS NULL");
    if (!jobColumns.some(column => column.name === "retained_content_bytes")) {
      this.sqlite.exec(`ALTER TABLE sync_jobs ADD COLUMN retained_content_bytes INTEGER NOT NULL DEFAULT 0;
        UPDATE sync_jobs SET retained_content_bytes=(SELECT COALESCE(SUM((length(CAST(json_extract(content,'$.preview') AS BLOB))+COALESCE(length(CAST(json_extract(content,'$.searchBody') AS BLOB)),0))),0)
          FROM indexed_messages WHERE tenant_id=sync_jobs.tenant_id AND account_id=sync_jobs.account_id);`);
    }
    this.sqlite.exec(`
      DROP INDEX IF EXISTS indexed_previews_age;
      CREATE INDEX indexed_previews_age ON indexed_messages(tenant_id,account_id,updated_at,message_id)
        WHERE (json_extract(content,'$.preview')<>'' OR json_type(content,'$.searchBody')='text');
      CREATE INDEX IF NOT EXISTS indexed_bodies_age ON indexed_messages(
        tenant_id,account_id,COALESCE(json_extract(content,'$.searchBodyAt'),updated_at))
        WHERE json_type(content,'$.searchBody')='text';
      DROP TRIGGER IF EXISTS indexed_preview_insert;
      DROP TRIGGER IF EXISTS indexed_preview_update;
      DROP TRIGGER IF EXISTS indexed_preview_delete;
      CREATE TRIGGER indexed_preview_insert AFTER INSERT ON indexed_messages BEGIN
        UPDATE sync_jobs SET retained_content_bytes=retained_content_bytes+(length(CAST(json_extract(NEW.content,'$.preview') AS BLOB))+COALESCE(length(CAST(json_extract(NEW.content,'$.searchBody') AS BLOB)),0))
          WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id;
      END;
      CREATE TRIGGER IF NOT EXISTS indexed_preview_update AFTER UPDATE OF content ON indexed_messages BEGIN
        UPDATE sync_jobs SET retained_content_bytes=retained_content_bytes
          +(length(CAST(json_extract(NEW.content,'$.preview') AS BLOB))+COALESCE(length(CAST(json_extract(NEW.content,'$.searchBody') AS BLOB)),0))-(length(CAST(json_extract(OLD.content,'$.preview') AS BLOB))+COALESCE(length(CAST(json_extract(OLD.content,'$.searchBody') AS BLOB)),0))
          WHERE tenant_id=NEW.tenant_id AND account_id=NEW.account_id;
      END;
      CREATE TRIGGER IF NOT EXISTS indexed_preview_delete AFTER DELETE ON indexed_messages BEGIN
        UPDATE sync_jobs SET retained_content_bytes=retained_content_bytes-(length(CAST(json_extract(OLD.content,'$.preview') AS BLOB))+COALESCE(length(CAST(json_extract(OLD.content,'$.searchBody') AS BLOB)),0))
          WHERE tenant_id=OLD.tenant_id AND account_id=OLD.account_id;
      END;
    `);
    const scanColumns = this.sqlite.query("PRAGMA table_info(sync_scans)").all() as Array<{ name: string }>;
    if (!scanColumns.some(column => column.name === "completed_generation")) {
      this.sqlite.exec("ALTER TABLE sync_scans ADD COLUMN completed_generation TEXT");
    }
  }
}
