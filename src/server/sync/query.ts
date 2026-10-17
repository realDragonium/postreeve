import { createHash } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { messageSummarySchema, type MessageSummary } from "../../shared/contracts";
import { accountMatches, folderMatches, mailboxQuerySchema, parseMailboxQuery, type MailboxQuery, type MailboxQueryInput,
  type MailboxSource, type ParsedMailboxQuery, type SearchTerm } from "../../shared/mailbox-query";

export function searchFields(content: Pick<MessageSummary, "from" | "to" | "cc" | "replyTo" | "deliveredTo" | "subject" | "preview">) {
  return {
    searchSender: content.from.flatMap(a => [a.name, a.address]).join("\n").toLowerCase(),
    searchRecipients: [...content.to, ...(content.cc ?? []), ...(content.replyTo ?? [])].flatMap(a => [a.name,a.address])
      .concat(content.deliveredTo ?? []).join("\n").toLowerCase(),
    searchSenderSort: (content.from[0]?.name || content.from[0]?.address || "Unknown sender").toLowerCase(),
    searchSubject: content.subject.toLowerCase(), searchPreview: content.preview.toLowerCase(),
  };
}

const cursorSchema = z.object({ version: z.literal(1), scope: z.string(), value: z.string(), id: z.string(), fallbackIds: z.array(z.string()).max(1000).default([]) }).strict();
export interface IndexedRow {
  message_id: string; content: string; received_at: string; account_id: string; mailbox: string;
  uid_validity: string; uid: number; modseq: string | null; provider_id: string | null; read: number; flagged: number;
  sort_value: string;
}
export function normalizedQuery(raw: MailboxQueryInput): MailboxQuery {
  const parsed = mailboxQuerySchema.parse(raw);
  const sources = [...new Map(parsed.sources.map(source => [JSON.stringify(source), source])).values()]
    .sort((a, b) => a.accountId.localeCompare(b.accountId) || a.mailbox.localeCompare(b.mailbox));
  return { ...parsed, sources, query: parsed.query.toLowerCase() };
}
function scopeKey(tenant: string, query: MailboxQuery): string {
  return createHash("sha256").update(JSON.stringify([tenant, query.sources, query.scope, query.query, query.filter, query.sort, query.group])).digest("hex");
}
export function readCursor(tenant: string, query: MailboxQuery): z.infer<typeof cursorSchema> | null {
  if (!query.cursor) return null;
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    if (cursor.scope !== scopeKey(tenant, query)) throw new Error();
    return cursor;
  } catch { throw new Error("Invalid cursor for this mailbox query"); }
}

/** Above this many candidates a page walks the sort index instead of sorting every candidate. */
export const CANDIDATE_SORT_LIMIT = 4000;
const sortColumns = { newest: "received_at", oldest: "received_at", sender: "sender", subject: "subject" } as const;
const sortIndexes = { received_at: "indexed_sort_keys_received", sender: "indexed_sort_keys_sender", subject: "indexed_sort_keys_subject" } as const;
const searchColumns = ["sender", "recipients", "subject", "headers", "preview", "body"] as const;
const ftsColumns: Record<SearchTerm["field"], string> = { any: "", from: "sender", to: "recipients", cc: "recipients", subject: "subject" };
const sourceKey = (source: MailboxSource) => `${source.accountId}\u001f${source.mailbox}`;

interface Fragment { sql: string; params: SQLQueryBindings[] }
/** A query with its operators parsed and its sources resolved; `sources: null` means every indexed location. */
export interface QueryPlan {
  readonly tenant: string;
  readonly query: MailboxQuery;
  readonly parsed: ParsedMailboxQuery;
  readonly sources: readonly MailboxSource[] | null;
  readonly fallbackIds: readonly string[];
}

/**
 * Resolves the sources a query reads: the listed sources, or every indexed location for the everywhere scope and
 * `in:anywhere`, narrowed by `in:` and `account:` operators.
 */
