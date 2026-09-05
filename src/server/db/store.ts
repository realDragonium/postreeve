import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  Account,
  CanonicalMessage,
  CanonicalMessageObservation,
  MailProviderKind,
  OperationBatch,
  Proposal,
} from "../../shared/contracts";
import { accounts, batches, proposals, type StoredOperation } from "./schema";
import { normalizeMessageId } from "../mail/message-id";

export type StoredAccount = Account & { encryptedCredentials: string | null };

export interface StoredBatch extends OperationBatch {
  storedOperations: StoredOperation[];
}

export interface MailboxSnapshot {
  tenantId: string;
  accountId: string;
  provider: MailProviderKind;
  mailbox: string;
  observations: CanonicalMessageObservation[];
  authoritative: boolean;
}

export type StoredMessageLocation = CanonicalMessageObservation["location"] & {
  id: string;
  messageId: string;
  tenantId: string;
  observedAt: string;
};

export class Store {
  readonly #sqlite: Database;
  readonly #db: BunSQLiteDatabase;

  constructor(path = process.env.POSTREEVE_DB_PATH ?? "./data/postreeve.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#sqlite = new Database(path, { create: true, strict: true });
    this.#sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.#migrate();
    this.#db = drizzle(this.#sqlite);
  }

  close(): void {
    this.#sqlite.close();
  }

