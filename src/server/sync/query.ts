import { createHash } from "node:crypto";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import { messageSummarySchema, type MessageSummary } from "../../shared/contracts";
import { mailboxQuerySchema, type MailboxQuery, type MailboxQueryInput } from "../../shared/mailbox-query";

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
  return createHash("sha256").update(JSON.stringify([tenant, query.sources, query.query, query.filter, query.sort])).digest("hex");
}
export function readCursor(tenant: string, query: MailboxQuery): z.infer<typeof cursorSchema> | null {
  if (!query.cursor) return null;
  try {
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")));
    if (cursor.scope !== scopeKey(tenant, query)) throw new Error();
    return cursor;
  } catch { throw new Error("Invalid cursor for this mailbox query"); }
}
export function queryIndex(sqlite: Database, tenant: string, query: MailboxQuery, fallbackIds: readonly string[] = []): { rows: IndexedRow[]; nextCursor: string | null } {
  const cursor = readCursor(tenant, query);
  const matches = cursor?.fallbackIds ?? [...new Set(fallbackIds)];
  const sort = query.sort === "sender" ? "json_extract(anchor.content,'$.sortSender')"
    : query.sort === "subject" ? "json_extract(anchor.content,'$.sortSubject')" : "json_extract(anchor.content,'$.sortReceivedAt')";
  const direction = query.sort === "newest" ? "DESC" : "ASC";
  const comparison = query.sort === "newest" ? "<" : ">";
  const parameters: SQLQueryBindings[] = [JSON.stringify(query.sources), tenant];
  let search = "";
  if (query.query) {
    const fields = ["sender", "recipients", "subject", "headers", "preview", "body"];
    search = `(i.rowid IN (SELECT rowid FROM indexed_search WHERE ${fields.map(field => `instr(${field},?)>0`).join(" OR ")})`;
    parameters.push(...fields.map(() => query.query));
    // FTS reduces candidates for long literal queries; the exact-field check above keeps punctuation literal.
    if ([...query.query].length >= 3) {
      search += " AND i.rowid IN (SELECT rowid FROM indexed_search WHERE indexed_search MATCH ?)";
      parameters.push(`"${query.query.replaceAll('"', '""')}"`);
    }
    search += ")";
    if (matches.length) { search = `(${search} OR i.message_id IN (SELECT value FROM json_each(?)))`; parameters.push(JSON.stringify(matches)); }
    search = `AND ${search}`;
  }
  const flag = query.filter === "unread" ? "AND l.read=0" : query.filter === "flagged" ? "AND l.flagged=1" : "";
  const keyset = cursor ? `AND (sort_value ${comparison} ? OR (sort_value=? AND message_id ${comparison} ?))` : "";
  if (cursor) parameters.push(cursor.value, cursor.value, cursor.id);
  parameters.push(query.limit + 1);
  const rows = sqlite.query(`WITH sources AS (SELECT json_extract(value,'$.accountId') account_id,json_extract(value,'$.mailbox') mailbox FROM json_each(?)),
    candidates AS (
      SELECT i.message_id,i.content,i.received_at,l.account_id,l.mailbox,l.uid_validity,l.uid,l.modseq,l.provider_id,l.read,l.flagged,
        COALESCE(${sort},'') sort_value,
        ROW_NUMBER() OVER (PARTITION BY i.message_id ORDER BY i.account_id,l.mailbox,l.uid DESC,l.uid_validity DESC,l.id DESC) representative
      FROM indexed_messages i JOIN message_locations l ON l.tenant_id=i.tenant_id AND l.account_id=i.account_id AND l.message_id=i.message_id
      JOIN indexed_messages anchor ON anchor.rowid=(SELECT first.rowid FROM indexed_messages first
        WHERE first.tenant_id=i.tenant_id AND first.message_id=i.message_id ORDER BY first.rowid LIMIT 1)
      JOIN sources s ON s.account_id=l.account_id AND s.mailbox=l.mailbox
      WHERE i.tenant_id=? ${flag} ${search})
    SELECT * FROM candidates WHERE representative=1 ${keyset}
    ORDER BY sort_value ${direction},message_id ${direction} LIMIT ?`).all(...parameters) as IndexedRow[];
  const more = rows.length > query.limit;
  const selected = rows.slice(0, query.limit);
  const last = selected.at(-1);
  return { rows: selected, nextCursor: more && last ? Buffer.from(JSON.stringify({ version: 1,
    scope: scopeKey(tenant, query), fallbackIds: matches, value: last.sort_value, id: last.message_id })).toString("base64url") : null };
}

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
