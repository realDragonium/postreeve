import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/db/store";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  }
});

describe("Store migrations", () => {
  test("removes legacy synthetic accounts while preserving real accounts", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('fixture', 'imap')),
        encrypted_credentials TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO accounts VALUES
        ('legacy', 'Legacy', 'legacy@postreeve.local', 'fixture', NULL, '2026-08-29T00:00:00.000Z'),
        ('real', 'Work', 'person@example.test', 'imap', 'encrypted', '2026-08-29T00:01:00.000Z');
    `);
    legacy.close();

    const store = new Store(path);
    const accounts = await store.listAccounts();

    expect(accounts.map(({ id }) => id)).toEqual(["real"]);
    await store.insertAccount({
      id: "google",
      name: "Gmail",
      email: "person@gmail.test",
      kind: "gmail",
      encryptedCredentials: "encrypted-google-token",
    });
    expect((await store.listAccounts()).map(({ kind }) => kind)).toEqual(["imap", "gmail"]);
    store.close();
  });

  test("upgrades canonical locations to enforce tenant-matched message references", () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('imap', 'gmail')), encrypted_credentials TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, identity_key TEXT NOT NULL,
        message_id TEXT, in_reply_to TEXT, "references" TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, identity_key)
      );
      CREATE TABLE message_locations (
        tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
        provider TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), mailbox TEXT NOT NULL,
        uid INTEGER NOT NULL, location_key TEXT NOT NULL, uid_validity TEXT NOT NULL, provider_id TEXT,
        modseq TEXT, flagged INTEGER NOT NULL, read INTEGER NOT NULL, observed_at TEXT NOT NULL,
        UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
      );
      INSERT INTO accounts VALUES ('account', 'Work', 'person@example.test', 'imap', NULL, '2026-09-03T00:00:00.000Z');
      INSERT INTO messages VALUES ('message', 'tenant-a', 'message-id:<one@example.test>', '<one@example.test>', NULL, '[]', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
      INSERT INTO message_locations
        (id, message_id, tenant_id, account_id, provider, mailbox, location_key, uid_validity, uid,
          modseq, provider_id, read, flagged, observed_at)
      VALUES ('location', 'message', 'tenant-a', 'account', 'imap', 'INBOX', 'imap:INBOX:1:1', '1', 1,
        '7', 'provider-location', 1, 0, '2026-09-03T00:00:00.000Z');
    `);
    old.close();

    new Store(path).close();

    const migrated = new Database(path);
    migrated.exec("PRAGMA foreign_keys = ON");
    expect(() => migrated.query(`
      INSERT INTO message_locations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("invalid", "message", "tenant-b", "account", "imap", "INBOX", "invalid", "1", 2, null, null, 0, 0, "2026-09-03T00:00:00.000Z"))
      .toThrow();
    expect(migrated.query("SELECT * FROM message_locations WHERE id = 'location'").get()).toMatchObject({
      tenant_id: "tenant-a", message_id: "message", account_id: "account", provider: "imap",
      mailbox: "INBOX", location_key: "imap:INBOX:1:1", uid_validity: "1", uid: 1,
      modseq: "7", provider_id: "provider-location", read: 1, flagged: 0,
    });
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });

  test("does not fail canonical migration checks for unrelated historical violations", () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const old = new Database(path, { create: true });
    old.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('imap', 'gmail')), encrypted_credentials TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE proposals (
        id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id), title TEXT NOT NULL,
        status TEXT NOT NULL, items TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        approved_at TEXT, batch_id TEXT
      );
      INSERT INTO proposals VALUES
        ('orphan', 'missing-account', 'Historical', 'draft', '[]', '2026-09-03T00:00:00.000Z',
          '2026-09-03T00:00:00.000Z', NULL, NULL);
    `);
    old.close();

    new Store(path).close();

    const migrated = new Database(path);
    expect(migrated.query("PRAGMA foreign_key_check('proposals')").all()).toHaveLength(1);
    expect(migrated.query("PRAGMA foreign_key_check('message_locations')").all()).toEqual([]);
    migrated.close();
  });

  test("rolls back the canonical location rebuild when its foreign-key check fails", () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const old = new Database(path, { create: true });
    old.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('imap', 'gmail')), encrypted_credentials TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, identity_key TEXT NOT NULL,
        message_id TEXT, in_reply_to TEXT, "references" TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, identity_key)
      );
      CREATE TABLE message_locations (
        id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id), tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), provider TEXT NOT NULL, mailbox TEXT NOT NULL,
        location_key TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL, modseq TEXT,
        provider_id TEXT, read INTEGER NOT NULL, flagged INTEGER NOT NULL, observed_at TEXT NOT NULL,
        UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
      );
      INSERT INTO messages VALUES
        ('message', 'tenant-a', 'message-id:<one@example.test>', '<one@example.test>', NULL, '[]',
          '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
      INSERT INTO message_locations VALUES
        ('orphan-location', 'message', 'tenant-a', 'missing-account', 'imap', 'INBOX', 'imap:INBOX:1:1',
          '1', 1, NULL, NULL, 0, 0, '2026-09-03T00:00:00.000Z');
    `);
    old.close();

    expect(() => new Store(path)).toThrow("Canonical message migration left invalid foreign keys");

    const rolledBack = new Database(path);
    expect(rolledBack.query("SELECT id FROM message_locations").all()).toEqual([{ id: "orphan-location" }]);
    expect(rolledBack.query(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_locations_with_tenant_fk'
    `).get()).toBeNull();
    const messageForeignKey = rolledBack.query("PRAGMA foreign_key_list('message_locations')").all() as Array<{
      table: string;
      from: string;
      to: string;
    }>;
    expect(messageForeignKey.filter(({ table }) => table === "messages").map(({ from, to }) => [from, to]))
      .toEqual([["message_id", "id"]]);
    rolledBack.close();
  });

  test("preserves a legacy tenant-mismatched location when the canonical rebuild rolls back", () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('imap', 'gmail')), encrypted_credentials TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, identity_key TEXT NOT NULL,
        message_id TEXT, in_reply_to TEXT, "references" TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, identity_key)
      );
      CREATE TABLE message_locations (
        id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id), tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), provider TEXT NOT NULL, mailbox TEXT NOT NULL,
        location_key TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL, modseq TEXT,
        provider_id TEXT, read INTEGER NOT NULL, flagged INTEGER NOT NULL, observed_at TEXT NOT NULL,
        UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
      );
      INSERT INTO accounts VALUES
        ('account', 'Work', 'person@example.test', 'imap', NULL, '2026-09-03T00:00:00.000Z');
      INSERT INTO messages VALUES
        ('message', 'tenant-a', 'message-id:<one@example.test>', '<one@example.test>', NULL, '[]',
          '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
      INSERT INTO message_locations VALUES
        ('wrong-tenant-location', 'message', 'tenant-b', 'account', 'imap', 'Archive', 'imap:Archive:2:9',
          '2', 9, '11', 'provider-location', 1, 1, '2026-09-03T00:02:00.000Z');
    `);
    const originalLocation = old.query("SELECT * FROM message_locations").get();
    const originalTable = old.query(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_locations'
    `).get();
    old.close();

    expect(() => new Store(path)).toThrow("Canonical message migration left invalid foreign keys");

    const rolledBack = new Database(path);
    expect(rolledBack.query("SELECT * FROM message_locations").get()).toEqual(originalLocation);
    expect(rolledBack.query(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'message_locations'
    `).get()).toEqual(originalTable);
    expect(rolledBack.query("SELECT version FROM schema_migrations WHERE version = 476").get()).toBeNull();
    expect(rolledBack.query(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_locations_with_tenant_fk'
    `).get()).toBeNull();
    rolledBack.close();
  });
});
