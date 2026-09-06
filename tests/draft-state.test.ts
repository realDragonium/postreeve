import { describe, expect, test } from "bun:test";
import type { Account, CreateDraftInput, Draft, DraftContent, UpdateDraftInput } from "../src/shared/contracts";
import { DraftSaveQueue, localDraftMigrationKey, migrateLocalDraftsOnce, migrationDraftId } from "../src/web/draft-state";
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
    );
    const older = content("Older body");
    const newer = content("Newest body");

    const first = queue.save(older);
    const second = queue.save(newer);
    await Promise.resolve();
    expect(creates).toEqual([{ accountId: account.id, ...older }]);
    expect(updates).toEqual([]);
    createGate.resolve(storedDraft(1, older));
    await first;
    await Promise.resolve();
    expect(updates).toEqual([{ ...newer, version: 1 }]);
    updateGate.resolve(storedDraft(2, newer));

    expect((await second).body).toBe("Newest body");
    expect(queue.current).toMatchObject({ body: "Newest body", version: 2 });
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
    expect(JSON.parse(storage.getItem(localDraftsKey) ?? "[]")).toEqual([malformed, validTwo]);
    expect(storage.getItem(localDraftMigrationKey)).toBeNull();

    failSecond = false;
    expect(await migrateLocalDraftsOnce(storage, [account], create)).toEqual({ migrated: 1, ignored: 1, retryable: 0 });
    expect(JSON.parse(storage.getItem(localDraftsKey) ?? "[]")).toEqual([malformed]);
    expect(storage.getItem(localDraftMigrationKey)).toBe("complete");
    expect(await migrateLocalDraftsOnce(storage, [account], create)).toEqual({ migrated: 0, ignored: 0, retryable: 0 });
    expect(accepted.map(({ clientId }) => clientId)).toEqual([
      await migrationDraftId(account.id, "local-one"),
      await migrationDraftId(account.id, "local-two"),
    ]);
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
  };
}

function storedDraft(
  version: number,
  input: DraftContent | CreateDraftInput,
  id = "draft-a",
): Draft {
  return {
    id,
    accountId: account.id,
    mode: input.mode,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: input.body,
    identity: input.identity,
    ...(input.source ? { source: input.source } : {}),
    delivery: { status: "editable" },
    mirror: { status: "synced", mirroredVersion: version, ref: { kind: "imap", mailbox: "Drafts", uidValidity: "1", uid: version } },
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: `2026-09-06T10:00:0${version}.000Z`,
    version,
  };
}

function localDraft(id: string, subject: string, body: string) {
  return {
    id,
    accountId: account.id,
    mode: "new",
    from: account.email,
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
