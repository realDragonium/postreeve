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
        id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id), tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), provider TEXT NOT NULL, mailbox TEXT NOT NULL,
        location_key TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL, modseq TEXT,
        provider_id TEXT, read INTEGER NOT NULL, flagged INTEGER NOT NULL, observed_at TEXT NOT NULL,
        UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
      );
      INSERT INTO accounts VALUES ('account', 'Work', 'person@example.test', 'imap', NULL, '2026-09-03T00:00:00.000Z');
      INSERT INTO messages VALUES ('message', 'tenant-a', 'message-id:<one@example.test>', '<one@example.test>', NULL, '[]', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
      INSERT INTO message_locations VALUES ('location', 'message', 'tenant-a', 'account', 'imap', 'INBOX', 'imap:INBOX:1:1', '1', 1, NULL, NULL, 0, 0, '2026-09-03T00:00:00.000Z');
    `);
    old.close();

    new Store(path).close();

    const migrated = new Database(path);
    migrated.exec("PRAGMA foreign_keys = ON");
    expect(() => migrated.query(`
      INSERT INTO message_locations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("invalid", "message", "tenant-b", "account", "imap", "INBOX", "invalid", "1", 2, null, null, 0, 0, "2026-09-03T00:00:00.000Z"))
      .toThrow();
    expect(migrated.query("PRAGMA foreign_key_check").all()).toEqual([]);
    migrated.close();
  });
});
