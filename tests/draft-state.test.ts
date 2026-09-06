import { describe, expect, test } from "bun:test";
import type { Account, CreateDraftInput, Draft, DraftContent, UpdateDraftInput } from "../src/shared/contracts";
import { DraftConflictError } from "../src/server/core/errors";
import {
  DraftRecoveryConflictError,
  DraftSaveQueue,
  localDraftMigrationKey,
  migrateLocalDraftsOnce,
  migrationDraftId,
} from "../src/web/draft-state";
import { localDraftsKey } from "../src/web/mail-ui-state";

const account: Account = { id: "account-a", name: "Owner", email: "owner@example.test", kind: "imap" };

describe("backend draft UI state", () => {
  test("serializes autosaves so a late older completion cannot replace newer content", async () => {
    const createGate = deferred<Draft>();
    const updateGate = deferred<Draft>();
    const creates: CreateDraftInput[] = [];
    const updates: UpdateDraftInput[] = [];
    const queue = new DraftSaveQueue(
      account.id,
      undefined,
      async (input) => {
        creates.push(structuredClone(input));
        return createGate.promise;
      },
      async (_accountId, _draftId, input) => {
        updates.push(structuredClone(input));
        return updateGate.promise;
      },
      "draft-a",
    );
    const older = content("Older body");
    const newer = content("Newest body");

    const first = queue.save(older);
    const second = queue.save(newer);
    await Promise.resolve();
    expect(creates).toEqual([{ accountId: account.id, clientId: "draft-a", ...older }]);
    expect(updates).toEqual([]);
    createGate.resolve(storedDraft(1, older));
    await first;
    await Promise.resolve();
    expect(updates).toEqual([{ ...newer, version: 1 }]);
    updateGate.resolve(storedDraft(2, newer));

    expect((await second).body).toBe("Newest body");
    expect(queue.current).toMatchObject({ body: "Newest body", version: 2 });
  });

  test("does not reconcile a lost create response over an intervening client edit", async () => {
    let backend: Draft | null = null;
    const creates: CreateDraftInput[] = [];
    const updates: UpdateDraftInput[] = [];
    let loseFirstResponse = true;
    const queue = new DraftSaveQueue(
      account.id,
      undefined,
      async (input) => {
        creates.push(structuredClone(input));
        if (!backend) backend = storedDraft(1, input, input.clientId);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("response lost after commit");
        }
        return structuredClone(backend);
      },
      async (_accountId, _draftId, input) => {
        updates.push(structuredClone(input));
        backend = storedDraft(input.version + 1, input, "lost-create-draft");
        return structuredClone(backend);
      },
      "lost-create-draft",
    );
    const firstContent = content("First saved body");

    await expect(queue.save(firstContent)).rejects.toThrow("response lost after commit");
    backend = storedDraft(2, content("Other client's edit"), "lost-create-draft");
    const latestLocalContent = content("Latest unsaved local body");
    await expect(queue.save(latestLocalContent)).rejects.toBeInstanceOf(DraftRecoveryConflictError);

    expect(creates).toEqual([
      { accountId: account.id, clientId: "lost-create-draft", ...firstContent },
      { accountId: account.id, clientId: "lost-create-draft", ...latestLocalContent },
    ]);
    expect(updates).toEqual([]);
    expect(backend).toMatchObject({ version: 2, body: "Other client's edit" });
    expect(queue.current).toBeNull();
  });

  test("does not adopt changed content while refreshing a failed send", async () => {
    const original = storedDraft(1, content("Last successfully saved body"));
    let backend = storedDraft(4, content("Other client's edit"));
    const localInput = content("Unsaved local edit");
    const queue = new DraftSaveQueue(
      account.id,
      structuredClone(original),
      async () => original,
      async (_accountId, _draftId, input) => {
        if (input.version !== backend.version) throw new DraftConflictError();
        backend = storedDraft(backend.version + 1, input);
        return structuredClone(backend);
      },
    );

    await expect(queue.refreshAfterSend(async () => structuredClone(backend)))
      .rejects.toBeInstanceOf(DraftRecoveryConflictError);
    expect(queue.current).toEqual(original);
    expect(localInput.body).toBe("Unsaved local edit");
    await expect(queue.save(localInput)).rejects.toBeInstanceOf(DraftConflictError);
    expect(backend).toMatchObject({ version: 4, body: "Other client's edit" });
  });

  test("conflicts a stale client and reopens the authoritative backend version before saving", async () => {
    let backend = storedDraft(1, content("Initial body"));
    const create = async (): Promise<Draft> => {
      throw new Error("Existing clients must update the backend draft");
    };
    const update = async (accountId: string, draftId: string, input: UpdateDraftInput): Promise<Draft> => {
      if (accountId !== backend.accountId || draftId !== backend.id) throw new Error("Wrong draft boundary");
      if (input.version !== backend.version) throw new DraftConflictError();
      backend = storedDraft(backend.version + 1, input, backend.id);
      return structuredClone(backend);
    };
    const firstClient = new DraftSaveQueue(account.id, structuredClone(backend), create, update);
    const staleClient = new DraftSaveQueue(account.id, structuredClone(backend), create, update);

    await firstClient.save(content("First client's newer body"));
    await expect(staleClient.save(content("Stale client's body"))).rejects.toBeInstanceOf(DraftConflictError);
    expect(backend).toMatchObject({ version: 2, body: "First client's newer body" });
    expect(staleClient.current).toMatchObject({ version: 1, body: "Initial body" });

    const reconstructedClient = new DraftSaveQueue(account.id, structuredClone(backend), create, update);
    expect(reconstructedClient.current).toMatchObject({ version: 2, body: "First client's newer body" });
    await reconstructedClient.save(content("Saved after reopening"));
    expect(backend).toMatchObject({ version: 3, body: "Saved after reopening" });
  });

  test("does not save unchanged reopened drafts and preserves structured fields on a body-only edit", async () => {
    const structured = storedDraft(4, {
      ...content("Original body"),
      to: [{ name: "Display Name", address: "display@example.test" }],
      cc: [{ name: "Carbon Copy", address: "cc@example.test" }],
      identity: { name: "Exact Identity", address: account.email },
      attachments: [{ name: "legacy.txt", size: 17, type: "text/plain" }],
    });
    const updates: UpdateDraftInput[] = [];
    const update = async (_accountId: string, _draftId: string, input: UpdateDraftInput): Promise<Draft> => {
      updates.push(structuredClone(input));
      return storedDraft(input.version + 1, input);
    };
    const first = new DraftSaveQueue(account.id, structuredClone(structured), async () => structured, update);
    const second = new DraftSaveQueue(account.id, structuredClone(structured), async () => structured, update);
    const unchanged: DraftContent = {
      mode: structured.mode,
      to: structured.to,
      cc: structured.cc,
      bcc: structured.bcc,
      subject: structured.subject,
      body: structured.body,
      identity: structured.identity,
      attachments: structured.attachments,
    };

    expect(first.isDirty(unchanged)).toBe(false);
    expect(second.isDirty(unchanged)).toBe(false);
    expect(updates).toEqual([]);
    const edited = await first.save({ ...unchanged, body: "Body-only edit" });

    expect(edited.version).toBe(5);
    expect(updates).toEqual([expect.objectContaining({
      to: structured.to,
      cc: structured.cc,
      identity: structured.identity,
      attachments: structured.attachments,
      body: "Body-only edit",
      version: 4,
    })]);
  });

  test("migrates valid local records once, preserves content, ignores malformed siblings, and safely retries", async () => {
    const validOne = localDraft("local-one", "  subject one  ", " body one\n");
    const validTwo = localDraft("local-two", "subject two", "body two");
    const malformed = { id: "broken", accountId: account.id, subject: 42 };
    const storage = memoryStorage({ [localDraftsKey]: JSON.stringify([validOne, malformed, validTwo]) });
    const accepted: CreateDraftInput[] = [];
    let failSecond = true;
    const create = async (input: CreateDraftInput): Promise<Draft> => {
      if (input.subject === "subject two" && failSecond) throw new Error("temporary backend failure");
      accepted.push(structuredClone(input));
      return storedDraft(1, input, input.clientId);
    };

    expect(await migrateLocalDraftsOnce(storage, [account], create)).toEqual({ migrated: 1, ignored: 1, retryable: 1 });
    expect(accepted[0]).toMatchObject({
      clientId: await migrationDraftId(account.id, "local-one"),
      subject: "  subject one  ",
      body: " body one\n",
      to: " unfinished@, person@example.test ",
    });
    expect(JSON.parse(storage.getItem(localDraftsKey) ?? "[]")).toEqual([validTwo]);
    expect(storage.getItem(localDraftMigrationKey)).toBeNull();

    failSecond = false;
    expect(await migrateLocalDraftsOnce(storage, [account], create)).toEqual({ migrated: 1, ignored: 0, retryable: 0 });
    expect(JSON.parse(storage.getItem(localDraftsKey) ?? "[]")).toEqual([]);
    expect(storage.getItem(localDraftMigrationKey)).toBe("complete");
    expect(await migrateLocalDraftsOnce(storage, [account], create)).toEqual({ migrated: 0, ignored: 0, retryable: 0 });
    expect(accepted.map(({ clientId }) => clientId)).toEqual([
      await migrationDraftId(account.id, "local-one"),
      await migrationDraftId(account.id, "local-two"),
    ]);
  });

  test("keeps valid unavailable-account drafts retryable and never resurrects accepted drafts", async () => {
    const laterAccount: Account = {
      id: "account-later",
      name: "Later Owner",
      email: "later@example.test",
      kind: "gmail",
    };
    const waiting = localDraft("waiting", "  exact subject  ", " exact body\n", laterAccount);
    const deletedLater = localDraft("deleted-later", "Delete me", "Deleted body", laterAccount);
    const storage = memoryStorage({
      [localDraftsKey]: JSON.stringify([waiting, { id: "malformed", accountId: laterAccount.id }, deletedLater]),
    });
    const accepted = new Map<string, { input: CreateDraftInput; lifecycle: "editable" | "sent" }>();
    let creates = 0;
    const create = async (input: CreateDraftInput): Promise<Draft> => {
      creates += 1;
      accepted.set(input.clientId ?? "", { input: structuredClone(input), lifecycle: "editable" });
      return storedDraft(1, input, input.clientId);
    };

    expect(await migrateLocalDraftsOnce(storage, [account], create))
      .toEqual({ migrated: 0, ignored: 1, retryable: 2 });
    expect(JSON.parse(storage.getItem(localDraftsKey) ?? "[]")).toEqual([waiting, deletedLater]);
    expect(storage.getItem(localDraftMigrationKey)).toBeNull();
    expect(creates).toBe(0);

    expect(await migrateLocalDraftsOnce(storage, [account, laterAccount], create))
      .toEqual({ migrated: 2, ignored: 0, retryable: 0 });
    const migratedId = await migrationDraftId(laterAccount.id, waiting.id);
    expect(accepted.get(migratedId)?.input).toMatchObject({
      accountId: laterAccount.id,
      clientId: migratedId,
      to: waiting.to,
      cc: waiting.cc,
      bcc: waiting.bcc,
      subject: "  exact subject  ",
      body: " exact body\n",
      identity: { name: laterAccount.name, address: laterAccount.email },
      attachments: waiting.attachments,
    });
    expect(JSON.parse(storage.getItem(localDraftsKey) ?? "[]")).toEqual([]);
    expect(storage.getItem(localDraftMigrationKey)).toBe("complete");

    const migrated = accepted.get(migratedId);
    if (!migrated) throw new Error("Expected the accepted migration");
    accepted.set(migratedId, { ...migrated, lifecycle: "sent" });
    const deletedId = await migrationDraftId(laterAccount.id, deletedLater.id);
    accepted.delete(deletedId);
    expect(await migrateLocalDraftsOnce(storage, [account, laterAccount], create))
      .toEqual({ migrated: 0, ignored: 0, retryable: 0 });
    expect(creates).toBe(2);
    expect(accepted.get(migratedId)?.lifecycle).toBe("sent");
    expect(accepted.has(deletedId)).toBe(false);
  });

  test("uses the available account identity for a legacy draft with an invalid From value", async () => {
    const legacy = { ...localDraft("invalid-from", " Authored subject ", "Authored body\n"), from: "" };
    const storage = memoryStorage({ [localDraftsKey]: JSON.stringify([legacy]) });
    const accepted: CreateDraftInput[] = [];

    const result = await migrateLocalDraftsOnce(storage, [account], async (input) => {
      accepted.push(structuredClone(input));
      return storedDraft(1, input, input.clientId);
    });

    expect(result).toEqual({ migrated: 1, ignored: 0, retryable: 0 });
    expect(accepted).toEqual([expect.objectContaining({
      identity: { name: account.name, address: account.email },
      to: legacy.to,
      cc: legacy.cc,
      bcc: legacy.bcc,
      subject: legacy.subject,
      body: legacy.body,
      attachments: legacy.attachments,
    })]);
    expect(storage.getItem(localDraftsKey)).toBe("[]");
    expect(storage.getItem(localDraftMigrationKey)).toBe("complete");
  });
});

