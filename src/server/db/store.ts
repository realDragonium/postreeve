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
      this.#sqlite.query("DELETE FROM message_provider_associations WHERE account_id = ?").run(accountId);
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
      if (observation.location.providerId === "") throw new Error("Provider ID must be non-empty when present");
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
        const legacyLocationKey = legacyLocationKeyFor(observation);
        const fallbackIdentityKey = fallbackIdentityKeyFor(observation);
        const legacyFallbackIdentityKey = legacyFallbackIdentityKeyFor(observation);
        const providerCanonical = findProviderCanonical(this.#sqlite, observation);
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
              AND (message.identity_key = ? OR (message.identity_key = ?
                AND NOT EXISTS (
                  SELECT 1 FROM message_provider_associations known_association
                  WHERE known_association.tenant_id = message.tenant_id
                    AND known_association.message_id = message.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM message_locations known_location
                  WHERE known_location.tenant_id = message.tenant_id
                    AND known_location.message_id = message.id
                )
              ) OR (
                location.account_id = ? AND location.provider = ? AND location.location_key IN (?, ?)
              ) OR EXISTS (
                SELECT 1 FROM message_provider_associations association
                WHERE association.tenant_id = message.tenant_id AND association.message_id = message.id
                  AND association.account_id = ? AND association.provider = ?
                  AND ((? IS NOT NULL AND association.provider_id = ?)
                    OR (? IS NULL AND association.provider_id IS NULL AND association.mailbox = ?
                      AND association.uid_validity = ? AND association.uid = ?))
              ))
            ORDER BY message.created_at, message.id
          `).all(value.tenantId, fallbackIdentityKey, legacyFallbackIdentityKey,
            value.accountId, value.provider, locationKey, legacyLocationKey,
            value.accountId, value.provider, observation.location.providerId, observation.location.providerId,
            observation.location.providerId, observation.location.mailbox, observation.location.uidValidity,
            observation.location.uid) as MessageRow[];
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
            this.#sqlite.query(
              "UPDATE message_aliases SET message_id = ? WHERE tenant_id = ? AND message_id = ?",
            ).run(canonical.id, value.tenantId, fallback.id);
            this.#sqlite.query(
              "UPDATE message_provider_associations SET message_id = ? WHERE tenant_id = ? AND message_id = ?",
            ).run(canonical.id, value.tenantId, fallback.id);
            this.#sqlite.query(`
              INSERT INTO message_aliases (alias_id, tenant_id, message_id, created_at)
              VALUES (?, ?, ?, ?)
            `).run(fallback.id, value.tenantId, canonical.id, now);
            this.#sqlite.query("DELETE FROM messages WHERE tenant_id = ? AND id = ?")
              .run(value.tenantId, fallback.id);
          }
        } else {
          canonical = providerCanonical;
          canonical ??= this.#sqlite.query(`
            SELECT * FROM messages
            WHERE tenant_id = ? AND message_id IS NULL AND (identity_key = ? OR (identity_key = ?
              AND NOT EXISTS (
                SELECT 1 FROM message_provider_associations association
                WHERE association.tenant_id = messages.tenant_id AND association.message_id = messages.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM message_locations location
                WHERE location.tenant_id = messages.tenant_id AND location.message_id = messages.id
              )
            ))
            ORDER BY CASE WHEN identity_key = ? THEN 0 ELSE 1 END, created_at, id
            LIMIT 1
          `).get(value.tenantId, fallbackIdentityKey, legacyFallbackIdentityKey, fallbackIdentityKey) as MessageRow | null;
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
        associateProviderObservation(this.#sqlite, observation, canonicalId);
        const existingLocation = this.#sqlite.query(`
          SELECT id FROM message_locations
          WHERE tenant_id = ? AND account_id = ? AND provider = ? AND mailbox = ?
            AND location_key IN (?, ?)
          ORDER BY CASE WHEN location_key = ? THEN 0 ELSE 1 END, id
          LIMIT 1
        `).get(value.tenantId, value.accountId, value.provider, value.mailbox,
          locationKey, legacyLocationKey, locationKey) as { id: string } | null;
        const location = existingLocation
          ? this.#sqlite.query(`
              UPDATE message_locations SET
                message_id = ?, uid_validity = ?, uid = ?, modseq = ?, provider_id = ?,
                read = ?, flagged = ?, observed_at = ?
              WHERE id = ?
              RETURNING id
            `).get(canonicalId, observation.location.uidValidity, observation.location.uid,
              observation.location.modseq, observation.location.providerId,
              observation.location.read ? 1 : 0, observation.location.flagged ? 1 : 0,
              now, existingLocation.id) as { id: string }
          : this.#sqlite.query(`
              INSERT INTO message_locations
                (id, message_id, tenant_id, account_id, provider, mailbox, location_key, uid_validity, uid,
                  modseq, provider_id, read, flagged, observed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              RETURNING id
            `).get(crypto.randomUUID(), canonicalId, value.tenantId, value.accountId, value.provider,
              value.mailbox, locationKey, observation.location.uidValidity, observation.location.uid,
              observation.location.modseq, observation.location.providerId,
              observation.location.read ? 1 : 0, observation.location.flagged ? 1 : 0, now) as { id: string };
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
    const message = this.#getMessage(tenantId, messageId);
    if (!message) return [];
    const rows = this.#sqlite.query("SELECT * FROM message_locations WHERE tenant_id = ? AND message_id = ? ORDER BY account_id, mailbox, id")
      .all(tenantId, message.id) as LocationRow[];
    return rows.map(toStoredLocation);
  }

  #getMessage(tenantId: string, id: string): CanonicalMessage | null {
    const row = this.#sqlite.query(`
      SELECT message.*
      FROM messages message
      LEFT JOIN message_aliases alias
        ON alias.tenant_id = message.tenant_id AND alias.message_id = message.id
      WHERE message.tenant_id = ? AND (message.id = ? OR alias.alias_id = ?)
      LIMIT 1
    `).get(tenantId, id, id) as MessageRow | null;
    const aliases = row
      ? this.#sqlite.query("SELECT alias_id FROM message_aliases WHERE tenant_id = ? AND message_id = ? ORDER BY created_at, alias_id")
        .all(tenantId, row.id) as Array<{ alias_id: string }>
      : [];
    return row ? {
      id: row.id, aliases: aliases.map(({ alias_id }) => alias_id), tenantId: row.tenant_id,
      messageId: row.message_id, inReplyTo: row.in_reply_to,
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
      CREATE UNIQUE INDEX IF NOT EXISTS messages_tenant_id_id_unique ON messages(tenant_id, id);
      CREATE TABLE IF NOT EXISTS message_aliases (
        alias_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, alias_id),
        FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id)
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
      CREATE INDEX IF NOT EXISTS message_aliases_message_id_idx ON message_aliases(message_id);
    `);
    this.#migrateMessageLocationTenantForeignKey();
    this.#migrateMessageProviderAssociations();
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
          SELECT id, message_id, tenant_id, account_id, provider, mailbox, location_key,
            uid_validity, uid, modseq, provider_id, read, flagged, observed_at
          FROM message_locations;
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

  #migrateMessageProviderAssociations(): void {
    const applied = this.#sqlite.query("SELECT 1 FROM schema_migrations WHERE version = 476001").get();
    if (applied) return;
    const migrate = this.#sqlite.transaction(() => {
      this.#sqlite.exec(`
        CREATE TABLE message_provider_associations (
          tenant_id TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES accounts(id),
          provider TEXT NOT NULL CHECK (provider IN ('imap', 'gmail')),
          provider_id TEXT,
          mailbox TEXT,
          uid_validity TEXT,
          uid INTEGER,
          message_id TEXT NOT NULL,
          FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
          CHECK ((provider_id IS NOT NULL AND provider_id <> ''
              AND mailbox IS NULL AND uid_validity IS NULL AND uid IS NULL)
            OR (provider_id IS NULL AND mailbox IS NOT NULL AND uid_validity IS NOT NULL AND uid IS NOT NULL))
        );
        CREATE UNIQUE INDEX message_provider_associations_provider_id_unique
          ON message_provider_associations(tenant_id, account_id, provider, provider_id)
          WHERE provider_id IS NOT NULL;
        CREATE UNIQUE INDEX message_provider_associations_location_unique
          ON message_provider_associations(tenant_id, account_id, provider, mailbox, uid_validity, uid)
          WHERE provider_id IS NULL;
        CREATE INDEX message_provider_associations_message_id_idx
          ON message_provider_associations(message_id);
      `);
      const providerConflict = this.#sqlite.query(`
        SELECT 1 FROM message_locations
        WHERE provider_id IS NOT NULL AND provider_id <> ''
        GROUP BY tenant_id, account_id, provider, provider_id
        HAVING COUNT(DISTINCT message_id) > 1
        LIMIT 1
      `).get();
      const locationConflict = this.#sqlite.query(`
        SELECT 1 FROM message_locations
        WHERE provider_id IS NULL OR provider_id = ''
        GROUP BY tenant_id, account_id, provider, mailbox, uid_validity, uid
        HAVING COUNT(DISTINCT message_id) > 1
        LIMIT 1
      `).get();
      if (providerConflict || locationConflict) {
        throw new Error("Canonical provider association migration found conflicting messages");
      }
      this.#sqlite.exec(`
        INSERT INTO message_provider_associations
          (tenant_id, account_id, provider, provider_id, mailbox, uid_validity, uid, message_id)
        SELECT tenant_id, account_id, provider, NULLIF(provider_id, ''),
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN mailbox ELSE NULL END,
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN uid_validity ELSE NULL END,
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN uid ELSE NULL END,
          MIN(message_id)
        FROM message_locations
        GROUP BY tenant_id, account_id, provider, NULLIF(provider_id, ''),
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN mailbox ELSE NULL END,
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN uid_validity ELSE NULL END,
          CASE WHEN NULLIF(provider_id, '') IS NULL THEN uid ELSE NULL END;
        INSERT INTO schema_migrations (version, applied_at) VALUES (476001, CURRENT_TIMESTAMP);
      `);
      const violations = this.#sqlite.query("PRAGMA foreign_key_check('message_provider_associations')").all();
      if (violations.length > 0) throw new Error("Canonical provider association migration left invalid foreign keys");
    });
    migrate();
  }
}

interface MessageRow { id: string; tenant_id: string; identity_key: string; message_id: string | null; in_reply_to: string | null; references: string; created_at: string; updated_at: string }
interface LocationRow { id: string; message_id: string; tenant_id: string; account_id: string; provider: MailProviderKind; mailbox: string; uid_validity: string; uid: number; modseq: string | null; provider_id: string | null; read: number; flagged: number; observed_at: string }

function fallbackIdentityKeyFor(observation: CanonicalMessageObservation): string {
  const location = observation.location;
  return `provider:${JSON.stringify(location.providerId
    ? [location.provider, location.accountId, location.providerId]
    : [location.provider, location.accountId, location.mailbox, location.uidValidity, location.uid])}`;
}

function legacyFallbackIdentityKeyFor(observation: CanonicalMessageObservation): string {
  const location = observation.location;
  return `provider:${location.provider}:${location.accountId}:${legacyLocationKeyFor(observation)}`;
}

function locationKeyFor(observation: CanonicalMessageObservation): string {
  const location = observation.location;
  return JSON.stringify(location.providerId
    ? ["provider-id", location.providerId]
    : ["imap", location.mailbox, location.uidValidity, location.uid]);
}

function legacyLocationKeyFor(observation: CanonicalMessageObservation): string {
  const location = observation.location;
  return location.providerId
    ? `provider-id:${location.providerId}`
    : `imap:${location.mailbox}:${location.uidValidity}:${location.uid}`;
}

function findProviderCanonical(sqlite: Database, observation: CanonicalMessageObservation): MessageRow | null {
  const location = observation.location;
  const identity = location.providerId
    ? "association.provider_id = ?"
    : "association.provider_id IS NULL AND association.mailbox = ? AND association.uid_validity = ? AND association.uid = ?";
  const values = location.providerId ? [location.providerId] : [location.mailbox, location.uidValidity, location.uid];
  return sqlite.query(`
    SELECT message.*
    FROM message_provider_associations association
    INNER JOIN messages message
      ON message.tenant_id = association.tenant_id AND message.id = association.message_id
    WHERE association.tenant_id = ? AND association.account_id = ? AND association.provider = ? AND ${identity}
    LIMIT 1
  `).get(observation.tenantId, location.accountId, location.provider, ...values) as MessageRow | null;
}

function associateProviderObservation(
  sqlite: Database,
  observation: CanonicalMessageObservation,
  messageId: string,
): void {
  const location = observation.location;
  sqlite.query(`
    INSERT INTO message_provider_associations
      (tenant_id, account_id, provider, provider_id, mailbox, uid_validity, uid, message_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET message_id = excluded.message_id
  `).run(observation.tenantId, location.accountId, location.provider, location.providerId,
    location.providerId ? null : location.mailbox,
    location.providerId ? null : location.uidValidity,
    location.providerId ? null : location.uid,
    messageId);
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
