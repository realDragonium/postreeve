import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Draft } from "../src/shared/contracts";
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
  test("adds drafts to a pre-479 store without changing accounts or canonical messages", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const baseline = new Store(path);
    await baseline.insertAccount({
      id: "imap-account",
      name: "IMAP",
      email: "person@example.test",
      kind: "imap",
      encryptedCredentials: "retained-credentials",
    });
    const [message] = await baseline.reconcileMailbox({
      tenantId: "tenant-a",
      accountId: "imap-account",
      provider: "imap",
      mailbox: "INBOX",
      authoritative: true,
      observations: [{
        tenantId: "tenant-a",
        messageId: "<retained@example.test>",
        inReplyTo: null,
        references: [],
        location: {
          accountId: "imap-account",
          provider: "imap",
          mailbox: "INBOX",
          uidValidity: "1",
          uid: 1,
          modseq: "1",
          providerId: null,
          read: false,
          flagged: false,
        },
      }],
    });
    baseline.close();

    const pre479 = new Database(path);
    pre479.exec("DROP TABLE draft_tombstones; DROP TABLE drafts; DELETE FROM schema_migrations WHERE version IN (479, 480, 480001, 480002);");
    pre479.close();

    const migrated = new Store(path);
    expect(await migrated.getAccount("imap-account")).toEqual({
      id: "imap-account",
      name: "IMAP",
      email: "person@example.test",
      kind: "imap",
      encryptedCredentials: "retained-credentials",
    });
    expect(await migrated.getMessage("tenant-a", message!.id)).toEqual(message!);
    migrated.close();

    const inspected = new Database(path);
    expect(inspected.query("SELECT version FROM schema_migrations WHERE version = 479").get()).toEqual({ version: 479 });
    expect(inspected.query("SELECT version FROM schema_migrations WHERE version = 480").get()).toEqual({ version: 480 });
    expect(inspected.query("SELECT version FROM schema_migrations WHERE version = 480001").get()).toEqual({ version: 480001 });
    expect(inspected.query("SELECT version FROM schema_migrations WHERE version = 480002").get()).toEqual({ version: 480002 });
    expect((inspected.query("PRAGMA table_info('drafts')").all() as Array<{ name: string }>).map(({ name }) => name))
      .toContain("mirror_status");
    expect((inspected.query("PRAGMA table_info('drafts')").all() as Array<{ name: string }>).map(({ name }) => name))
      .toContain("attachments");
    expect(inspected.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drafts'").get())
      .toEqual({ name: "drafts" });
    expect(inspected.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'draft_tombstones'").get())
      .toEqual({ name: "draft_tombstones" });
    expect((inspected.query("PRAGMA table_info('draft_tombstones')").all() as Array<{ name: string; pk: number }>)
      .filter(({ pk }) => pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(({ name }) => name))
      .toEqual(["tenant_id", "account_id", "id"]);
    expect(inspected.query("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
  });

  test("adds tombstones to an existing draft store without changing its drafts", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const baseline = new Store(path);
    await baseline.insertAccount({
      id: "draft-account",
      name: "Draft owner",
      email: "owner@example.test",
      kind: "imap",
      encryptedCredentials: null,
    });
    const draft = {
      id: "preserved-draft",
      accountId: "draft-account",
      mode: "new",
      to: "unfinished recipient",
      cc: [],
      bcc: [],
      subject: "Preserved subject",
      body: "Preserved body",
      identity: { name: "Draft owner", address: "owner@example.test" },
      attachments: [{ name: "legacy.txt", size: 7, type: "text/plain" }],
      delivery: { status: "editable" },
      mirror: { status: "pending" },
      createdAt: "2026-09-06T10:00:00.000Z",
      updatedAt: "2026-09-06T10:00:00.000Z",
      version: 1,
    } satisfies Draft;
    await baseline.insertDraft("tenant-a", draft);
    baseline.close();

    const previous = new Database(path);
    previous.exec("DROP TABLE draft_tombstones; DELETE FROM schema_migrations WHERE version = 480002;");
    previous.close();

    const migrated = new Store(path);
    expect(await migrated.getDraft("tenant-a", draft.accountId, draft.id)).toEqual(draft);
    migrated.close();

    const inspected = new Database(path);
    expect(inspected.query("SELECT version FROM schema_migrations WHERE version = 480002").get())
      .toEqual({ version: 480002 });
    expect(inspected.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'draft_tombstones'").get())
      .toEqual({ name: "draft_tombstones" });
    expect(inspected.query("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.close();
  });

  test("atomically backfills a genuine pre-477 store and preserves it across reopen", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, identity_key TEXT NOT NULL,
        message_id TEXT, in_reply_to TEXT, "references" TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (tenant_id, identity_key)
      );
      INSERT INTO messages VALUES
        ('parent', 'tenant-a', 'message-id:<parent@example.test>', '<parent@example.test>', NULL, '[]',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        ('child', 'tenant-a', 'message-id:<child@example.test>', '<child@example.test>', '<parent@example.test>',
          '["<parent@example.test>"]', '2026-09-01T00:01:00.000Z', '2026-09-01T00:01:00.000Z'),
        ('quoted', 'tenant-a', 'message-id:<"legacy"@example.test>', '<"legacy"@example.test>', NULL, '[]',
          '2026-09-01T00:02:00.000Z', '2026-09-01T00:02:00.000Z'),
        ('escaped', 'tenant-a', 'message-id:<"l\\egacy"@example.test>', '<"l\\egacy"@example.test>', NULL, '[]',
          '2026-09-01T00:03:00.000Z', '2026-09-01T00:03:00.000Z');
    `);
    old.close();

    const migrated = new Store(path);
    const parent = await migrated.getMessage("tenant-a", "parent");
    expect(parent?.receivedAt).toBeNull();
    expect((await migrated.getConversation("tenant-a", parent!.conversationId))?.messages.map(({ messageId }) => messageId))
      .toEqual(["<parent@example.test>", "<child@example.test>"]);
    expect((await migrated.getMessage("tenant-a", "quoted"))?.id).toBe("quoted");
    expect((await migrated.getMessage("tenant-a", "escaped"))?.id).toBe("quoted");
    expect((await migrated.getMessage("tenant-a", "quoted"))?.messageId).toBe("<legacy@example.test>");
    migrated.close();

    const inspected = new Database(path);
    expect(inspected.query("SELECT version FROM schema_migrations WHERE version = 477").get()).toEqual({ version: 477 });
    expect(inspected.query("PRAGMA foreign_key_check").all()).toEqual([]);
    inspected.exec(`
      CREATE TRIGGER reject_healthy_conversation_rebuild
      BEFORE INSERT ON conversations
      BEGIN SELECT RAISE(ABORT, 'healthy startup rebuilt conversations'); END;
    `);
    inspected.close();

    const reopened = new Store(path);
    expect((await reopened.getConversation("tenant-a", parent!.conversationId))?.messages.map(({ id }) => id))
      .toEqual(["parent", "child"]);
    reopened.close();
  });

  test("recovers messages inserted without DRA-477 memberships after the migration marker", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    new Store(path).close();
    const fixture = new Database(path);
    fixture.query(`
      INSERT INTO messages
        (id, tenant_id, identity_key, message_id, in_reply_to, "references", received_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run("late-fixture", "tenant-a", "message-id:<late-fixture@example.test>",
      "<late-fixture@example.test>", null, "[]", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    fixture.close();

    const recovered = new Store(path);
    const message = await recovered.getMessage("tenant-a", "late-fixture");
    expect((await recovered.getConversation("tenant-a", message!.conversationId))?.messages.map(({ id }) => id))
      .toEqual(["late-fixture"]);
    recovered.close();
  });

  test("recovers every missing edge from a stored multi-parent In-Reply-To field", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const store = new Store(path);
    await store.insertAccount({
      id: "imap-account", name: "IMAP", email: "person@example.test", kind: "imap", encryptedCredentials: null,
    });
    const [child] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{
        tenantId: "tenant-a", messageId: "<child@example.test>",
        inReplyTo: "<parent-a@example.test> <parent-b@example.test>", references: [],
        location: { accountId: "imap-account", provider: "imap", mailbox: "INBOX", uidValidity: "1", uid: 1,
          modseq: null, providerId: null, read: false, flagged: false },
      }],
    });
    store.close();

    const damaged = new Database(path);
    damaged.query(`
      DELETE FROM message_thread_edges
      WHERE tenant_id = ? AND message_id = ? AND referenced_message_id = ?
    `).run("tenant-a", child!.id, "<parent-b@example.test>");
    damaged.close();

    new Store(path).close();
    const recovered = new Database(path);
    expect(recovered.query(`
      SELECT referenced_message_id FROM message_thread_edges
      WHERE tenant_id = ? AND message_id = ? ORDER BY referenced_message_id
    `).all("tenant-a", child!.id)).toEqual([
      { referenced_message_id: "<parent-a@example.test>" },
      { referenced_message_id: "<parent-b@example.test>" },
    ]);
    recovered.close();
  });

  test("retains historical edge ordering without restoring removed public threading metadata", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const store = new Store(path);
    await store.insertAccount({
      id: "imap-account", name: "IMAP", email: "person@example.test", kind: "imap", encryptedCredentials: null,
    });
    const location = (uid: number) => ({
      accountId: "imap-account", provider: "imap" as const, mailbox: "INBOX", uidValidity: "historic-order", uid,
      modseq: null, providerId: null, read: false, flagged: false,
    });
    const [child] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{
        tenantId: "tenant-a", messageId: "<child@example.test>", inReplyTo: "<parent@example.test>",
        references: [], receivedAt: "2026-09-01T00:00:00.000Z", location: location(1),
      }],
    });
    store.close();

    const fixture = new Database(path);
    fixture.query(`
      UPDATE messages SET in_reply_to = NULL, "references" = '[]' WHERE tenant_id = ? AND id = ?
    `).run("tenant-a", child!.id);
    fixture.close();

    const repaired = new Store(path);
    const [parent] = await repaired.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{
        tenantId: "tenant-a", messageId: "<parent@example.test>", inReplyTo: null, references: [],
        receivedAt: "2026-09-02T00:00:00.000Z", location: location(2),
      }],
    });
    const repairedConversation = await repaired.getConversation("tenant-a", child!.conversationId);
    expect(parent!.conversationId).toBe(child!.conversationId);
    expect(repairedConversation?.messages.map(({ messageId }) => messageId)).toEqual([
      "<parent@example.test>", "<child@example.test>",
    ]);
    expect(repairedConversation?.messages.find(({ id }) => id === child!.id)).toMatchObject({
      inReplyTo: null,
      references: [],
    });
    repaired.close();

    const reopened = new Store(path);
    const reopenedConversation = await reopened.getConversation("tenant-a", child!.conversationId);
    expect(reopenedConversation?.messages.map(({ messageId }) => messageId)).toEqual([
      "<parent@example.test>", "<child@example.test>",
    ]);
    expect(reopenedConversation?.messages.find(({ id }) => id === child!.id)).toMatchObject({
      inReplyTo: null,
      references: [],
    });
    reopened.close();
  });

  test("repairs only the RFC component affected by a late parent", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const store = new Store(path);
    await store.insertAccount({
      id: "imap-account", name: "IMAP", email: "person@example.test", kind: "imap", encryptedCredentials: null,
    });
    const location = (uid: number) => ({
      accountId: "imap-account", provider: "imap" as const, mailbox: "INBOX", uidValidity: "1", uid,
      modseq: null, providerId: null, read: false, flagged: false,
    });
    const [unrelated] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{ tenantId: "tenant-a", messageId: "<unrelated@example.test>", inReplyTo: null,
        references: [], location: location(1) }],
    });
    const [child] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{ tenantId: "tenant-a", messageId: "<child@example.test>",
        inReplyTo: "<late-parent@example.test>", references: [], location: location(2) }],
    });
    store.close();

    const fixture = new Database(path);
    const unrelatedConversationId = unrelated!.conversationId.replaceAll("'", "''");
    fixture.exec(`
      CREATE TRIGGER reject_unrelated_conversation_reinsert
      BEFORE INSERT ON conversations WHEN NEW.id = '${unrelatedConversationId}'
      BEGIN SELECT RAISE(ABORT, 'unrelated conversation was rebuilt'); END
    `);
    fixture.close();

    const reopened = new Store(path);
    const [parent] = await reopened.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{ tenantId: "tenant-a", messageId: "<late-parent@example.test>", inReplyTo: null,
        references: [], location: location(3) }],
    });
    expect(parent!.conversationId).toBe(child!.conversationId);
    expect((await reopened.getConversation("tenant-a", unrelated!.conversationId))?.messages.map(({ id }) => id))
      .toEqual([unrelated!.id]);
    reopened.close();
  });

  test("records a location-only provider move without graph repair", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const store = new Store(path);
    await store.insertAccount({
      id: "imap-account", name: "IMAP", email: "person@example.test", kind: "imap", encryptedCredentials: null,
    });
    const [message] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [{
        tenantId: "tenant-a", messageId: "<moved@example.test>", inReplyTo: null, references: [],
        location: { accountId: "imap-account", provider: "imap", mailbox: "INBOX", uidValidity: "1", uid: 1,
          modseq: null, providerId: null, read: false, flagged: false },
      }],
    });
    store.close();
    const fixture = new Database(path);
    fixture.exec(`
      CREATE TRIGGER reject_move_conversation_rebuild
      BEFORE INSERT ON conversations
      BEGIN SELECT RAISE(ABORT, 'location move rebuilt conversations'); END;
    `);
    fixture.close();

    const reopened = new Store(path);
    expect(await reopened.recordProviderMove("tenant-a", "imap", {
      accountId: "imap-account", mailbox: "INBOX", uidValidity: "1", uid: 1, modseq: null,
    }, {
      accountId: "imap-account", mailbox: "Archive", uidValidity: "1", uid: 2, modseq: null,
    })).toBe(true);
    expect((await reopened.getMessage("tenant-a", message!.id))?.conversationId).toBe(message!.conversationId);
    reopened.close();
  });

  test("rolls back every DRA-477 schema and backfill change after a later tenant fails", () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const old = new Database(path, { create: true });
    old.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, identity_key TEXT NOT NULL,
        message_id TEXT, in_reply_to TEXT, "references" TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (tenant_id, identity_key)
      );
      INSERT INTO messages VALUES
        ('valid', 'tenant-a', 'message-id:<valid@example.test>', '<valid@example.test>', NULL, '[]',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        ('broken', 'tenant-z', 'message-id:<broken@example.test>', '<broken@example.test>', NULL, '{bad json',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `);
    old.close();

    expect(() => new Store(path)).toThrow();
    const rolledBack = new Database(path);
    expect((rolledBack.query("PRAGMA table_info('messages')").all() as Array<{ name: string }>)
      .some(({ name }) => name === "received_at")).toBe(false);
    for (const table of ["conversations", "conversation_messages", "conversation_aliases",
      "message_provider_conversations", "message_thread_edges"]) {
      expect(rolledBack.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toBeNull();
    }
    expect(rolledBack.query("SELECT 1 FROM schema_migrations WHERE version = 477").get()).toBeNull();
    rolledBack.close();
  });

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

  test("backfills durable provider associations and retains them across reopen", async () => {
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
        UNIQUE (tenant_id, identity_key), UNIQUE (tenant_id, id)
      );
      CREATE TABLE message_locations (
        id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), provider TEXT NOT NULL, mailbox TEXT NOT NULL,
        location_key TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL, modseq TEXT,
        provider_id TEXT, read INTEGER NOT NULL, flagged INTEGER NOT NULL, observed_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id, message_id) REFERENCES messages(tenant_id, id),
        UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
      );
      INSERT INTO accounts VALUES
        ('gmail-account', 'Gmail', 'person@example.test', 'gmail', NULL, '2026-09-03T00:00:00.000Z');
      INSERT INTO messages VALUES
        ('canonical', 'tenant-a', 'message-id:<legacy@example.test>', '<legacy@example.test>',
          '<parent@example.test>', '["<root@example.test>"]', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
      INSERT INTO message_locations VALUES
        ('legacy-location', 'canonical', 'tenant-a', 'gmail-account', 'gmail', 'INBOX',
          'provider-id:gmail-legacy', 'gmail', 7, NULL, 'gmail-legacy', 0, 0, '2026-09-03T00:00:00.000Z');
    `);
    old.close();

    new Store(path).close();
    const store = new Store(path);
    const [partiallyReobserved] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [{
        tenantId: "tenant-a",
        messageId: null,
        inReplyTo: null,
        references: [],
        location: {
          accountId: "gmail-account", provider: "gmail", mailbox: "INBOX", uidValidity: "gmail", uid: 7,
          modseq: "2", providerId: "gmail-legacy", read: true, flagged: true,
        },
      }],
      authoritative: false,
    });
    expect(partiallyReobserved!.id).toBe("canonical");
    expect(await store.listMessageLocations("tenant-a", "canonical")).toMatchObject([{
      id: "legacy-location", modseq: "2", read: true, flagged: true,
    }]);
    await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [], authoritative: true,
    });
    const [reappeared] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "Archive",
      observations: [{
        tenantId: "tenant-a",
        messageId: null,
        inReplyTo: null,
        references: [],
        location: {
          accountId: "gmail-account", provider: "gmail", mailbox: "Archive", uidValidity: "gmail", uid: 8,
          modseq: null, providerId: "gmail-legacy", read: true, flagged: false,
        },
      }],
      authoritative: true,
    });

    expect(reappeared).toMatchObject({
      id: "canonical",
      messageId: "<legacy@example.test>",
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>"],
    });
    store.close();
  });

  test("recovers and promotes a legacy locationless fallback from its exact observed key", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const initial = new Store(path);
    await initial.insertAccount({
      id: "gmail:legacy",
      name: "Legacy Gmail",
      email: "legacy@example.test",
      kind: "gmail",
      encryptedCredentials: null,
    });
    initial.close();
    const legacy = new Database(path);
    legacy.query(`
      INSERT INTO messages
        (id, tenant_id, identity_key, message_id, in_reply_to, "references", created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
    `).run("legacy-fallback", "tenant-a", "provider:gmail:gmail:legacy:provider-id:id:legacy",
      "<parent@example.test>", '["<root@example.test>"]',
      "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
    legacy.close();

    const store = new Store(path);
    const missing = {
      tenantId: "tenant-a",
      messageId: null,
      inReplyTo: null,
      references: [],
      location: {
        accountId: "gmail:legacy",
        provider: "gmail" as const,
        mailbox: "INBOX",
        uidValidity: "gmail",
        uid: 9,
        modseq: null,
        providerId: "id:legacy",
        read: false,
        flagged: false,
      },
    };
    const [reobserved] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail:legacy", provider: "gmail", mailbox: "INBOX",
      observations: [missing], authoritative: false,
    });
    const [promoted] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail:legacy", provider: "gmail", mailbox: "INBOX",
      observations: [{ ...missing, messageId: "<legacy-promoted@example.test>" }], authoritative: false,
    });

    expect(reobserved).toMatchObject({
      id: "legacy-fallback",
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>"],
    });
    expect(promoted).toMatchObject({ id: "legacy-fallback", messageId: "<legacy-promoted@example.test>" });
    store.close();
  });

  test("does not claim a locationless legacy key with ambiguous account boundaries", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const initial = new Store(path);
    for (const id of ["scope", "scope:provider-id:shared"]) {
      await initial.insertAccount({
        id,
        name: id,
        email: `${id}@example.test`,
        kind: "gmail",
        encryptedCredentials: null,
      });
    }
    initial.close();
    const legacy = new Database(path);
    legacy.query(`
      INSERT INTO messages
        (id, tenant_id, identity_key, message_id, in_reply_to, "references", created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, '[]', ?, ?)
    `).run("ambiguous-account-legacy", "tenant-a",
      "provider:gmail:scope:provider-id:shared:provider-id:tail",
      "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
    legacy.close();

    const store = new Store(path);
    const observation = {
      tenantId: "tenant-a",
      messageId: null,
      inReplyTo: null,
      references: [],
      location: {
        accountId: "scope",
        provider: "gmail" as const,
        mailbox: "INBOX",
        uidValidity: "gmail",
        uid: 1,
        modseq: null,
        providerId: "shared:provider-id:tail",
        read: false,
        flagged: false,
      },
    };
    const [created] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "scope", provider: "gmail", mailbox: "INBOX",
      observations: [observation], authoritative: false,
    });
    const [repeated] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "scope", provider: "gmail", mailbox: "INBOX",
      observations: [observation], authoritative: false,
    });

    expect(created!.id).not.toBe("ambiguous-account-legacy");
    expect(repeated!.id).toBe(created!.id);
    expect(await store.getMessage("tenant-a", "ambiguous-account-legacy")).not.toBeNull();
    store.close();
  });

  test("does not claim a locationless legacy key with ambiguous mailbox and UIDVALIDITY boundaries", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const initial = new Store(path);
    await initial.insertAccount({
      id: "imap-account",
      name: "IMAP",
      email: "imap@example.test",
      kind: "imap",
      encryptedCredentials: null,
    });
    initial.close();
    const legacy = new Database(path);
    legacy.query(`
      INSERT INTO messages
        (id, tenant_id, identity_key, message_id, in_reply_to, "references", created_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, '[]', ?, ?)
    `).run("ambiguous-imap-legacy", "tenant-a", "provider:imap:imap-account:imap:A:B:C:7",
      "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
    legacy.close();

    const store = new Store(path);
    const [created] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "A",
      observations: [{
        tenantId: "tenant-a",
        messageId: null,
        inReplyTo: null,
        references: [],
        location: {
          accountId: "imap-account", provider: "imap", mailbox: "A", uidValidity: "B:C", uid: 7,
          modseq: null, providerId: null, read: false, flagged: false,
        },
      }],
      authoritative: false,
    });

    expect(created!.id).not.toBe("ambiguous-imap-legacy");
    expect(await store.getMessage("tenant-a", "ambiguous-imap-legacy")).not.toBeNull();
    store.close();
  });

  test("rolls back earlier observations when a later observation fails", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const initial = new Store(path);
    await initial.insertAccount({
      id: "imap-account",
      name: "IMAP",
      email: "imap@example.test",
      kind: "imap",
      encryptedCredentials: null,
    });
    initial.close();
    const fixture = new Database(path);
    fixture.exec(`
      CREATE TRIGGER fail_second_location
      BEFORE INSERT ON message_locations
      WHEN NEW.uid = 2
      BEGIN
        SELECT RAISE(ABORT, 'fixture second observation failure');
      END;
    `);
    fixture.close();

    const store = new Store(path);
    const location = {
      accountId: "imap-account",
      provider: "imap" as const,
      mailbox: "INBOX",
      uidValidity: "10",
      modseq: null,
      providerId: null,
      read: false,
      flagged: false,
    };
    await expect(store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [
        { tenantId: "tenant-a", messageId: "<first@example.test>", inReplyTo: null, references: [],
          location: { ...location, uid: 1 } },
        { tenantId: "tenant-a", messageId: "<second@example.test>", inReplyTo: null, references: [],
          location: { ...location, uid: 2 } },
      ],
      authoritative: false,
    })).rejects.toThrow("fixture second observation failure");
    store.close();

    const rolledBack = new Database(path);
    expect(rolledBack.query("SELECT COUNT(*) AS count FROM messages").get()).toEqual({ count: 0 });
    expect(rolledBack.query("SELECT COUNT(*) AS count FROM message_locations").get()).toEqual({ count: 0 });
    expect(rolledBack.query("SELECT COUNT(*) AS count FROM message_provider_associations").get()).toEqual({ count: 0 });
    rolledBack.close();
  });

  test("rolls back provider association migration when historic locations conflict", () => {
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
        UNIQUE (tenant_id, identity_key), UNIQUE (tenant_id, id)
      );
      CREATE TABLE message_locations (
        id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id), tenant_id TEXT NOT NULL,
        account_id TEXT NOT NULL REFERENCES accounts(id), provider TEXT NOT NULL, mailbox TEXT NOT NULL,
        location_key TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL, modseq TEXT,
        provider_id TEXT, read INTEGER NOT NULL, flagged INTEGER NOT NULL, observed_at TEXT NOT NULL,
        UNIQUE (tenant_id, account_id, provider, mailbox, location_key)
      );
      INSERT INTO accounts VALUES
        ('gmail-account', 'Gmail', 'person@example.test', 'gmail', NULL, '2026-09-03T00:00:00.000Z');
      INSERT INTO messages VALUES
        ('first', 'tenant-a', 'message-id:<first@example.test>', '<first@example.test>', NULL, '[]',
          '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z'),
        ('second', 'tenant-a', 'message-id:<second@example.test>', '<second@example.test>', NULL, '[]',
          '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
      INSERT INTO message_locations VALUES
        ('first-location', 'first', 'tenant-a', 'gmail-account', 'gmail', 'INBOX', 'provider-id:shared',
          'gmail', 1, NULL, 'shared', 0, 0, '2026-09-03T00:00:00.000Z'),
        ('second-location', 'second', 'tenant-a', 'gmail-account', 'gmail', 'Archive', 'provider-id:shared',
          'gmail', 2, NULL, 'shared', 0, 0, '2026-09-03T00:01:00.000Z');
    `);
    old.close();

    expect(() => new Store(path)).toThrow("Canonical provider association migration found conflicting messages");

    const rolledBack = new Database(path);
    expect(rolledBack.query(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_provider_associations'
    `).get()).toBeNull();
    expect(rolledBack.query("SELECT version FROM schema_migrations WHERE version = 476001").get()).toBeNull();
    expect(rolledBack.query("SELECT version FROM schema_migrations WHERE version = 476").get()).toEqual({ version: 476 });
    expect(rolledBack.query("SELECT id, message_id FROM message_locations ORDER BY id").all()).toEqual([
      { id: "first-location", message_id: "first" },
      { id: "second-location", message_id: "second" },
    ]);
    rolledBack.query("UPDATE message_locations SET message_id = 'first' WHERE id = 'second-location'").run();
    rolledBack.close();

    new Store(path).close();
    const retried = new Database(path);
    expect(retried.query("SELECT version FROM schema_migrations WHERE version = 476001").get())
      .toEqual({ version: 476001 });
    expect(retried.query("SELECT COUNT(*) AS count FROM message_provider_associations").get()).toEqual({ count: 1 });
    expect(retried.query("PRAGMA foreign_key_check('message_locations')").all()).toEqual([]);
    expect(retried.query("PRAGMA foreign_key_check('message_provider_associations')").all()).toEqual([]);
    retried.close();
  });

  test("merges stored semantic Message-ID duplicates without losing aliases, relations, or historical edges", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    new Store(path).close();
    const fixture = new Database(path);
    fixture.exec(`
      DELETE FROM schema_migrations WHERE version = 477001;
      INSERT INTO accounts VALUES
        ('imap-account', 'IMAP', 'person@example.test', 'imap', NULL, '2026-09-01T00:00:00.000Z');
      INSERT INTO messages
        (id, tenant_id, identity_key, message_id, in_reply_to, "references", received_at, created_at, updated_at)
      VALUES
        ('plain', 'tenant-a', 'message-id:<ab@example.test>', '<ab@example.test>', NULL, '[]', NULL,
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        ('quoted', 'tenant-a', 'message-id:<"ab"@example.test>', '<"ab"@example.test>', NULL, '[]', NULL,
          '2026-09-01T00:01:00.000Z', '2026-09-01T00:01:00.000Z'),
        ('escaped', 'tenant-a', 'message-id:<"a\\b"@example.test>', '<"a\\b"@example.test>', NULL, '[]', NULL,
          '2026-09-01T00:02:00.000Z', '2026-09-01T00:02:00.000Z'),
        ('child', 'tenant-a', 'message-id:<child@example.test>', '<child@example.test>', '<"a\\b"@example.test>',
          json_array('<"ab"@example.test>'), NULL, '2026-09-01T00:03:00.000Z', '2026-09-01T00:03:00.000Z'),
        ('other-tenant', 'tenant-b', 'message-id:<"a\\b"@example.test>', '<"a\\b"@example.test>', NULL, '[]', NULL,
          '2026-09-01T00:04:00.000Z', '2026-09-01T00:04:00.000Z');
      INSERT INTO conversations (id, tenant_id, created_at, updated_at) VALUES
        ('conversation-plain', 'tenant-a', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        ('conversation-quoted', 'tenant-a', '2026-09-01T00:01:00.000Z', '2026-09-01T00:01:00.000Z'),
        ('conversation-escaped', 'tenant-a', '2026-09-01T00:02:00.000Z', '2026-09-01T00:02:00.000Z'),
        ('conversation-child', 'tenant-a', '2026-09-01T00:03:00.000Z', '2026-09-01T00:03:00.000Z'),
        ('conversation-other', 'tenant-b', '2026-09-01T00:04:00.000Z', '2026-09-01T00:04:00.000Z');
      INSERT INTO conversation_messages VALUES
        ('tenant-a', 'conversation-plain', 'plain'),
        ('tenant-a', 'conversation-quoted', 'quoted'),
        ('tenant-a', 'conversation-escaped', 'escaped'),
        ('tenant-a', 'conversation-child', 'child'),
        ('tenant-b', 'conversation-other', 'other-tenant');
      INSERT INTO message_aliases VALUES
        ('quoted-old-alias', 'tenant-a', 'quoted', '2026-09-01T00:01:00.000Z'),
        ('escaped-old-alias', 'tenant-a', 'escaped', '2026-09-01T00:02:00.000Z');
      INSERT INTO conversation_aliases VALUES
        ('quoted-conversation-alias', 'tenant-a', 'conversation-quoted', '2026-09-01T00:01:00.000Z');
      INSERT INTO message_locations
        (id, message_id, tenant_id, account_id, provider, mailbox, location_key, uid_validity, uid,
          modseq, provider_id, read, flagged, observed_at)
      VALUES
        ('plain-location', 'plain', 'tenant-a', 'imap-account', 'imap', 'INBOX', '["imap","INBOX","1",1]',
          '1', 1, NULL, NULL, 0, 0, '2026-09-01T00:00:00.000Z'),
        ('quoted-location', 'quoted', 'tenant-a', 'imap-account', 'imap', 'Archive', '["imap","Archive","1",2]',
          '1', 2, NULL, NULL, 0, 0, '2026-09-01T00:01:00.000Z'),
        ('escaped-location', 'escaped', 'tenant-a', 'imap-account', 'imap', 'Sent', '["imap","Sent","1",3]',
          '1', 3, NULL, NULL, 0, 0, '2026-09-01T00:02:00.000Z');
      INSERT INTO message_provider_associations
        (tenant_id, account_id, provider, provider_id, mailbox, uid_validity, uid, message_id)
      VALUES
        ('tenant-a', 'imap-account', 'imap', 'provider-plain', NULL, NULL, NULL, 'plain'),
        ('tenant-a', 'imap-account', 'imap', 'provider-quoted', NULL, NULL, NULL, 'quoted'),
        ('tenant-a', 'imap-account', 'imap', 'provider-escaped', NULL, NULL, NULL, 'escaped');
      INSERT INTO message_provider_conversations VALUES
        ('tenant-a', 'imap-account', 'imap', 'thread-plain', 'plain'),
        ('tenant-a', 'imap-account', 'imap', 'thread-quoted', 'quoted'),
        ('tenant-a', 'imap-account', 'imap', 'thread-escaped', 'escaped');
      INSERT INTO message_thread_edges VALUES
        ('tenant-a', 'child', '<"a\\b"@example.test>'),
        ('tenant-a', 'quoted', '<"h\\istoric"@example.test>');
    `);
    fixture.close();

    const migrated = new Store(path);
    const canonical = await migrated.getMessage("tenant-a", "plain");
    expect(canonical).toMatchObject({ id: "plain", messageId: "<ab@example.test>" });
    for (const alias of ["quoted", "escaped", "quoted-old-alias", "escaped-old-alias"]) {
      expect((await migrated.getMessage("tenant-a", alias))?.id).toBe("plain");
    }
    expect(await migrated.listMessageLocations("tenant-a", "plain")).toHaveLength(3);
    const conversationAliases = ["conversation-plain", "conversation-quoted", "conversation-escaped",
      "conversation-child", "quoted-conversation-alias"];
    const conversations = await Promise.all(conversationAliases.map((id) => migrated.getConversation("tenant-a", id)));
    expect(new Set(conversations.map((conversation) => conversation?.id))).toHaveLength(1);
    expect(conversations[0]!.messages.map(({ messageId }) => messageId)).toEqual([
      "<ab@example.test>", "<child@example.test>",
    ]);
    expect((await migrated.getMessage("tenant-b", "other-tenant"))?.messageId).toBe("<ab@example.test>");
    expect(await migrated.getMessage("tenant-b", "plain")).toBeNull();
    migrated.close();

    const inspected = new Database(path);
    expect(inspected.query("SELECT version FROM schema_migrations WHERE version = 477001").get())
      .toEqual({ version: 477001 });
    expect(inspected.query(`
      SELECT identity_key FROM messages WHERE identity_key LIKE 'message-id:%\\\\%' ESCAPE '\\'
    `).all()).toEqual([]);
    expect(inspected.query(`
      SELECT referenced_message_id FROM message_thread_edges WHERE tenant_id = 'tenant-a' ORDER BY referenced_message_id
    `).all()).toEqual([
      { referenced_message_id: "<ab@example.test>" },
      { referenced_message_id: "<historic@example.test>" },
    ]);
    expect(inspected.query(`
      SELECT COUNT(*) AS count FROM message_provider_associations WHERE tenant_id = 'tenant-a' AND message_id = 'plain'
    `).get()).toEqual({ count: 3 });
    expect(inspected.query(`
      SELECT COUNT(*) AS count FROM message_provider_conversations WHERE tenant_id = 'tenant-a' AND message_id = 'plain'
    `).get()).toEqual({ count: 3 });
    inspected.exec(`
      CREATE TRIGGER reject_repeated_semantic_migration BEFORE UPDATE ON messages
      BEGIN SELECT RAISE(ABORT, 'semantic migration repeated'); END;
    `);
    inspected.close();
    new Store(path).close();
  });

  test("repairs fallback-only conversations after semantic threading edges converge", async () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    const store = new Store(path);
    await store.insertAccount({
      id: "imap-account", name: "IMAP", email: "person@example.test", kind: "imap", encryptedCredentials: null,
    });
    const messages = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
      observations: [1, 2].map((uid) => ({
        tenantId: "tenant-a", messageId: null, inReplyTo: null, references: [],
        location: { accountId: "imap-account", provider: "imap" as const, mailbox: "INBOX", uidValidity: "1", uid,
          modseq: null, providerId: null, read: false, flagged: false },
      })),
    });
    const messageIds = messages.map(({ id }) => id);
    const oldConversationIds = messages.map(({ conversationId }) => conversationId);
    expect(new Set(oldConversationIds).size).toBe(2);
    store.close();

    const fixture = new Database(path);
    fixture.query("DELETE FROM schema_migrations WHERE version = 477001").run();
    const references = ['<"ab"@x.test>', '<"a\\b"@x.test>'];
    for (const [index, messageId] of messageIds.entries()) {
      fixture.query(`UPDATE messages SET "references" = json_array(?) WHERE tenant_id = ? AND id = ?`)
        .run(references[index]!, "tenant-a", messageId);
      fixture.query(`
        INSERT INTO message_thread_edges (tenant_id, message_id, referenced_message_id) VALUES (?, ?, ?)
      `).run("tenant-a", messageId, references[index]!);
    }
    fixture.close();

    const migrated = new Store(path);
    const migratedConversations = await Promise.all(oldConversationIds.map((id) =>
      migrated.getConversation("tenant-a", id)));
    expect(new Set(migratedConversations.map((conversation) => conversation?.id)).size).toBe(1);
    for (const conversation of migratedConversations) {
      expect(new Set(conversation?.messages.map(({ id }) => id))).toEqual(new Set(messageIds));
    }
    migrated.close();

    const reopened = new Store(path);
    const reopenedConversations = await Promise.all(oldConversationIds.map((id) =>
      reopened.getConversation("tenant-a", id)));
    expect(new Set(reopenedConversations.map((conversation) => conversation?.id)).size).toBe(1);
    for (const conversation of reopenedConversations) {
      expect(new Set(conversation?.messages.map(({ id }) => id))).toEqual(new Set(messageIds));
    }
    reopened.close();
  });

  test("preserves observed References evidence across every arrival order, canonical merge, and reopen", async () => {
    const sequences = [
      ["<b@order.test>"],
      ["<c@order.test>"],
      ["<c@order.test>", "<a@order.test>", "<b@order.test>"],
    ];
    const permutations = <T>(values: readonly T[]): T[][] => values.length === 0
      ? [[]]
      : values.flatMap((value, index) => permutations(values.filter((_, candidate) => candidate !== index))
        .map((rest) => [value, ...rest]));

    for (const arrivals of permutations(sequences)) {
      const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
      paths.push(path);
      const store = new Store(path);
      await store.insertAccount({
        id: "imap-account", name: "IMAP", email: "person@example.test", kind: "imap", encryptedCredentials: null,
      });
      await store.insertAccount({
        id: "gmail-account", name: "Gmail", email: "person@example.test", kind: "gmail", encryptedCredentials: null,
      });
      for (const [index, references] of arrivals.entries()) {
        await store.reconcileMailbox({
          tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
          observations: [{
            tenantId: "tenant-a", messageId: "<child@order.test>", inReplyTo: null, references,
            location: { accountId: "imap-account", provider: "imap", mailbox: "INBOX", uidValidity: "1",
              uid: index + 1, modseq: null, providerId: null, read: false, flagged: false },
          }],
        });
      }
      const [fallback] = await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX", authoritative: false,
        observations: [{
          tenantId: "tenant-a", messageId: null, inReplyTo: null, references: [],
          location: { accountId: "gmail-account", provider: "gmail", mailbox: "INBOX", uidValidity: "gmail",
            uid: 1, modseq: null, providerId: "fallback-child", read: false, flagged: false },
        }],
      });
      const [merged] = await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "Archive", authoritative: false,
        observations: [{
          tenantId: "tenant-a", messageId: "<child@order.test>", inReplyTo: null, references: [],
          location: { accountId: "gmail-account", provider: "gmail", mailbox: "Archive", uidValidity: "gmail",
            uid: 2, modseq: null, providerId: "fallback-child", read: false, flagged: false },
        }],
      });
      expect(merged!.references).toEqual(["<c@order.test>", "<a@order.test>", "<b@order.test>"]);
      expect((await store.getMessage("tenant-a", fallback!.id))?.id).toBe(merged!.id);
      await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
        observations: ["a", "b", "c"].map((name, index) => ({
          tenantId: "tenant-a", messageId: `<${name}@order.test>`, inReplyTo: null, references: [],
          receivedAt: `2026-09-0${3 - index}T00:00:00.000Z`,
          location: { accountId: "imap-account", provider: "imap" as const, mailbox: "INBOX", uidValidity: "1",
            uid: index + 10, modseq: null, providerId: null, read: false, flagged: false },
        })),
      });
      expect((await store.getConversation("tenant-a", merged!.conversationId))?.messages.map(({ messageId }) => messageId))
        .toEqual(["<c@order.test>", "<a@order.test>", "<b@order.test>", "<child@order.test>"]);
      store.close();

      const reopened = new Store(path);
      const child = await reopened.getMessage("tenant-a", merged!.id);
      expect(child?.references).toEqual(["<c@order.test>", "<a@order.test>", "<b@order.test>"]);
      expect((await reopened.getConversation("tenant-a", child!.conversationId))?.messages.map(({ messageId }) => messageId))
        .toEqual(["<c@order.test>", "<a@order.test>", "<b@order.test>", "<child@order.test>"]);
      reopened.close();
    }
  });

  test("migrates flattened legacy References as unordered parents until genuine evidence arrives", async () => {
    for (const legacyReferences of [
      ["<a@legacy.test>", "<b@legacy.test>", "<c@legacy.test>"],
      ["<c@legacy.test>", "<a@legacy.test>", "<b@legacy.test>"],
    ]) {
      const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
      paths.push(path);
      const store = new Store(path);
      await store.insertAccount({
        id: "imap-account", name: "IMAP", email: "person@example.test", kind: "imap", encryptedCredentials: null,
      });
      const [child] = await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
        observations: [{
          tenantId: "tenant-a", messageId: "<child@legacy.test>", inReplyTo: null, references: legacyReferences,
          location: { accountId: "imap-account", provider: "imap", mailbox: "INBOX", uidValidity: "1", uid: 1,
            modseq: null, providerId: null, read: false, flagged: false },
        }],
      });
      await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
        observations: ["a", "b", "c"].map((name, index) => ({
          tenantId: "tenant-a", messageId: `<${name}@legacy.test>`, inReplyTo: null, references: [],
          receivedAt: `2026-09-0${3 - index}T00:00:00.000Z`,
          location: { accountId: "imap-account", provider: "imap" as const, mailbox: "INBOX", uidValidity: "1",
            uid: index + 2, modseq: null, providerId: null, read: false, flagged: false },
        })),
      });
      store.close();

      const legacy = new Database(path);
      legacy.exec(`DROP TABLE message_reference_sequences; DELETE FROM schema_migrations WHERE version = 477002;`);
      legacy.close();

      const migrated = new Store(path);
      expect((await migrated.getConversation("tenant-a", child!.conversationId))?.messages.map(({ messageId }) => messageId))
        .toEqual(["<c@legacy.test>", "<b@legacy.test>", "<a@legacy.test>", "<child@legacy.test>"]);
      await migrated.reconcileMailbox({
        tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", authoritative: false,
        observations: [{
          tenantId: "tenant-a", messageId: "<child@legacy.test>", inReplyTo: null,
          references: ["<b@legacy.test>", "<a@legacy.test>", "<c@legacy.test>"],
          location: { accountId: "imap-account", provider: "imap", mailbox: "INBOX", uidValidity: "1", uid: 9,
            modseq: null, providerId: null, read: false, flagged: false },
        }],
      });
      migrated.close();

      const reopened = new Store(path);
      expect((await reopened.getConversation("tenant-a", child!.conversationId))?.messages.map(({ messageId }) => messageId))
        .toEqual(["<b@legacy.test>", "<a@legacy.test>", "<c@legacy.test>", "<child@legacy.test>"]);
      reopened.close();
    }
  });

  test("rolls back reference sequence schema before recording its marker", () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    new Store(path).close();
    const fixture = new Database(path);
    fixture.exec(`
      DROP TABLE message_reference_sequences;
      DELETE FROM schema_migrations WHERE version = 477002;
      CREATE TRIGGER reject_reference_sequence_marker
      BEFORE INSERT ON schema_migrations WHEN NEW.version = 477002
      BEGIN SELECT RAISE(ABORT, 'reference sequence fixture failure'); END;
    `);
    fixture.close();

    expect(() => new Store(path)).toThrow("reference sequence fixture failure");
    const rolledBack = new Database(path);
    expect(rolledBack.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_reference_sequences'")
      .get()).toBeNull();
    expect(rolledBack.query("SELECT 1 FROM schema_migrations WHERE version = 477002").get()).toBeNull();
    rolledBack.close();
  });

  test("rolls back semantic Message-ID normalization before recording its marker", () => {
    const path = join(tmpdir(), `postreeve-${crypto.randomUUID()}.sqlite`);
    paths.push(path);
    new Store(path).close();
    const fixture = new Database(path);
    fixture.exec(`
      DELETE FROM schema_migrations WHERE version = 477001;
      INSERT INTO messages
        (id, tenant_id, identity_key, message_id, in_reply_to, "references", received_at, created_at, updated_at)
      VALUES
        ('stale', 'tenant-a', 'message-id:<"a\\b"@example.test>', '<"a\\b"@example.test>', NULL, '[]', NULL,
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
        ('broken', 'tenant-z', 'message-id:<broken@example.test>', '<broken@example.test>', NULL, '[]', NULL,
          '2026-09-01T00:01:00.000Z', '2026-09-01T00:01:00.000Z');
      INSERT INTO message_thread_edges VALUES
        ('tenant-a', 'stale', '<"r\\ollback"@example.test>');
      CREATE TRIGGER reject_semantic_message_update BEFORE UPDATE ON messages WHEN OLD.id = 'broken'
      BEGIN SELECT RAISE(ABORT, 'semantic fixture failure'); END;
    `);
    fixture.close();

    expect(() => new Store(path)).toThrow("semantic fixture failure");
    const rolledBack = new Database(path);
    expect(rolledBack.query("SELECT identity_key, message_id FROM messages WHERE id = 'stale'").get()).toEqual({
      identity_key: 'message-id:<"a\\b"@example.test>', message_id: '<"a\\b"@example.test>',
    });
    expect(rolledBack.query(`
      SELECT referenced_message_id FROM message_thread_edges WHERE tenant_id = 'tenant-a' AND message_id = 'stale'
    `).get()).toEqual({ referenced_message_id: '<"r\\ollback"@example.test>' });
    expect(rolledBack.query("SELECT version FROM schema_migrations WHERE version = 477001").get()).toBeNull();
    rolledBack.close();
  });
});
