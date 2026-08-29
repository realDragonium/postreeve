import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type {
  Account,
  OperationBatch,
  Proposal,
} from "../../shared/contracts";
import { accounts, batches, proposals, type StoredOperation } from "./schema";

export interface StoredAccount extends Account {
  encryptedCredentials: string | null;
}

export interface StoredBatch extends OperationBatch {
  storedOperations: StoredOperation[];
}

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
    await this.#db.insert(accounts).values({ ...account, createdAt: new Date().toISOString() });
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
        kind TEXT NOT NULL CHECK (kind = 'imap'),
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
      CREATE INDEX IF NOT EXISTS proposals_account_id_idx ON proposals(account_id);
      CREATE INDEX IF NOT EXISTS batches_account_id_idx ON operation_batches(account_id);
    `);
    this.#sqlite.exec(`
      DELETE FROM operation_batches
      WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'fixture');
      DELETE FROM proposals
      WHERE account_id IN (SELECT id FROM accounts WHERE kind = 'fixture');
      DELETE FROM accounts WHERE kind = 'fixture';
    `);
  }
}