export function resolveSources(sqlite: Database, tenant: string, query: MailboxQuery, parsed = parseMailboxQuery(query.query)): MailboxSource[] | null {
  const everywhere = query.scope === "everywhere" || parsed.anywhere;
  if (!parsed.folders.length && !parsed.accounts.length) return everywhere ? null : [...query.sources];
  const accounts = new Map((sqlite.query("SELECT id,email,name FROM accounts").all() as Array<{ id: string; email: string; name: string }>)
    .map(account => [account.id, account]));
  const candidates = everywhere ? indexedSources(sqlite, tenant) : query.sources;
  return candidates.filter(source => {
    const account = accounts.get(source.accountId);
    const folderOk = parsed.folders.every(({ value, negated }) => folderMatches(value, source.mailbox) !== negated);
    const accountOk = parsed.accounts.every(({ value, negated }) => (account !== undefined && accountMatches(value, account)) !== negated);
    return folderOk && accountOk;
  });
}

/** Every account/mailbox pair holding indexed messages. */
export function indexedSources(sqlite: Database, tenant: string): MailboxSource[] {
  return sqlite.query(`SELECT c.account_id accountId,c.mailbox FROM indexed_source_counts c JOIN accounts a ON a.id=c.account_id
    WHERE c.tenant_id=? AND c.total>0 ORDER BY 1,2`).all(tenant) as MailboxSource[];
}

function textCondition(term: SearchTerm): Fragment {
  if (term.field === "cc") {
    return { sql: `EXISTS(SELECT 1 FROM json_each(i.content,'$.cc') cc WHERE instr(lower(COALESCE(json_extract(cc.value,'$.name'),'')||char(10)||COALESCE(json_extract(cc.value,'$.address'),'')),?)>0)`,
      params: [term.value] };
  }
  if (term.field === "any") return { sql: `(${searchColumns.map(column => `instr(f.${column},?)>0`).join(" OR ")})`, params: searchColumns.map(() => term.value) };
  return { sql: `instr(f.${ftsColumns[term.field]},?)>0`, params: [term.value] };
}

/** Conditions on one location `l`, its indexed row `i` and that row's search text `f`. */
function locationConditions(plan: QueryPlan): Fragment & { search: boolean } {
  const { parsed, query } = plan;
  const sql: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (plan.sources) { sql.push("l.account_id||char(31)||l.mailbox IN (SELECT value FROM json_each(?))"); params.push(JSON.stringify(plan.sources.map(sourceKey))); }
  if (query.filter === "unread") sql.push("l.read=0");
  if (query.filter === "flagged") sql.push("l.flagged=1");
  if (parsed.unread !== undefined) sql.push(parsed.unread ? "l.read=0" : "l.read=1");
  if (parsed.flagged !== undefined) sql.push(parsed.flagged ? "l.flagged=1" : "l.flagged=0");
  const free = parsed.terms.filter(term => term.field === "any" && !term.negated);
  if (free.length) {
    const conditions = free.map(textCondition);
    let combined = conditions.map(condition => condition.sql).join(" AND ");
    params.push(...conditions.flatMap(condition => condition.params));
    // Provider fallback matches stand in for the free text they were searched with; other operators still apply.
    if (plan.fallbackIds.length) { combined = `(${combined}) OR l.message_id IN (SELECT value FROM json_each(?))`; params.push(JSON.stringify(plan.fallbackIds)); }
    sql.push(`(${combined})`);
  }
  for (const term of parsed.terms) {
    if (term.field === "any" && !term.negated) continue;
    const condition = textCondition(term);
    sql.push(term.negated ? `NOT ${condition.sql}` : condition.sql);
    params.push(...condition.params);
  }
  if (parsed.attachment !== undefined) sql.push(`${parsed.attachment ? "" : "NOT "}instr(f.headers,'content-type: multipart/mixed')>0`);
  return { sql: sql.length ? sql.join(" AND ") : "1", params, search: parsed.terms.length > 0 || parsed.attachment !== undefined };
}

