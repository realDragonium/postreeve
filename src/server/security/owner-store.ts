import type { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { owner, ownerPasskeys, ownerSessions } from "../db/schema";

export type StoredOwner = typeof owner.$inferSelect;
export type StoredPasskey = typeof ownerPasskeys.$inferSelect;
export type StoredSession = typeof ownerSessions.$inferSelect;

/** Creates the owner tables; like correspondents, the module owns its tables instead of a numbered migration. */
export function migrateOwnerAuth(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS owner (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      password_hash TEXT NOT NULL,
      webauthn_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS owner_passkeys (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT NOT NULL,
      device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS owner_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      method TEXT NOT NULL CHECK (method IN ('password', 'passkey')),
      user_agent TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS owner_sessions_expires_idx ON owner_sessions(expires_at);
  `);
}

/** Synchronous owner, passkey and session persistence; bun:sqlite is synchronous, so request guards need no await. */
export class OwnerStore {
  readonly #db: BunSQLiteDatabase;
  readonly #sqlite: Database;

  constructor(sqlite: Database) {
    migrateOwnerAuth(sqlite);
    this.#sqlite = sqlite;
    this.#db = drizzle(sqlite);
  }

  getOwner(): StoredOwner | null {
    return this.#db.select().from(owner).where(eq(owner.id, 1)).get() ?? null;
  }

  /** Inserts the single owner row; returns false when an owner already exists. */
  createOwner(passwordHash: string, webauthnUserId: string, now: string): boolean {
    const result = this.#sqlite.query(`
      INSERT INTO owner (id, password_hash, webauthn_user_id, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING
    `).run(passwordHash, webauthnUserId, now, now);
    return result.changes === 1;
  }

  setPasswordHash(passwordHash: string, now: string): void {
    this.#db.update(owner).set({ passwordHash, updatedAt: now }).where(eq(owner.id, 1)).run();
  }

  listPasskeys(): StoredPasskey[] {
    return this.#db.select().from(ownerPasskeys).orderBy(ownerPasskeys.createdAt).all();
  }

  getPasskey(id: string): StoredPasskey | null {
    return this.#db.select().from(ownerPasskeys).where(eq(ownerPasskeys.id, id)).get() ?? null;
  }

  addPasskey(passkey: StoredPasskey): void {
    this.#db.insert(ownerPasskeys).values(passkey).run();
  }

  recordPasskeyUse(id: string, counter: number, now: string): void {
    this.#db.update(ownerPasskeys).set({ counter, lastUsedAt: now }).where(eq(ownerPasskeys.id, id)).run();
  }

  removePasskey(id: string): boolean {
    return this.#sqlite.query("DELETE FROM owner_passkeys WHERE id = ?").run(id).changes > 0;
  }

  createSession(session: StoredSession): void {
    this.#db.insert(ownerSessions).values(session).run();
  }

  findSessionByTokenHash(tokenHash: string): StoredSession | null {
    return this.#db.select().from(ownerSessions).where(eq(ownerSessions.tokenHash, tokenHash)).get() ?? null;
  }

  getSession(id: string): StoredSession | null {
    return this.#db.select().from(ownerSessions).where(eq(ownerSessions.id, id)).get() ?? null;
  }

  listSessions(): StoredSession[] {
    return this.#db.select().from(ownerSessions).orderBy(desc(ownerSessions.lastSeenAt)).all();
  }

  touchSession(id: string, now: string): void {
    this.#db.update(ownerSessions).set({ lastSeenAt: now }).where(eq(ownerSessions.id, id)).run();
  }

  deleteSession(id: string): boolean {
    return this.#sqlite.query("DELETE FROM owner_sessions WHERE id = ?").run(id).changes > 0;
  }

  deleteSessionsExcept(id: string | null): number {
    return id === null
      ? this.#sqlite.query("DELETE FROM owner_sessions").run().changes
      : this.#sqlite.query("DELETE FROM owner_sessions WHERE id <> ?").run(id).changes;
  }

  /** Removes sessions past their absolute expiry or idle since `idleBefore`. */
  deleteExpiredSessions(now: string, idleBefore: string): number {
    return this.#sqlite.query("DELETE FROM owner_sessions WHERE expires_at <= ? OR last_seen_at <= ?")
      .run(now, idleBefore).changes;
  }
}