  async listAccounts(): Promise<StoredAccount[]> {
    return this.#db.select({
      id: accounts.id,
      name: accounts.name,
      email: accounts.email,
      kind: accounts.kind,
      encryptedCredentials: accounts.encryptedCredentials,
    }).from(accounts).orderBy(accounts.createdAt);
  }

  async getAccount(id: string): Promise<StoredAccount | null> {
    const rows = await this.#db.select({
      id: accounts.id,
      name: accounts.name,
      email: accounts.email,
      kind: accounts.kind,
      encryptedCredentials: accounts.encryptedCredentials,
    }).from(accounts).where(eq(accounts.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async insertAccount(account: StoredAccount): Promise<void> {
    await this.#db.insert(accounts).values({
      id: account.id,
      name: account.name,
      email: account.email,
      kind: account.kind,
      encryptedCredentials: account.encryptedCredentials,
      createdAt: new Date().toISOString(),
    });
  }

  async updateAccount(account: StoredAccount): Promise<void> {
    await this.#db.update(accounts).set({
      name: account.name,
      email: account.email,
      encryptedCredentials: account.encryptedCredentials,
    }).where(eq(accounts.id, account.id));
  }

  async deleteAccount(id: string): Promise<boolean> {
    const account = await this.getAccount(id);
    if (!account) return false;
    const remove = this.#sqlite.transaction((accountId: string) => {
      this.#sqlite.query("DELETE FROM message_locations WHERE account_id = ?").run(accountId);
      this.#sqlite.query("DELETE FROM operation_batches WHERE account_id = ?").run(accountId);
      this.#sqlite.query("DELETE FROM proposals WHERE account_id = ?").run(accountId);
      this.#sqlite.query("DELETE FROM accounts WHERE id = ?").run(accountId);
    });
    remove(id);
    return true;
  }

  async insertProposal(proposal: Proposal): Promise<void> {
    await this.#db.insert(proposals).values(proposal);
  }

  async getProposal(id: string): Promise<Proposal | null> {
    const rows = await this.#db.select().from(proposals).where(eq(proposals.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async listProposals(accountId: string): Promise<Proposal[]> {
    return this.#db.select().from(proposals)
      .where(eq(proposals.accountId, accountId))
      .orderBy(desc(proposals.updatedAt));
  }

  async updateProposal(proposal: Proposal): Promise<void> {
    await this.#db.update(proposals).set({
      title: proposal.title,
      status: proposal.status,
      items: proposal.items,
      updatedAt: proposal.updatedAt,
      approvedAt: proposal.approvedAt,
      batchId: proposal.batchId,
    }).where(eq(proposals.id, proposal.id));
  }

  async insertBatch(batch: StoredBatch): Promise<void> {
    await this.#db.insert(batches).values({
      id: batch.id,
      proposalId: batch.proposalId,
      accountId: batch.accountId,
      status: batch.status,
      operations: batch.storedOperations,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
    });
  }

  async getBatch(id: string): Promise<StoredBatch | null> {
    const rows = await this.#db.select().from(batches).where(eq(batches.id, id)).limit(1);
    const row = rows[0];
    return row ? this.#toStoredBatch(row) : null;
  }

  async listBatches(accountId: string): Promise<StoredBatch[]> {
    const rows = await this.#db.select().from(batches)
      .where(eq(batches.accountId, accountId))
      .orderBy(desc(batches.createdAt));
    return rows.map((row) => this.#toStoredBatch(row));
  }

  async updateBatch(batch: StoredBatch): Promise<void> {
    await this.#db.update(batches).set({
      status: batch.status,
      operations: batch.storedOperations,
      updatedAt: batch.updatedAt,
    }).where(and(eq(batches.id, batch.id), eq(batches.accountId, batch.accountId)));
  }

  async reconcileMailbox(snapshot: MailboxSnapshot): Promise<CanonicalMessage[]> {
    for (const observation of snapshot.observations) {
      if (observation.tenantId !== snapshot.tenantId
        || observation.location.accountId !== snapshot.accountId
        || observation.location.provider !== snapshot.provider
        || observation.location.mailbox !== snapshot.mailbox) {
        throw new Error("Every observation must belong to the reconciled mailbox boundary");
      }
    }
    const reconcile = this.#sqlite.transaction((value: MailboxSnapshot) => {
      const now = new Date().toISOString();
      const observedLocationIds: string[] = [];
      for (const observation of value.observations) {
        const normalizedMessageId = normalizeMessageId(observation.messageId);
        const normalizedInReplyTo = normalizeMessageId(observation.inReplyTo);
        const normalizedReferences = observation.references.flatMap((reference) => {
          const normalized = normalizeMessageId(reference);
          return normalized ? [normalized] : [];
        });
        const locationKey = locationKeyFor(observation);
        const fallbackIdentityKey = fallbackIdentityKeyFor(observation);
        const providerCanonical = this.#sqlite.query(`
          SELECT message.*
          FROM message_locations location
          INNER JOIN messages message
            ON message.tenant_id = location.tenant_id AND message.id = location.message_id
          WHERE location.tenant_id = ? AND location.account_id = ? AND location.provider = ?
            AND location.location_key = ?
          ORDER BY CASE WHEN location.mailbox = ? THEN 0 ELSE 1 END, location.id
          LIMIT 1
        `).get(value.tenantId, value.accountId, value.provider, locationKey, value.mailbox) as MessageRow | null;
        let canonical: MessageRow | null = null;
        let fallbackRows: MessageRow[] = [];

        if (normalizedMessageId) {
          const identityKey = `message-id:${normalizedMessageId}`;
          canonical = this.#sqlite.query(
            "SELECT * FROM messages WHERE tenant_id = ? AND identity_key = ?",
          ).get(value.tenantId, identityKey) as MessageRow | null;
          fallbackRows = this.#sqlite.query(`
            SELECT DISTINCT message.*
            FROM messages message
            LEFT JOIN message_locations location
              ON location.tenant_id = message.tenant_id AND location.message_id = message.id
            WHERE message.tenant_id = ? AND message.message_id IS NULL
              AND (message.identity_key = ? OR (
                location.account_id = ? AND location.provider = ? AND location.location_key = ?
              ))
            ORDER BY message.created_at, message.id
          `).all(value.tenantId, fallbackIdentityKey, value.accountId, value.provider, locationKey) as MessageRow[];
          canonical ??= fallbackRows[0] ?? null;
          if (!canonical) {
            const id = crypto.randomUUID();
            this.#sqlite.query(`
              INSERT INTO messages
                (id, tenant_id, identity_key, message_id, in_reply_to, "references", created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(id, value.tenantId, identityKey, normalizedMessageId, normalizedInReplyTo,
              JSON.stringify(normalizedReferences), now, now);
            canonical = this.#sqlite.query("SELECT * FROM messages WHERE tenant_id = ? AND id = ?")
              .get(value.tenantId, id) as MessageRow;
          }

          const mergedMetadata = mergeThreadingMetadata(
            normalizedInReplyTo, normalizedReferences, canonical, fallbackRows,
          );
          this.#sqlite.query(`
            UPDATE messages
            SET identity_key = ?, message_id = ?, in_reply_to = ?, "references" = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?
          `).run(identityKey, normalizedMessageId, mergedMetadata.inReplyTo,
            JSON.stringify(mergedMetadata.references), now, value.tenantId, canonical.id);
          for (const fallback of fallbackRows) {
            if (fallback.id === canonical.id) continue;
            this.#sqlite.query(
              "UPDATE message_locations SET message_id = ? WHERE tenant_id = ? AND message_id = ?",
            ).run(canonical.id, value.tenantId, fallback.id);
            this.#sqlite.query("DELETE FROM messages WHERE tenant_id = ? AND id = ?")
              .run(value.tenantId, fallback.id);
          }
        } else {
          canonical = providerCanonical;
          if (!canonical) {
            const id = crypto.randomUUID();
            this.#sqlite.query(`
              INSERT INTO messages
                (id, tenant_id, identity_key, message_id, in_reply_to, "references", created_at, updated_at)
              VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
              ON CONFLICT (tenant_id, identity_key) DO NOTHING
            `).run(id, value.tenantId, fallbackIdentityKey, normalizedInReplyTo,
              JSON.stringify(normalizedReferences), now, now);
            canonical = this.#sqlite.query(
              "SELECT * FROM messages WHERE tenant_id = ? AND identity_key = ?",
            ).get(value.tenantId, fallbackIdentityKey) as MessageRow;
          }
          const mergedMetadata = mergeThreadingMetadata(normalizedInReplyTo, normalizedReferences, canonical, []);
          this.#sqlite.query(`
            UPDATE messages SET in_reply_to = ?, "references" = ?, updated_at = ?
            WHERE tenant_id = ? AND id = ?
          `).run(mergedMetadata.inReplyTo, JSON.stringify(mergedMetadata.references), now,
            value.tenantId, canonical.id);
        }

        const canonicalId = canonical.id;
        const location = this.#sqlite.query(`
          INSERT INTO message_locations
            (id, message_id, tenant_id, account_id, provider, mailbox, location_key, uid_validity, uid, modseq, provider_id, read, flagged, observed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (tenant_id, account_id, provider, mailbox, location_key) DO UPDATE SET
            message_id = excluded.message_id,
            uid_validity = excluded.uid_validity,
            uid = excluded.uid,
            modseq = excluded.modseq,
            provider_id = excluded.provider_id,
            read = excluded.read,
            flagged = excluded.flagged,
            observed_at = excluded.observed_at
          RETURNING id
        `).get(crypto.randomUUID(), canonicalId, value.tenantId, value.accountId, value.provider, value.mailbox, locationKey,
          observation.location.uidValidity, observation.location.uid, observation.location.modseq,
          observation.location.providerId, observation.location.read ? 1 : 0, observation.location.flagged ? 1 : 0, now) as { id: string };
        const locationId = location.id;
        observedLocationIds.push(locationId);
      }
      if (value.authoritative) {
        const locations = this.#sqlite.query(
          "SELECT id FROM message_locations WHERE tenant_id = ? AND account_id = ? AND provider = ? AND mailbox = ?",
        ).all(value.tenantId, value.accountId, value.provider, value.mailbox) as Array<{ id: string }>;
        const retained = new Set(observedLocationIds);
        const remove = this.#sqlite.query("DELETE FROM message_locations WHERE id = ?");
        for (const location of locations) if (!retained.has(location.id)) remove.run(location.id);
      }
      return observedLocationIds.map((id) => {
        const location = this.#sqlite.query(
          "SELECT message_id FROM message_locations WHERE tenant_id = ? AND id = ?",
        ).get(value.tenantId, id) as { message_id: string } | null;
        if (!location) throw new Error("Reconciled message location is missing");
        const message = this.#getMessage(value.tenantId, location.message_id);
        if (!message) throw new Error("Reconciled canonical message is missing");
        return message;
      });
    });
    return reconcile(snapshot);
  }

  async getMessage(tenantId: string, id: string): Promise<CanonicalMessage | null> {
    return this.#getMessage(tenantId, id);
  }

  async listMessageLocations(tenantId: string, messageId: string): Promise<StoredMessageLocation[]> {
    const rows = this.#sqlite.query("SELECT * FROM message_locations WHERE tenant_id = ? AND message_id = ? ORDER BY account_id, mailbox, id")
      .all(tenantId, messageId) as LocationRow[];
    return rows.map(toStoredLocation);
  }

  #getMessage(tenantId: string, id: string): CanonicalMessage | null {
    const row = this.#sqlite.query("SELECT * FROM messages WHERE tenant_id = ? AND id = ?").get(tenantId, id) as MessageRow | null;
    return row ? {
      id: row.id, tenantId: row.tenant_id, messageId: row.message_id, inReplyTo: row.in_reply_to,
      references: JSON.parse(row.references) as string[], createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  #toStoredBatch(row: typeof batches.$inferSelect): StoredBatch {
    return {
      id: row.id,
      proposalId: row.proposalId,
      accountId: row.accountId,
      status: row.status,
      operations: row.operations.map(({ result }) => result),
      storedOperations: row.operations,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  #migrate(): void {
    this.#sqlite.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('imap', 'gmail')),
        encrypted_credentials TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        items TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_at TEXT,
        batch_id TEXT
      );
      CREATE TABLE IF NOT EXISTS operation_batches (
        id TEXT PRIMARY KEY NOT NULL,
        proposal_id TEXT NOT NULL REFERENCES proposals(id),
        account_id TEXT NOT NULL REFERENCES accounts(id),
        status TEXT NOT NULL,
        operations TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        tenant_id TEXT NOT NULL,
        identity_key TEXT NOT NULL,
        message_id TEXT,
        in_reply_to TEXT,
        "references" TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, identity_key),
        UNIQUE (tenant_id, id)
      );
      CREATE TABLE IF NOT EXISTS message_locations (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        provider TEXT NOT NULL CHECK (provider IN ('imap', 'gmail')),
        mailbox TEXT NOT NULL,
        location_key TEXT NOT NULL,
        uid_validity TEXT NOT NULL,
        uid INTEGER NOT NULL,
        modseq TEXT,
        provider_id TEXT,
        read INTEGER NOT NULL,
        flagged INTEGER NOT NULL,
        observed_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
        UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
      );
      CREATE INDEX IF NOT EXISTS proposals_account_id_idx ON proposals(account_id);
      CREATE INDEX IF NOT EXISTS batches_account_id_idx ON operation_batches(account_id);
      CREATE INDEX IF NOT EXISTS message_locations_message_id_idx ON message_locations(message_id);
    `);
    this.#migrateMessageLocationTenantForeignKey();
    const accountsTable = this.#sqlite.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
      .get() as { sql: string } | null;
    if (accountsTable && !accountsTable.sql.includes("'gmail'")) {
      this.#sqlite.exec("PRAGMA foreign_keys = OFF");
      try {
        this.#sqlite.exec(`
          BEGIN;
          CREATE TABLE accounts_with_gmail (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            email TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('imap', 'gmail')),
            encrypted_credentials TEXT,
            created_at TEXT NOT NULL
          );
          INSERT INTO accounts_with_gmail
            SELECT id, name, email, kind, encrypted_credentials, created_at
            FROM accounts
            WHERE kind IN ('imap', 'gmail');
          DROP TABLE accounts;
          ALTER TABLE accounts_with_gmail RENAME TO accounts;
          COMMIT;
        `);
      } catch (error) {
        if (this.#sqlite.inTransaction) this.#sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        this.#sqlite.exec("PRAGMA foreign_keys = ON");
      }
    }
    this.#sqlite.exec(`
      DELETE FROM operation_batches
      WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'fixture');
      DELETE FROM proposals
      WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'fixture');
      DELETE FROM accounts WHERE kind = 'fixture';
    `);
  }

  #migrateMessageLocationTenantForeignKey(): void {
    this.#sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_id_id_unique ON messages(tenant_id, id)");
    const foreignKeys = this.#sqlite.query("PRAGMA foreign_key_list('message_locations')").all() as Array<{
      id: number;
      table: string;
      from: string;
      to: string;
    }>;
    const messageForeignKeys = new Map<number, typeof foreignKeys>();
    for (const foreignKey of foreignKeys.filter((candidate) => candidate.table === "messages")) {
      const columns = messageForeignKeys.get(foreignKey.id) ?? [];
      columns.push(foreignKey);
      messageForeignKeys.set(foreignKey.id, columns);
    }
    const hasTenantMessageForeignKey = [...messageForeignKeys.values()].some((columns) =>
      columns.some((column) => column.from === "tenant_id" && column.to === "tenant_id")
      && columns.some((column) => column.from === "message_id" && column.to === "id"));
    if (!hasTenantMessageForeignKey) {
      this.#sqlite.exec("PRAGMA foreign_keys = OFF");
      try {
        this.#sqlite.exec(`
          BEGIN;
          CREATE TABLE message_locations_with_tenant_fk (
            id TEXT PRIMARY KEY NOT NULL,
            message_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            account_id TEXT NOT NULL REFERENCES accounts(id),
            provider TEXT NOT NULL CHECK (provider IN ('imap', 'gmail')),
            mailbox TEXT NOT NULL,
            location_key TEXT NOT NULL,
            uid_validity TEXT NOT NULL,
            uid INTEGER NOT NULL,
            modseq TEXT,
            provider_id TEXT,
            read INTEGER NOT NULL,
            flagged INTEGER NOT NULL,
            observed_at TEXT NOT NULL,
            FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
            UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
          );
          INSERT INTO message_locations_with_tenant_fk
            (id, message_id, tenant_id, account_id, provider, mailbox, location_key,
              uid_validity, uid, modseq, provider_id, read, flagged, observed_at)
          SELECT location.id, location.message_id, location.tenant_id, location.account_id,
            location.provider, location.mailbox, location.location_key, location.uid_validity,
            location.uid, location.modseq, location.provider_id, location.read,
            location.flagged, location.observed_at
          FROM message_locations location
          INNER JOIN messages message
            ON message.id = location.message_id AND message.tenant_id = location.tenant_id;
          DROP TABLE message_locations;
          ALTER TABLE message_locations_with_tenant_fk RENAME TO message_locations;
          INSERT OR IGNORE INTO schema_migrations (version, applied_at)
            VALUES (476, CURRENT_TIMESTAMP);
        `);
        const violations = this.#sqlite.query("PRAGMA foreign_key_check('message_locations')").all();
        if (violations.length > 0) throw new Error("Canonical message migration left invalid foreign keys");
        this.#sqlite.exec("COMMIT");
      } catch (error) {
        if (this.#sqlite.inTransaction) this.#sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        this.#sqlite.exec("PRAGMA foreign_keys = ON");
      }
    }
    this.#sqlite.exec("CREATE INDEX IF NOT EXISTS message_locations_message_id_idx ON message_locations(message_id)");
  }
}

interface MessageRow { id: string; tenant_id: string; identity_key: string; message_id: string | null; in_reply_to: string | null; references: string; created_at: string; updated_at: string }
interface LocationRow { id: string; message_id: string; tenant_id: string; account_id: string; provider: MailProviderKind; mailbox: string; uid_validity: string; uid: number; modseq: string | null; provider_id: string | null; read: number; flagged: number; observed_at: string }

function fallbackIdentityKeyFor(observation: CanonicalMessageObservation): string {
  return `provider:${observation.location.provider}:${observation.location.accountId}:${locationKeyFor(observation)}`;
}

function locationKeyFor(observation: CanonicalMessageObservation): string {
  return observation.location.providerId
    ? `provider-id:${observation.location.providerId}`
    : `imap:${observation.location.mailbox}:${observation.location.uidValidity}:${observation.location.uid}`;
}

function toStoredLocation(row: LocationRow): StoredMessageLocation {
  return { id: row.id, messageId: row.message_id, tenantId: row.tenant_id, accountId: row.account_id,
    provider: row.provider, mailbox: row.mailbox, uidValidity: row.uid_validity, uid: row.uid, modseq: row.modseq,
    providerId: row.provider_id, read: row.read === 1, flagged: row.flagged === 1, observedAt: row.observed_at };
}

function mergeThreadingMetadata(
  observedInReplyTo: string | null,
  observedReferences: string[],
  canonical: MessageRow,
  merged: MessageRow[],
): { inReplyTo: string | null; references: string[] } {
  const rows = [canonical, ...merged.filter(({ id }) => id !== canonical.id)];
  const retainedInReplyTo = rows.find(({ in_reply_to }) => in_reply_to !== null)?.in_reply_to ?? null;
  const retainedReferences = rows.map(({ references }) => JSON.parse(references) as string[])
    .find((references) => references.length > 0) ?? [];
  return {
    inReplyTo: observedInReplyTo ?? retainedInReplyTo,
    references: observedReferences.length > 0 ? observedReferences : retainedReferences,
  };
}