function locationJoin(search: boolean): string {
  return `message_locations l JOIN indexed_messages i ON i.tenant_id=l.tenant_id AND i.account_id=l.account_id AND i.message_id=l.message_id
    ${search ? "JOIN indexed_search f ON f.rowid=i.rowid" : ""}`;
}

/** Whether sort key row `alias` belongs to the view: a matching location in the sources and the date operators. */
function messagePredicate(plan: QueryPlan, alias: string): Fragment {
  const location = locationConditions(plan);
  const sql = [`EXISTS(SELECT 1 FROM ${locationJoin(location.search)} WHERE l.message_id=${alias}.message_id AND l.tenant_id=? AND ${location.sql})`];
  const params: SQLQueryBindings[] = [plan.tenant, ...location.params];
  if (plan.parsed.after) { sql.push(`${alias}.received_at>=?`); params.push(plan.parsed.after); }
  if (plan.parsed.before) { sql.push(`${alias}.received_at<?`); params.push(plan.parsed.before); }
  return { sql: sql.join(" AND "), params };
}

function ftsExpression(parsed: ParsedMailboxQuery): string | null {
  // The trigram tokenizer only indexes runs of three or more characters; shorter terms are checked row by row.
  const terms = parsed.terms.filter(term => !term.negated && [...term.value].length >= 3);
  if (!terms.length) return null;
  return terms.map(term => `${ftsColumns[term.field] ? `${ftsColumns[term.field]} : ` : ""}"${term.value.replaceAll("\"", "\"\"")}"`).join(" AND ");
}

/**
 * Chooses the smallest candidate set that can drive a page: full-text matches, locations in the sources, or none.
 * Without a small enough set the page walks the sort index and stops after `limit + 1` matching messages.
 */
function candidates(sqlite: Database, plan: QueryPlan, limit: number): Fragment | null {
  const options: Array<{ size: number; fragment: Fragment }> = [];
  const expression = ftsExpression(plan.parsed);
  // Fallback matches bypass free text, so full-text matches alone cannot drive a page that has them.
  if (expression && !plan.fallbackIds.length) {
    const { size } = sqlite.query("SELECT COUNT(*) size FROM (SELECT 1 FROM indexed_search WHERE indexed_search MATCH ? LIMIT ?)")
      .get(expression, limit + 1) as { size: number };
    options.push({ size, fragment: { sql: `SELECT DISTINCT i.message_id FROM indexed_search f JOIN indexed_messages i ON i.rowid=f.rowid
      WHERE indexed_search MATCH ? AND i.tenant_id=?`, params: [expression, plan.tenant] } });
  }
  if (plan.sources) {
    const flags = [plan.query.filter === "unread" || plan.parsed.unread === true ? "l.read=0" : "", plan.parsed.unread === false ? "l.read=1" : "",
      plan.query.filter === "flagged" || plan.parsed.flagged === true ? "l.flagged=1" : "", plan.parsed.flagged === false ? "l.flagged=0" : ""]
      .filter(Boolean).map(flag => ` AND ${flag}`).join("");
    // CROSS JOIN keeps the sources outermost so each one seeks its mailbox in the location index.
    const from = `FROM json_each(?) s CROSS JOIN accounts a ON a.id=json_extract(s.value,'$.accountId')
      CROSS JOIN message_locations l ON l.tenant_id=? AND l.account_id=a.id AND l.provider=a.kind AND l.mailbox=json_extract(s.value,'$.mailbox') WHERE 1${flags}`;
    const params = [JSON.stringify(plan.sources), plan.tenant];
    const { size } = sqlite.query(`SELECT COUNT(*) size FROM (SELECT 1 ${from} LIMIT ?)`).get(...params, limit + 1) as { size: number };
    options.push({ size, fragment: { sql: `SELECT DISTINCT l.message_id ${from}`, params } });
  }
  const best = options.sort((a, b) => a.size - b.size)[0];
  return best && best.size <= limit ? best.fragment : null;
}