function content(body: string): DraftContent {
  return {
    mode: "new",
    to: "unfinished@",
    cc: "",
    bcc: "",
    subject: "Subject",
    body,
    identity: { name: account.name, address: account.email },
    attachments: [],
  };
}

function storedDraft(
  version: number,
  input: DraftContent | CreateDraftInput,
  id = "draft-a",
): Draft {
  return {
    id,
    accountId: "accountId" in input ? input.accountId : account.id,
    mode: input.mode,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.body,
    identity: input.identity,
    attachments: input.attachments,
    ...(input.source ? { source: input.source } : {}),
    delivery: { status: "editable" },
    mirror: { status: "synced", mirroredVersion: version, ref: { kind: "imap", mailbox: "Drafts", uidValidity: "1", uid: version } },
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: `2026-09-06T10:00:0${version}.000Z`,
    version,
  };
}

function localDraft(id: string, subject: string, body: string, draftAccount: Account = account) {
  return {
    id,
    accountId: draftAccount.id,
    mode: "new",
    from: draftAccount.email,
    to: " unfinished@, person@example.test ",
    cc: " cc@example.test ",
    bcc: "",
    subject,
    body,
    attachments: [{ name: "metadata-only.txt", size: 12, type: "text/plain" }],
    updatedAt: "2026-09-06T10:00:00.000Z",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error("Deferred promise was not initialized");
      resolvePromise(value);
    },
  };
}

function memoryStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
