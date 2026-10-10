import type { Database } from "bun:sqlite";
import { z } from "zod";
import { recipientSuggestionQuerySchema, recipientSuggestionSchema, type RecipientSuggestion, type RecipientSuggestionQuery } from "../../shared/contracts";

/**
 * One row per (message, address) the message contributes: its To/Cc addresses when an own address sent it,
 * otherwise its first From address. `row` names the indexed_messages row (NEW, OLD or a table alias).
 */
function contributions(row: string, from = ""): string {
  const sender = `lower(json_extract(${row}.content,'$.from[0].address'))`;
  const own = `(${sender} IN (SELECT lower(email) FROM accounts) OR ${sender} IN (SELECT address FROM identities WHERE tenant_id=${row}.tenant_id))`;
  const recipients = (field: string) => `SELECT ${row}.tenant_id tenant_id,${row}.account_id account_id,${row}.message_id message_id,
    ${row}.received_at at,lower(json_extract(r.value,'$.address')) address,COALESCE(json_extract(r.value,'$.name'),'') name,1 sent
    FROM ${from} json_each(${row}.content,'$.${field}') r WHERE ${own}`;
  return `SELECT tenant_id,account_id,address,max(name) name,at,max(sent) sent FROM (
    ${recipients("to")} UNION ALL ${recipients("cc")} UNION ALL
    SELECT ${row}.tenant_id,${row}.account_id,${row}.message_id,${row}.received_at,${sender},
      COALESCE(json_extract(${row}.content,'$.from[0].name'),''),0 ${from ? `FROM ${from.replace(/,\s*$/, "")}` : ""} WHERE NOT ${own}
  ) WHERE address IS NOT NULL AND address<>'' GROUP BY tenant_id,account_id,message_id,address`;
}

function add(row: string, from = ""): string {
  const newer = "excluded.name<>'' AND (correspondents.name='' OR excluded.name_at>=correspondents.name_at)";
  return `INSERT INTO correspondents(tenant_id,account_id,address,name,name_at,sent_count,received_count,last_at)
    SELECT tenant_id,account_id,address,name,at,sent,1-sent,at FROM (${contributions(row, from)}) WHERE true ORDER BY at
    ON CONFLICT(tenant_id,account_id,address) DO UPDATE SET
      sent_count=correspondents.sent_count+excluded.sent_count,
      received_count=correspondents.received_count+excluded.received_count,
      name=CASE WHEN ${newer} THEN excluded.name ELSE correspondents.name END,
      name_at=CASE WHEN ${newer} THEN excluded.name_at ELSE correspondents.name_at END,
      last_at=max(correspondents.last_at,excluded.last_at);`;
}

// Removal reclassifies with today's own addresses, so counts clamp at zero instead of trusting insert-time history.
const remove = `UPDATE correspondents SET sent_count=max(0,sent_count-c.sent),received_count=max(0,received_count-(1-c.sent))
    FROM (${contributions("OLD")}) c
    WHERE correspondents.tenant_id=c.tenant_id AND correspondents.account_id=c.account_id AND correspondents.address=c.address;
  DELETE FROM correspondents WHERE tenant_id=OLD.tenant_id AND account_id=OLD.account_id AND sent_count=0 AND received_count=0
    AND address IN (SELECT address FROM (${contributions("OLD")}));`;

const headersChanged = ["from", "to", "cc"]
  .map(field => `json_extract(OLD.content,'$.${field}') IS NOT json_extract(NEW.content,'$.${field}')`)
  .concat("OLD.received_at IS NOT NEW.received_at").join(" OR ");

/** Creates the correspondents table and the triggers that keep it in step with indexed_messages. */
export function migrateCorrespondents(sqlite: Database): void {
  sqlite.transaction(() => {
    const exists = sqlite.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='correspondents'").get() !== null;
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS correspondents(tenant_id TEXT NOT NULL,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        address TEXT NOT NULL,name TEXT NOT NULL,name_at TEXT NOT NULL,sent_count INTEGER NOT NULL,received_count INTEGER NOT NULL,
        last_at TEXT NOT NULL,PRIMARY KEY(tenant_id,account_id,address));
      CREATE TRIGGER IF NOT EXISTS correspondents_insert AFTER INSERT ON indexed_messages BEGIN ${add("NEW")} END;
      CREATE TRIGGER IF NOT EXISTS correspondents_delete AFTER DELETE ON indexed_messages BEGIN ${remove} END;
      CREATE TRIGGER IF NOT EXISTS correspondents_update AFTER UPDATE OF content,received_at ON indexed_messages
        WHEN ${headersChanged} BEGIN ${remove} ${add("NEW")} END;
    `);
    if (!exists) sqlite.exec(add("m", "indexed_messages m,"));
  }).immediate();
}

/** Correspondents matching `query`, merged across accounts, without the person's own addresses. */
export function suggestRecipients(sqlite: Database, tenantId: string, input: RecipientSuggestionQuery, now: Date): RecipientSuggestion[] {
  const { q, limit } = recipientSuggestionQuerySchema.parse(input);
  const query = q.toLowerCase();
  const rows = sqlite.query(`
    SELECT address,name FROM (
      SELECT address,name,MAX(CASE WHEN name<>'' THEN name_at END) named_at,SUM(sent_count) sent,SUM(received_count) received,MAX(last_at) last_at
      FROM correspondents
      WHERE tenant_id=:tenant AND address NOT IN (SELECT lower(email) FROM accounts UNION SELECT address FROM identities WHERE tenant_id=:tenant)
      GROUP BY address)
    WHERE instr(address,:query)>0 OR instr(lower(name),:query)>0
    ORDER BY (substr(address,1,length(:query))=:query OR instr(' '||lower(name),' '||:query)>0) DESC,
      sent>0 DESC,
      (3.0*sent+received)/(1+max(0,julianday(:now)-COALESCE(julianday(last_at),julianday(:now)))/30.0) DESC,
      address
    LIMIT :limit`).all({ tenant: tenantId, query, now: now.toISOString(), limit });
  return z.array(recipientSuggestionSchema).parse(rows);
}