/** One representative location row per message, chosen among the locations that match the view. */
export function representatives(sqlite: Database, plan: QueryPlan, ids: readonly string[]): Map<string, IndexedRow> {
  if (!ids.length) return new Map();
  const location = locationConditions(plan);
  const rows = sqlite.query(`SELECT * FROM (
      SELECT i.message_id,i.content,i.received_at,l.account_id,l.mailbox,l.uid_validity,l.uid,l.modseq,l.provider_id,l.read,l.flagged,'' sort_value,
        ROW_NUMBER() OVER (PARTITION BY l.message_id ORDER BY l.account_id,l.mailbox,l.uid DESC,l.uid_validity DESC,l.id DESC) representative
      FROM ${locationJoin(location.search)}
      WHERE l.message_id IN (SELECT value FROM json_each(?)) AND l.tenant_id=? AND ${location.sql})
    WHERE representative=1`).all(JSON.stringify(ids), plan.tenant, ...location.params) as IndexedRow[];
  return new Map(rows.map(row => [row.message_id, row]));
}

/** Messages of the conversation of `messageId` that belong to the view, newest first. */
export function conversationMembers(sqlite: Database, plan: QueryPlan, messageId: string): string[] {
  const predicate = messagePredicate(plan, "k");
  return (sqlite.query(`SELECT k.message_id FROM conversation_messages c
      JOIN conversation_messages c2 ON c2.tenant_id=c.tenant_id AND c2.conversation_id=c.conversation_id
      JOIN indexed_sort_keys k ON k.tenant_id=c2.tenant_id AND k.message_id=c2.message_id
      WHERE c.tenant_id=? AND c.message_id=? AND ${predicate.sql}
      ORDER BY k.received_at DESC,k.message_id DESC`).all(plan.tenant, messageId, ...predicate.params) as Array<{ message_id: string }>)
    .map(row => row.message_id);
}

export function queryIndex(sqlite: Database, plan: QueryPlan, candidateLimit = CANDIDATE_SORT_LIMIT): { rows: IndexedRow[]; nextCursor: string | null } {
  const { query, tenant } = plan;
  if (plan.sources?.length === 0 || plan.parsed.errors.length) return { rows: [], nextCursor: null };
  const cursor = readCursor(tenant, query);
  const column = sortColumns[query.sort];
  const direction = query.sort === "newest" ? "DESC" : "ASC";
  const comparison = query.sort === "newest" ? "<" : ">";
  const predicate = messagePredicate(plan, "k");
  const where = [predicate.sql];
  const params: SQLQueryBindings[] = [...predicate.params];
  if (cursor) { where.push(`(k.${column},k.message_id)${comparison}(?,?)`); params.push(cursor.value, cursor.id); }
  if (query.group === "conversation") {
    // A conversation is shown once, at its first message in the view's order.
    const member = messagePredicate(plan, "k2");
    where.push(`NOT EXISTS(SELECT 1 FROM conversation_messages c
      JOIN conversation_messages c2 ON c2.tenant_id=c.tenant_id AND c2.conversation_id=c.conversation_id AND c2.message_id<>c.message_id
      JOIN indexed_sort_keys k2 ON k2.tenant_id=c2.tenant_id AND k2.message_id=c2.message_id
      WHERE c.tenant_id=k.tenant_id AND c.message_id=k.message_id AND (k2.${column},k2.message_id)${comparison === "<" ? ">" : "<"}(k.${column},k.message_id)
        AND ${member.sql})`);
    params.push(...member.params);
  }
  const driver = candidates(sqlite, plan, candidateLimit);
  const order = `ORDER BY k.${column} ${direction},k.message_id ${direction} LIMIT ?`;
  const selected = driver
    ? sqlite.query(`WITH candidates(message_id) AS MATERIALIZED (${driver.sql})
        SELECT k.message_id,k.${column} sort_value FROM candidates CROSS JOIN indexed_sort_keys k ON k.tenant_id=? AND k.message_id=candidates.message_id
        WHERE ${where.join(" AND ")} ${order}`).all(...driver.params, tenant, ...params, query.limit + 1)
    : sqlite.query(`SELECT k.message_id,k.${column} sort_value FROM indexed_sort_keys k INDEXED BY ${sortIndexes[column]}
        WHERE k.tenant_id=? AND ${where.join(" AND ")} ${order}`).all(tenant, ...params, query.limit + 1);
  const keys = selected as Array<{ message_id: string; sort_value: string }>;
  const page = keys.slice(0, query.limit);
  const rows = representatives(sqlite, plan, page.map(key => key.message_id));
  const last = page.at(-1);
  return {
    rows: page.flatMap(key => { const row = rows.get(key.message_id); return row ? [{ ...row, sort_value: key.sort_value }] : []; }),
    nextCursor: keys.length > query.limit && last ? Buffer.from(JSON.stringify({ version: 1,
      scope: scopeKey(tenant, query), fallbackIds: plan.fallbackIds, value: last.sort_value, id: last.message_id })).toString("base64url") : null,
  };
}

/**
 * Promotes each canonical message's sort anchors (first indexed received time, sender and subject) to an indexed
 * table so pages can walk them in order. Triggers keep it in step with the first indexed row of every message.
 */
export function migrateSortKeys(sqlite: Database): void {
  const anchor = (row: string) => `COALESCE(json_extract(${row}.content,'$.sortReceivedAt'),''),
    COALESCE(json_extract(${row}.content,'$.sortSender'),''),COALESCE(json_extract(${row}.content,'$.sortSubject'),'')`;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS indexed_sort_keys(tenant_id TEXT NOT NULL,message_id TEXT NOT NULL,
      received_at TEXT NOT NULL,sender TEXT NOT NULL,subject TEXT NOT NULL,PRIMARY KEY(tenant_id,message_id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS indexed_sort_keys_received ON indexed_sort_keys(tenant_id,received_at,message_id);
    CREATE INDEX IF NOT EXISTS indexed_sort_keys_sender ON indexed_sort_keys(tenant_id,sender,message_id);
    CREATE INDEX IF NOT EXISTS indexed_sort_keys_subject ON indexed_sort_keys(tenant_id,subject,message_id);
    CREATE TRIGGER IF NOT EXISTS indexed_sort_keys_insert AFTER INSERT ON indexed_messages BEGIN
      INSERT OR IGNORE INTO indexed_sort_keys(tenant_id,message_id,received_at,sender,subject) VALUES(NEW.tenant_id,NEW.message_id,${anchor("NEW")}); END;
    CREATE TRIGGER IF NOT EXISTS indexed_sort_keys_update AFTER UPDATE OF content ON indexed_messages
      WHEN NEW.rowid=(SELECT MIN(rowid) FROM indexed_messages WHERE tenant_id=NEW.tenant_id AND message_id=NEW.message_id) BEGIN
      UPDATE indexed_sort_keys SET (received_at,sender,subject)=(SELECT ${anchor("NEW")})
        WHERE tenant_id=NEW.tenant_id AND message_id=NEW.message_id; END;
    CREATE TRIGGER IF NOT EXISTS indexed_sort_keys_delete AFTER DELETE ON indexed_messages BEGIN
      DELETE FROM indexed_sort_keys WHERE tenant_id=OLD.tenant_id AND message_id=OLD.message_id;
      INSERT OR IGNORE INTO indexed_sort_keys(tenant_id,message_id,received_at,sender,subject)
        SELECT tenant_id,message_id,${anchor("first")} FROM indexed_messages first
        WHERE tenant_id=OLD.tenant_id AND message_id=OLD.message_id ORDER BY rowid LIMIT 1; END;`);
  migrateSourceCounts(sqlite);
  if (sqlite.query(`SELECT 1 FROM schema_migrations WHERE version=${SORT_KEYS_MIGRATION}`).get()) return;
  sqlite.transaction(() => {
    sqlite.exec(`DELETE FROM indexed_sort_keys;
      INSERT OR IGNORE INTO indexed_sort_keys(tenant_id,message_id,received_at,sender,subject)
        SELECT tenant_id,message_id,${anchor("first")} FROM indexed_messages first ORDER BY rowid;
      INSERT INTO schema_migrations(version,applied_at) VALUES(${SORT_KEYS_MIGRATION},CURRENT_TIMESTAMP);`);
  }).immediate();
}
export const SORT_KEYS_MIGRATION = 490001;

export function migrateSearchIndex(sqlite: Database): void {
  const existing = sqlite.query("SELECT 1 FROM sqlite_master WHERE name='indexed_search'").get();
  const fields = ["sender", "recipients", "subject", "headers", "preview", "body"];
  const values = (row: string) => ["searchSender", "searchRecipients", "searchSubject", "searchHeaders", "searchPreview", "searchBody"]
    .map(field => `lower(COALESCE(json_extract(${row}.content,'$.${field}'),''))`).join(",");
  sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS indexed_search USING fts5(${fields.join(",")},tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS indexed_search_insert AFTER INSERT ON indexed_messages BEGIN
      INSERT INTO indexed_search(rowid,${fields.join(",")}) VALUES(NEW.rowid,${values("NEW")}); END;
    CREATE TRIGGER IF NOT EXISTS indexed_search_update AFTER UPDATE OF content ON indexed_messages BEGIN
      DELETE FROM indexed_search WHERE rowid=OLD.rowid;
      INSERT INTO indexed_search(rowid,${fields.join(",")}) VALUES(NEW.rowid,${values("NEW")}); END;
    CREATE TRIGGER IF NOT EXISTS indexed_search_delete AFTER DELETE ON indexed_messages BEGIN
      DELETE FROM indexed_search WHERE rowid=OLD.rowid; END;`);
  if (!existing) {
    const schema = messageSummarySchema.omit({ ref:true,read:true,flagged:true }).passthrough();
    for (const raw of sqlite.query("SELECT rowid,content FROM indexed_messages").all() as Array<{rowid:number;content:string}>) {
      const content = schema.parse(JSON.parse(raw.content));
      sqlite.query("UPDATE indexed_messages SET content=? WHERE rowid=?").run(JSON.stringify({ ...content,...searchFields(content),
        searchHeaders: [content.messageId,content.inReplyTo ?? "",...(content.references ?? [])].join("\n").toLowerCase(),
      }),raw.rowid);
    }
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS indexed_messages_canonical ON indexed_messages(tenant_id,message_id)");
  if (!sqlite.query("SELECT 1 FROM schema_migrations WHERE version=487001").get()) {
    sqlite.transaction(() => {
      sqlite.exec(`UPDATE indexed_messages SET content=json_set(content,
        '$.sortReceivedAt',received_at,
        '$.sortSender',COALESCE(json_extract(content,'$.searchSenderSort'),'unknown sender'),
        '$.sortSubject',COALESCE(json_extract(content,'$.searchSubject'),''));
        INSERT INTO schema_migrations(version,applied_at) VALUES(487001,CURRENT_TIMESTAMP);`);
    }).immediate();
  }
}

const hasBody = (row: string) => `(json_type(${row}.content,'$.searchBody')='text')`;
/** Adds `sign` times one location's contribution: whether its account's indexed row exists and has body text. */
function locationDelta(row: string, sign: 1 | -1): string {
  const indexed = `EXISTS(SELECT 1 FROM indexed_messages i WHERE i.tenant_id=${row}.tenant_id AND i.account_id=${row}.account_id AND i.message_id=${row}.message_id)`;
  const bodies = `EXISTS(SELECT 1 FROM indexed_messages i WHERE i.tenant_id=${row}.tenant_id AND i.account_id=${row}.account_id AND i.message_id=${row}.message_id AND ${hasBody("i")})`;
  return `INSERT INTO indexed_source_counts(tenant_id,account_id,mailbox,total,bodies) VALUES(${row}.tenant_id,${row}.account_id,${row}.mailbox,${sign}*${indexed},${sign}*${bodies})
    ON CONFLICT(tenant_id,account_id,mailbox) DO UPDATE SET total=total+excluded.total,bodies=bodies+excluded.bodies;`;
}
/** Adds `sign` times an indexed row's contribution to every mailbox holding a location of its message in its account. */
function indexedDelta(row: string, indexed: string, bodies: string): string {
  return `INSERT INTO indexed_source_counts(tenant_id,account_id,mailbox,total,bodies)
      SELECT l.tenant_id,l.account_id,l.mailbox,COUNT(*)*(${indexed}),COUNT(*)*(${bodies}) FROM message_locations l INDEXED BY message_locations_message_id_idx
      WHERE l.message_id=${row}.message_id AND l.tenant_id=${row}.tenant_id AND l.account_id=${row}.account_id GROUP BY l.tenant_id,l.account_id,l.mailbox
    ON CONFLICT(tenant_id,account_id,mailbox) DO UPDATE SET total=total+excluded.total,bodies=bodies+excluded.bodies;`;
}

/**
 * Keeps, per tenant/account/mailbox, how many locations have an indexed row and how many of those have body text,
 * so coverage reads one row per source instead of joining every location.
 */
export function migrateSourceCounts(sqlite: Database): void {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS indexed_source_counts(tenant_id TEXT NOT NULL,account_id TEXT NOT NULL,mailbox TEXT NOT NULL,
      total INTEGER NOT NULL,bodies INTEGER NOT NULL,PRIMARY KEY(tenant_id,account_id,mailbox)) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS indexed_source_counts_location_insert AFTER INSERT ON message_locations BEGIN ${locationDelta("NEW", 1)} END;
    CREATE TRIGGER IF NOT EXISTS indexed_source_counts_location_delete AFTER DELETE ON message_locations BEGIN ${locationDelta("OLD", -1)} END;
    CREATE TRIGGER IF NOT EXISTS indexed_source_counts_location_update AFTER UPDATE OF tenant_id,account_id,mailbox,message_id ON message_locations BEGIN
      ${locationDelta("OLD", -1)} ${locationDelta("NEW", 1)} END;
    CREATE TRIGGER IF NOT EXISTS indexed_source_counts_indexed_insert AFTER INSERT ON indexed_messages BEGIN ${indexedDelta("NEW", "1", hasBody("NEW"))} END;
    CREATE TRIGGER IF NOT EXISTS indexed_source_counts_indexed_delete AFTER DELETE ON indexed_messages BEGIN ${indexedDelta("OLD", "-1", `-${hasBody("OLD")}`)} END;
    CREATE TRIGGER IF NOT EXISTS indexed_source_counts_indexed_content AFTER UPDATE OF content ON indexed_messages
      WHEN ${hasBody("NEW")}<>${hasBody("OLD")} BEGIN ${indexedDelta("NEW", "0", `${hasBody("NEW")}-${hasBody("OLD")}`)} END;
    CREATE TRIGGER IF NOT EXISTS indexed_source_counts_indexed_key AFTER UPDATE OF tenant_id,account_id,message_id ON indexed_messages BEGIN
      ${indexedDelta("OLD", "-1", `-${hasBody("OLD")}`)} ${indexedDelta("NEW", "1", hasBody("NEW"))} END;`);
  if (sqlite.query(`SELECT 1 FROM schema_migrations WHERE version=${SOURCE_COUNTS_MIGRATION}`).get()) return;
  sqlite.transaction(() => {
    sqlite.exec(`DELETE FROM indexed_source_counts;
      INSERT INTO indexed_source_counts(tenant_id,account_id,mailbox,total,bodies)
        SELECT l.tenant_id,l.account_id,l.mailbox,COUNT(i.rowid),COALESCE(SUM(${hasBody("i")}),0) FROM message_locations l
        LEFT JOIN indexed_messages i ON i.tenant_id=l.tenant_id AND i.account_id=l.account_id AND i.message_id=l.message_id
        GROUP BY l.tenant_id,l.account_id,l.mailbox;
      INSERT INTO schema_migrations(version,applied_at) VALUES(${SOURCE_COUNTS_MIGRATION},CURRENT_TIMESTAMP);`);
  }).immediate();
}
export const SOURCE_COUNTS_MIGRATION = 490002;
