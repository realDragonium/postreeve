import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Account, CreateDraftInput, Draft, DraftContent, UpdateDraftInput } from "../src/shared/contracts";
import { AccountConflictError } from "../src/server/core/errors";
import { Store } from "../src/server/db/store";
import { MailSendPreDispatchError } from "../src/server/mail/sender";
import { DraftRecoveryConflictError, DraftSaveQueue } from "../src/web/draft-state";
import { createEmptyTestHarness, createTestHarness, testAccountInput } from "./support/test-mail";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) {
    rmSync(path, { force: true });
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  }
});

describe("server-authoritative drafts", () => {
  test("persists the complete editable contract across reopen and scopes it by tenant and account", async () => {
    const path = temporaryStore();
    const first = await createEmptyTestHarness({ storePath: path });
    const account = await first.service.createAccount(testAccountInput());
    const other = await first.service.createAccount(testAccountInput("Other", "other@example.test"));
    const created = await first.service.createDraft({
      ...draftInput(account),
      mode: "reply_all",
      source: {
        canonicalMessageId: "canonical-message",
        conversationId: "conversation",
        providerConversationId: "provider-thread",
      },
      attachments: [{ name: "legacy.txt", size: 42, type: "text/plain" }],
    });
    first.store.close();

    const reopened = await createEmptyTestHarness({ storePath: path });
    expect(await reopened.service.getDraft(account.id, created.id)).toEqual(created);
    expect(await reopened.service.listDrafts(account.id)).toEqual([created]);
    await expect(reopened.service.sendDraft(account.id, created.id, { version: created.version }))
      .rejects.toThrow("Draft attachment delivery is not supported yet");
    expect(reopened.sendAttempts).toEqual([]);
    const edited = await reopened.service.updateDraft(account.id, created.id, updateInput(created, { body: "Edited later" }));
    expect(edited.attachments).toEqual(created.attachments);
    await expect(reopened.service.getDraft(other.id, created.id)).rejects.toThrow("Draft not found");
    expect(await reopened.store.getDraft("another-tenant", account.id, created.id)).toBeNull();
    reopened.store.close();

    const inspected = new Database(path);
    expect(inspected.query("SELECT version FROM schema_migrations WHERE version = 479").get()).toEqual({ version: 479 });
    expect(inspected.query("PRAGMA foreign_key_check('drafts')").all()).toEqual([]);
    inspected.close();
  });

  test("persists raw recipient text and recovery copies it losslessly", async () => {
    const path = temporaryStore();
    const first = await createEmptyTestHarness({ storePath: path });
    const account = await first.service.createAccount(testAccountInput());
    const healthy = await first.service.createDraft(draftInput(account));
    const rawRecipients = {
      to: "  alice@ ; Bob <bob@example.test>  ",
      cc: "carol@example.test,   dave@",
      bcc: "  undisclosed; pending@  ",
    };
    const created = await first.service.createDraft({
      ...draftInput(account),
      ...rawRecipients,
      subject: "Incomplete recipients",
      body: "Keep every recipient character.",
    });
    const claim = await first.store.claimDraftSend(
      "test-tenant",
      account.id,
      created.id,
      created.version,
      new Date().toISOString(),
      "recovery-fixture",
    );
    if (claim.kind !== "claimed") throw new Error("Expected a fresh draft claim");
    const uncertain = await first.store.markDraftSendUncertain(
      "test-tenant",
      account.id,
      created.id,
      claim.draft.version,
      "Provider outcome is unknown",
      new Date().toISOString(),
      "recovery-fixture",
    );
    first.store.close();

    const reopened = await createEmptyTestHarness({ storePath: path });
    expect(await reopened.service.getDraft(account.id, created.id)).toMatchObject(rawRecipients);
    expect((await reopened.service.listDrafts(account.id)).map(({ id }) => id).sort())
      .toEqual([healthy.id, created.id].sort());
    const copy = await reopened.service.copyDraftForRecovery(account.id, created.id, { version: uncertain.version });
    expect(copy).toMatchObject({
      ...rawRecipients,
      subject: created.subject,
      body: created.body,
      delivery: { status: "editable" },
    });
    reopened.store.close();
  });

  test("accepts a stable migration identity once without overwriting the accepted content on replay", async () => {
    const harness = await createEmptyTestHarness();
    const account = await harness.service.createAccount(testAccountInput());
    const input = {
      ...draftInput(account),
      clientId: "local-stable-migration-id",
      to: " unfinished@, person@example.test ",
      subject: "  preserved subject  ",
      body: " preserved body\n",
    };
    const first = await harness.service.createDraft(input);
    const replay = await harness.service.createDraft({ ...input, subject: "must not overwrite", body: "must not overwrite" });

    expect(replay).toEqual(first);
    expect(replay).toMatchObject({
      id: input.clientId,
      to: input.to,
      subject: input.subject,
      body: input.body,
      version: 1,
    });
    expect(await harness.providerDrafts(account.id)).toHaveLength(1);
    harness.store.close();
  });

  test("atomically rejects stale edits and deletes without losing the winning content", async () => {
    const { store, service } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const draft = await service.createDraft(draftInput(account));
    const first = service.updateDraft(account.id, draft.id, updateInput(draft, { subject: "First" }));
    const second = service.updateDraft(account.id, draft.id, updateInput(draft, { subject: "Second" }));
    const results = await Promise.allSettled([first, second]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const updated = await service.getDraft(account.id, draft.id);
    expect(["First", "Second"]).toContain(updated.subject);
    expect(updated.version).toBe(2);
    await expect(service.removeDraft(account.id, draft.id, { version: draft.version }))
      .rejects.toThrow("Draft version conflict");
    expect(await service.getDraft(account.id, draft.id)).toEqual(updated);
    await service.removeDraft(account.id, draft.id, { version: updated.version });
    await expect(service.getDraft(account.id, draft.id)).rejects.toThrow("Draft not found");
    store.close();
  });

  test("atomically rejects concurrent edits from independent Store handles", async () => {
    const path = temporaryStore();
    const first = await createEmptyTestHarness({ storePath: path });
    const account = await first.service.createAccount(testAccountInput());
    const draft = await first.service.createDraft(draftInput(account));
    const second = new Store(path);
    const updatedAt = new Date().toISOString();
    const content = updateInput(draft, { subject: "Shared winner" });
    const { version, ...draftContent } = content;

    const results = await Promise.allSettled([
      first.store.updateDraft("test-tenant", account.id, draft.id, version, draftContent, updatedAt),
      second.updateDraft("test-tenant", account.id, draft.id, version, { ...draftContent, subject: "Other winner" }, updatedAt),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await first.service.getDraft(account.id, draft.id)).version).toBe(2);
    second.close();
    first.store.close();
  });

  test("keeps separate in-memory stores out of the same provider lifecycle domain", () => {
    const first = new Store(":memory:");
    const second = new Store(":memory:");
    try {
      expect(first.coordinationIdentity).not.toBe(second.coordinationIdentity);
    } finally {
      second.close();
      first.close();
    }
  });

  test("retries a lost first create response with one compose identity and the newest content", async () => {
    const harness = await createEmptyTestHarness();
    const account = await harness.service.createAccount(testAccountInput());
    let loseFirstResponse = true;
    const queue = new DraftSaveQueue(
      account.id,
      undefined,
      async (input) => {
        const created = await harness.service.createDraft(input);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("response lost after commit");
        }
        return created;
      },
      (accountId, draftId, input) => harness.service.updateDraft(accountId, draftId, input),
      "lost-create-draft",
    );
    const older = { ...draftInput(account), body: "Older committed body" };
    const { accountId: _accountId, ...olderContent } = older;

    await expect(queue.save(olderContent)).rejects.toThrow("response lost after commit");
    const newerContent = { ...olderContent, body: "Newest local body" };
    const saved = await queue.save(newerContent);
    if (saved.mirror.status !== "synced") throw new Error("Expected synced draft");

    expect(saved).toMatchObject({ id: "lost-create-draft", version: 2, body: "Newest local body" });
    expect(await harness.service.listDrafts(account.id)).toEqual([saved]);
    expect(await harness.providerDrafts(account.id)).toEqual([
      { postreeveId: saved.id, version: saved.version, ref: saved.mirror.ref },
    ]);
    expect(harness.draftMirrorAttempts.map(({ version }) => version)).toEqual([1, 1, 2]);
    harness.store.close();
  });

  test("keeps another client's edit when a lost create response is retried", async () => {
    const path = temporaryStore();
    const first = await createEmptyTestHarness({ storePath: path });
    const account = await first.service.createAccount(testAccountInput());
    const provider = first.providerForAccount(account.id);
    if (!provider) throw new Error("Expected shared provider");
    const second = await createEmptyTestHarness({
      storePath: path,
      providerForAccount: (accountId) => accountId === account.id ? provider : undefined,
    });
    let loseFirstResponse = true;
    const queue = new DraftSaveQueue(
      account.id,
      undefined,
      async (input) => {
        const created = await first.service.createDraft(input);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("response lost after commit");
        }
        return created;
      },
      (accountId, draftId, input) => first.service.updateDraft(accountId, draftId, input),
      "lost-create-with-intervening-edit",
    );
    const { accountId: _accountId, ...firstContent } = {
      ...draftInput(account),
      body: "First committed body",
    };

    await expect(queue.save(firstContent)).rejects.toThrow("response lost after commit");
    const committed = await second.service.getDraft(account.id, "lost-create-with-intervening-edit");
    const otherEdit = await second.service.updateDraft(
      account.id,
      committed.id,
      updateInput(committed, { body: "Other client's authoritative edit" }),
    );
    if (otherEdit.mirror.status !== "synced") throw new Error("Expected the other client's provider mirror");
    const latestLocalContent = { ...firstContent, body: "Latest unsaved local body" };
    await expect(queue.save(latestLocalContent)).rejects.toBeInstanceOf(DraftRecoveryConflictError);

    expect(queue.current).toBeNull();
    expect(await first.service.getDraft(account.id, otherEdit.id)).toEqual(otherEdit);
    expect(await second.service.getDraft(account.id, otherEdit.id)).toEqual(otherEdit);
    expect(await first.providerDrafts(account.id)).toEqual([
      { postreeveId: otherEdit.id, version: otherEdit.version, ref: otherEdit.mirror.ref },
    ]);
    second.store.close();
    first.store.close();
  });

  test("refreshes an advanced failed-send version before the next autosave and retry", async () => {
    let failSend = true;
    const harness = await createEmptyTestHarness({
      sendFailure: () => failSend ? new MailSendPreDispatchError("known pre-dispatch failure") : undefined,
    });
    const account = await harness.service.createAccount(testAccountInput());
    const queue = new DraftSaveQueue(
      account.id,
      undefined,
      (input) => harness.service.createDraft(input),
      (accountId, draftId, input) => harness.service.updateDraft(accountId, draftId, input),
      "failed-send-draft",
    );
    const { accountId: _accountId, ...content } = deliverableDraftInput(account);
    const saved = await queue.save(content);

    await expect(harness.service.sendDraft(account.id, saved.id, { version: saved.version }))
      .rejects.toThrow("known pre-dispatch failure");
    const refreshed = await queue.refreshAfterSend((accountId, draftId) => harness.service.getDraft(accountId, draftId));
    expect(refreshed).toMatchObject({ version: 3, delivery: { status: "failed" } });

    const edited = await queue.save({ ...content, body: "Edited after the failed attempt" });
    failSend = false;
    const receipt = await harness.service.sendDraft(account.id, edited.id, { version: edited.version });
    expect(receipt.accepted).toEqual(["recipient@example.test"]);
    expect(harness.sendAttempts).toHaveLength(2);
    expect(await harness.providerDrafts(account.id)).toEqual([]);
    expect((await harness.store.getDraft("test-tenant", account.id, edited.id))?.delivery.status).toBe("sent");
    harness.store.close();
  });

  test("keeps local input stale when another client edits before failed-send refresh", async () => {
    const path = temporaryStore();
    const first = await createEmptyTestHarness({
      storePath: path,
      sendFailure: new MailSendPreDispatchError("known pre-dispatch failure"),
    });
    const account = await first.service.createAccount(testAccountInput());
    const provider = first.providerForAccount(account.id);
    if (!provider) throw new Error("Expected shared provider");
    const second = await createEmptyTestHarness({
      storePath: path,
      providerForAccount: (accountId) => accountId === account.id ? provider : undefined,
    });
    const queue = new DraftSaveQueue(
      account.id,
      undefined,
      (input) => first.service.createDraft(input),
      (accountId, draftId, input) => first.service.updateDraft(accountId, draftId, input),
      "failed-send-with-intervening-edit",
    );
    const { accountId: _accountId, ...content } = deliverableDraftInput(account);
    const saved = await queue.save(content);

    await expect(first.service.sendDraft(account.id, saved.id, { version: saved.version }))
      .rejects.toThrow("known pre-dispatch failure");
    const failed = await second.service.getDraft(account.id, saved.id);
    expect(failed).toMatchObject({ version: 3, delivery: { status: "failed" } });
    const otherEdit = await second.service.updateDraft(
      account.id,
      failed.id,
      updateInput(failed, { body: "Other client's authoritative edit" }),
    );
    if (otherEdit.mirror.status !== "synced") throw new Error("Expected the other client's provider mirror");
    const localInput = { ...content, body: "Unsaved local edit after failure" };

    await expect(queue.refreshAfterSend((accountId, draftId) => first.service.getDraft(accountId, draftId)))
      .rejects.toBeInstanceOf(DraftRecoveryConflictError);
    expect(queue.current).toEqual(saved);
    expect(localInput.body).toBe("Unsaved local edit after failure");
    await expect(queue.save(localInput)).rejects.toThrow("Draft version conflict");
    expect(await first.service.getDraft(account.id, otherEdit.id)).toEqual(otherEdit);
    expect(await second.service.getDraft(account.id, otherEdit.id)).toEqual(otherEdit);
    expect(await first.providerDrafts(account.id)).toEqual([
      { postreeveId: otherEdit.id, version: otherEdit.version, ref: otherEdit.mirror.ref },
    ]);
    expect(first.sendAttempts).toHaveLength(1);
    second.store.close();
    first.store.close();
  });

  test("lists and removes a shared backend draft freshly through a second service handle", async () => {
    const path = temporaryStore();
    const first = await createEmptyTestHarness({ storePath: path });
    const account = await first.service.createAccount(testAccountInput());
    const provider = first.providerForAccount(account.id);
    if (!provider) throw new Error("Expected shared provider");
    const second = await createEmptyTestHarness({
      storePath: path,
      providerForAccount: (accountId) => accountId === account.id ? provider : undefined,
    });

    const created = await first.service.createDraft({
      ...draftInput(account),
      to: [{ name: "Display Name", address: "display@example.test" }],
      body: "Visible across clients",
      identity: { name: "Exact Identity", address: account.email },
      attachments: [{ name: "legacy.txt", size: 42, type: "text/plain" }],
    });
    const firstSnapshot = await first.service.getDraft(account.id, created.id);
    const secondSnapshot = (await second.service.listDrafts(account.id))[0];
    if (!secondSnapshot) throw new Error("Expected shared draft snapshot");
    const firstQueue = new DraftSaveQueue(
      account.id,
      firstSnapshot,
      (input) => first.service.createDraft(input),
      (accountId, draftId, input) => first.service.updateDraft(accountId, draftId, input),
    );
    const secondQueue = new DraftSaveQueue(
      account.id,
      secondSnapshot,
      (input) => second.service.createDraft(input),
      (accountId, draftId, input) => second.service.updateDraft(accountId, draftId, input),
    );
    const unchanged = contentOf(created);
    const mirrorAttempts = first.draftMirrorAttempts.length;
    expect(firstQueue.isDirty(unchanged)).toBe(false);
    expect(secondQueue.isDirty(unchanged)).toBe(false);
    expect(first.draftMirrorAttempts).toHaveLength(mirrorAttempts);

    const edited = await firstQueue.save({ ...unchanged, body: "Body-only cross-client edit" });
    expect(edited).toMatchObject({
      to: created.to,
      identity: created.identity,
      attachments: created.attachments,
      version: created.version + 1,
    });
    const reopened = await second.service.getDraft(account.id, created.id);
    expect(reopened).toEqual(edited);
    await second.service.removeDraft(account.id, reopened.id, { version: reopened.version });
    expect(await first.service.listDrafts(account.id)).toEqual([]);
    expect(await first.providerDrafts(account.id)).toEqual([]);
    second.store.close();
    first.store.close();
  });

  test("disconnect waits for an in-flight mirror, deletes only local state, and leaves provider mail untouched", async () => {
    const path = temporaryStore();
    let releaseMirror: () => void = () => {};
    let markMirrorStarted: () => void = () => {};
    const mirrorGate = new Promise<void>((resolve) => { releaseMirror = resolve; });
    const mirrorStarted = new Promise<void>((resolve) => { markMirrorStarted = resolve; });
    const removedDrafts: string[] = [];
    const first = await createEmptyTestHarness({
      storePath: path,
      onDraftMirror: async (draft) => {
        if (draft.id !== "disconnect-race") return;
        markMirrorStarted();
        await mirrorGate;
      },
      onDraftRemove: (draftId) => { removedDrafts.push(draftId); },
    });
    const account = await first.service.createAccount(testAccountInput());
    const provider = first.providerForAccount(account.id);
    if (!provider) throw new Error("Expected shared provider");
    const second = await createEmptyTestHarness({
      storePath: path,
      providerForAccount: (accountId) => accountId === account.id ? provider : undefined,
    });

    const creating = first.service.createDraft({
      ...draftInput(account),
      clientId: "disconnect-race",
      body: "Provider residue is intentional",
    });
    await mirrorStarted;
    let disconnected = false;
    const disconnecting = second.service.removeAccount(account.id).then(() => { disconnected = true; });
    await Promise.resolve();
    expect(disconnected).toBe(false);
    releaseMirror();
    const created = await creating;
    if (created.mirror.status !== "synced") throw new Error("Expected synced provider residue");
    await disconnecting;

    expect(removedDrafts).toEqual([]);
    expect(await provider.listDrafts(account.id)).toEqual([
      { postreeveId: created.id, version: created.version, ref: created.mirror.ref },
    ]);
    expect(await first.store.getAccount(account.id)).toBeNull();
    expect(await second.store.getDraft("test-tenant", account.id, created.id)).toBeNull();
    second.store.close();
    first.store.close();
  });

  test("disconnect does not retry deletion of sent provider-draft residue", async () => {
    const removedDrafts: string[] = [];
    let failRemoval = true;
    const harness = await createEmptyTestHarness({
      onDraftRemove: (draftId) => { removedDrafts.push(draftId); },
      draftRemoveFailure: () => failRemoval ? new Error("cleanup unavailable") : undefined,
    });
    const account = await harness.service.createAccount(testAccountInput());
    const provider = harness.providerForAccount(account.id);
    if (!provider) throw new Error("Expected provider");
    const draft = await harness.service.createDraft(deliverableDraftInput(account));
    const receipt = await harness.service.sendDraft(account.id, draft.id, { version: draft.version });
    expect(receipt.warning).toContain("provider draft could not be removed");
    expect(removedDrafts).toEqual([draft.id]);

    failRemoval = false;
    await harness.service.removeAccount(account.id);
    expect(removedDrafts).toEqual([draft.id]);
    expect(await provider.listDrafts(account.id)).toHaveLength(1);
    expect(await harness.store.getAccount(account.id)).toBeNull();
    expect(await harness.store.getDraft("test-tenant", account.id, draft.id)).toBeNull();
    harness.store.close();
  });

  test("serializes provider lifecycle mutations across services sharing one database", async () => {
    const path = temporaryStore();
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let blockVersionOne = false;
    let activeMutations = 0;
    let maxConcurrentMutations = 0;
    const providerVersionsBeforeRemoval: number[][] = [];
    let inspectProvider = async (): Promise<Array<{ version: number }>> => [];
    const enterMutation = (): void => {
      activeMutations += 1;
      maxConcurrentMutations = Math.max(maxConcurrentMutations, activeMutations);
    };
    const leaveMutation = (): void => {
      activeMutations -= 1;
    };
    const first = await createEmptyTestHarness({
      storePath: path,
      onDraftMirror: async (draft) => {
        enterMutation();
        try {
          if (blockVersionOne && draft.version === 1) {
            blockVersionOne = false;
            markFirstStarted?.();
            await firstGate;
          }
        } finally {
          leaveMutation();
        }
      },
      onDraftRemove: async () => {
        enterMutation();
        try {
          providerVersionsBeforeRemoval.push((await inspectProvider()).map(({ version }) => version));
        } finally {
          leaveMutation();
        }
      },
    });
    const account = await first.service.createAccount(testAccountInput());
    const sharedProvider = first.providerForAccount(account.id);
    if (!sharedProvider) throw new Error("Expected the shared provider boundary");
    inspectProvider = async () => first.providerDrafts(account.id);
    const equivalentPath = `${dirname(path)}/./${basename(path)}`;
    const second = await createEmptyTestHarness({
      storePath: equivalentPath,
      providerForAccount: (accountId) => accountId === account.id ? sharedProvider : undefined,
    });
    expect(second.store.coordinationIdentity).toBe(first.store.coordinationIdentity);

    blockVersionOne = true;
    const creating = first.service.createDraft({
      ...draftInput(account),
      clientId: "shared-process-draft",
      body: "Older body",
    });
    await firstStarted;
    const original = await second.store.getDraft("test-tenant", account.id, "shared-process-draft");
    if (!original) throw new Error("Expected the authoritative draft before provider completion");
    const editing = second.service.updateDraft(
      account.id,
      original.id,
      updateInput(original, { body: "Newer authoritative body" }),
    );
    const staleRemoval = first.service.removeDraft(account.id, original.id, { version: original.version });
    await Promise.resolve();

    expect(activeMutations).toBe(1);
    expect(maxConcurrentMutations).toBe(1);
    releaseFirst?.();
    const [createdResult, editedResult] = await Promise.all([creating, editing]);
    await expect(staleRemoval).rejects.toThrow("Draft version conflict");
    await first.service.removeDraft(account.id, original.id, { version: editedResult.version });

    expect(createdResult).toMatchObject({ version: 1, body: "Older body" });
    expect(editedResult).toMatchObject({ version: 2, body: "Newer authoritative body" });
    expect(providerVersionsBeforeRemoval).toEqual([[2]]);
    expect(maxConcurrentMutations).toBe(1);
    expect(activeMutations).toBe(0);
    expect(await first.providerDrafts(account.id)).toEqual([]);
    expect(await first.store.getDraft("test-tenant", account.id, original.id)).toBeNull();
    expect(await second.store.getDraft("test-tenant", account.id, original.id)).toBeNull();
    second.store.close();
    first.store.close();
  });

  test("rejects future and stale send versions before incomplete content validation", async () => {
    const { store, service, sendAttempts } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const draft = await service.createDraft(draftInput(account));

    await expect(service.sendDraft(account.id, draft.id, { version: draft.version + 1 }))
      .rejects.toThrow("Draft version conflict");
    const updated = await service.updateDraft(account.id, draft.id, updateInput(draft));
    await expect(service.sendDraft(account.id, draft.id, { version: draft.version }))
      .rejects.toThrow("Draft version conflict");
    expect(updated.version).toBe(2);
    expect(sendAttempts).toHaveLength(0);
    store.close();
  });

  test("validates raw recipients only for sending without rewriting the durable draft", async () => {
    const { store, service, sendAttempts } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const draft = await service.createDraft({
      ...deliverableDraftInput(account),
      to: "  alice@  ",
      cc: " valid@example.test, pending@ ",
      bcc: "",
    });

    await expect(service.sendDraft(account.id, draft.id, { version: draft.version })).rejects.toThrow();
    expect(await service.getDraft(account.id, draft.id)).toEqual(draft);
    expect(sendAttempts).toHaveLength(0);

    const correctedRecipients = {
      to: " alice@example.test, bob@example.test ",
      cc: " carol@example.test ",
      bcc: "",
    };
    const corrected = await service.updateDraft(account.id, draft.id, updateInput(draft, correctedRecipients));
    const receipt = await service.sendDraft(account.id, draft.id, { version: corrected.version });
    expect(receipt.accepted).toEqual([
      "alice@example.test",
      "bob@example.test",
      "carol@example.test",
    ]);
    expect(sendAttempts).toEqual([expect.objectContaining({
      to: [
        { name: "", address: "alice@example.test" },
        { name: "", address: "bob@example.test" },
      ],
      cc: [{ name: "", address: "carol@example.test" }],
      bcc: [],
    })]);
    expect(await service.getDraft(account.id, draft.id)).toMatchObject(correctedRecipients);
    store.close();
  });

  test("does not dispatch a fetched snapshot updated by another client during send preflight", async () => {
    const { store, service, sendAttempts } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const draft = await service.createDraft(deliverableDraftInput(account));
    const claimDraftSend = store.claimDraftSend.bind(store);
    let releaseClaim: () => void = () => {};
    let markClaimReached: () => void = () => {};
    const claimWait = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const claimReached = new Promise<void>((resolve) => { markClaimReached = resolve; });
    store.claimDraftSend = async (tenantId, accountId, id, expectedVersion, claimedAt, claimOwner) => {
      markClaimReached();
      await claimWait;
      return claimDraftSend(tenantId, accountId, id, expectedVersion, claimedAt, claimOwner);
    };

    const sending = service.sendDraft(account.id, draft.id, { version: draft.version });
    await claimReached;
    const updated = await service.updateDraft(account.id, draft.id, updateInput(draft, { subject: "Newer content" }));
    releaseClaim();
    await expect(sending).rejects.toThrow("Draft version conflict");
    expect(sendAttempts).toHaveLength(0);

    store.claimDraftSend = claimDraftSend;
    await service.sendDraft(account.id, draft.id, { version: updated.version });
    expect(sendAttempts.map(({ subject }) => subject)).toEqual(["Newer content"]);
    store.close();
  });

  test("claims once across concurrent send and delete requests, settles, and replays the receipt after restart", async () => {
    const path = temporaryStore();
    let releaseSend: () => void = () => {};
    let markAttempted: () => void = () => {};
    const sendWait = new Promise<void>((resolve) => { releaseSend = resolve; });
    const attempted = new Promise<void>((resolve) => { markAttempted = resolve; });
    const first = await createEmptyTestHarness({ storePath: path, sendWait, onSendAttempt: markAttempted });
    const account = await first.service.createAccount(testAccountInput());
    const draft = await first.service.createDraft(deliverableDraftInput(account));

    const sending = first.service.sendDraft(account.id, draft.id, { version: draft.version });
    await attempted;
    await expect(first.service.sendDraft(account.id, draft.id, { version: draft.version }))
      .rejects.toThrow("Draft version conflict");
    await expect(first.service.updateDraft(account.id, draft.id, updateInput(draft, { subject: "Too late" })))
      .rejects.toThrow("Draft version conflict");
    await expect(first.service.removeDraft(account.id, draft.id, { version: draft.version }))
      .rejects.toThrow("Draft version conflict");
    const second = await createEmptyTestHarness({ storePath: path });
    expect(await second.service.recoverInterruptedDraftSends()).toEqual([]);
    expect(await second.service.getDraft(account.id, draft.id)).toMatchObject({
      version: 2,
      delivery: { status: "sending" },
    });
    expect(first.sendAttempts).toHaveLength(1);

    releaseSend();
    const receipt = await sending;
    const settled = await first.service.getDraft(account.id, draft.id);
    expect(settled.delivery).toEqual({ status: "sent", settledAt: receipt.submittedAt, receipt });
    expect(await second.service.getDraft(account.id, draft.id)).toEqual(settled);
    expect(await first.service.listDrafts(account.id)).toEqual([]);
    second.store.close();
    first.store.close();

    const reopened = await createEmptyTestHarness({ storePath: path });
    expect(await reopened.service.sendDraft(account.id, draft.id, { version: draft.version })).toEqual(receipt);
    expect(reopened.sendAttempts).toHaveLength(0);
    reopened.store.close();
  });

  for (const outcome of ["accepted", "uncertain"] as const) {
    test(`blocks account removal during an active send and preserves its ${outcome} outcome`, async () => {
      const path = temporaryStore();
      let releaseSend: () => void = () => {};
      let markAttempted: () => void = () => {};
      const sendWait = new Promise<void>((resolve) => { releaseSend = resolve; });
      const attempted = new Promise<void>((resolve) => { markAttempted = resolve; });
      const first = await createEmptyTestHarness({
        storePath: path,
        sendWait,
        onSendAttempt: markAttempted,
        ...(outcome === "uncertain" ? { sendFailure: new Error("provider outcome is ambiguous") } : {}),
      });
      const account = await first.service.createAccount(testAccountInput());
      const unrelated = await first.service.createAccount(testAccountInput("Other", "other@example.test"));
      const active = await first.service.createDraft(deliverableDraftInput(account));
      const editable = await first.service.createDraft(draftInput(account));
      const failedDraft = await first.service.createDraft({ ...deliverableDraftInput(account), subject: "Failed" });
      const failedClaim = await first.store.claimDraftSend(
        "test-tenant",
        account.id,
        failedDraft.id,
        failedDraft.version,
        new Date().toISOString(),
        "fixture-failed",
      );
      if (failedClaim.kind !== "claimed") throw new Error("Expected a fresh draft claim");
      await first.store.markDraftSendFailed(
        "test-tenant",
        account.id,
        failedDraft.id,
        failedClaim.draft.version,
        "Known pre-dispatch failure",
        new Date().toISOString(),
        "fixture-failed",
      );
      const unrelatedDraft = await first.service.createDraft(draftInput(unrelated));

      const sending = first.service.sendDraft(account.id, active.id, { version: active.version });
      await attempted;
      const second = await createEmptyTestHarness({ storePath: path });
      const claimed = await second.service.getDraft(account.id, active.id);
      await expect(second.service.removeAccount(account.id)).rejects.toBeInstanceOf(AccountConflictError);
      expect(await second.service.getDraft(account.id, active.id)).toEqual(claimed);
      expect(await second.store.getAccount(account.id)).not.toBeNull();

      await second.service.removeAccount(unrelated.id);
      expect(await second.store.getAccount(unrelated.id)).toBeNull();
      expect(await second.store.getDraft("test-tenant", unrelated.id, unrelatedDraft.id)).toBeNull();

      releaseSend();
      if (outcome === "accepted") {
        const receipt = await sending;
        expect((await second.service.getDraft(account.id, active.id)).delivery)
          .toEqual({ status: "sent", settledAt: receipt.submittedAt, receipt });
        expect(await second.service.sendDraft(account.id, active.id, { version: active.version })).toEqual(receipt);
      } else {
        await expect(sending).rejects.toThrow("provider outcome is ambiguous");
        expect(await second.service.getDraft(account.id, active.id)).toMatchObject({
          body: active.body,
          delivery: { status: "uncertain", error: "provider outcome is ambiguous" },
        });
      }
      expect(first.sendAttempts).toHaveLength(1);

      await second.service.removeAccount(account.id);
      expect(await second.store.getAccount(account.id)).toBeNull();
      for (const draftId of [active.id, editable.id, failedDraft.id]) {
        expect(await second.store.getDraft("test-tenant", account.id, draftId)).toBeNull();
      }
      second.store.close();
      first.store.close();
    });
  }

  test("does not dispatch when account removal wins before the send claim", async () => {
    const path = temporaryStore();
    const first = await createEmptyTestHarness({ storePath: path });
    const account = await first.service.createAccount(testAccountInput());
    const draft = await first.service.createDraft(deliverableDraftInput(account));
    const claimDraftSend = first.store.claimDraftSend.bind(first.store);
    let releaseClaim: () => void = () => {};
    let markClaimReached: () => void = () => {};
    const claimWait = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const claimReached = new Promise<void>((resolve) => { markClaimReached = resolve; });
    first.store.claimDraftSend = async (tenantId, accountId, id, expectedVersion, claimedAt, claimOwner) => {
      markClaimReached();
      await claimWait;
      return claimDraftSend(tenantId, accountId, id, expectedVersion, claimedAt, claimOwner);
    };

    const sending = first.service.sendDraft(account.id, draft.id, { version: draft.version });
    await claimReached;
    const second = await createEmptyTestHarness({ storePath: path });
    await second.service.removeAccount(account.id);
    releaseClaim();

    await expect(sending).rejects.toThrow("Draft not found");
    expect(first.sendAttempts).toHaveLength(0);
    expect(await second.store.getAccount(account.id)).toBeNull();
    expect(await second.store.getDraft("test-tenant", account.id, draft.id)).toBeNull();
    second.store.close();
    first.store.close();
  });

  test("retains uncertain delivery without permitting an automatic retry", async () => {
    const path = temporaryStore();
    const first = await createEmptyTestHarness({
      storePath: path,
      sendFailure: new Error("connection ended after submission"),
    });
    const account = await first.service.createAccount(testAccountInput());
    const draft = await first.service.createDraft(deliverableDraftInput(account));

    await expect(first.service.sendDraft(account.id, draft.id, { version: draft.version }))
      .rejects.toThrow("connection ended after submission");
    const uncertain = await first.service.getDraft(account.id, draft.id);
    expect(uncertain).toMatchObject({
      body: draft.body,
      version: 3,
      delivery: { status: "uncertain", error: "connection ended after submission" },
    });
    expect(await first.service.listDrafts(account.id)).toEqual([uncertain]);
    expect(first.sendAttempts).toHaveLength(1);
    first.store.close();

    const reopened = await createEmptyTestHarness({ storePath: path });
    await expect(reopened.service.sendDraft(account.id, draft.id, { version: uncertain.version }))
      .rejects.toThrow("cannot be retried automatically");
    expect(reopened.sendAttempts).toHaveLength(0);
    reopened.store.close();
  });

  test("normalizes empty provider errors without hiding healthy drafts", async () => {
    const { store, service } = await createEmptyTestHarness({ sendFailure: new Error("") });
    const account = await service.createAccount(testAccountInput());
    const healthy = await service.createDraft(draftInput(account));
    const uncertainDraft = await service.createDraft(deliverableDraftInput(account));

    await expect(service.sendDraft(account.id, uncertainDraft.id, { version: uncertainDraft.version })).rejects.toThrow();
    const uncertain = await service.getDraft(account.id, uncertainDraft.id);
    expect(uncertain.delivery).toMatchObject({
      status: "uncertain",
      error: "Unknown mail provider failure",
    });
    expect((await service.listDrafts(account.id)).map(({ id }) => id).sort())
      .toEqual([healthy.id, uncertain.id].sort());
    store.close();
  });

  test("normalizes whitespace-only errors at both Store delivery transitions", async () => {
    const { store, service } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const uncertainDraft = await service.createDraft(deliverableDraftInput(account));
    const failedDraft = await service.createDraft({ ...deliverableDraftInput(account), subject: "Known failure" });
    const uncertainClaim = await store.claimDraftSend(
      "test-tenant",
      account.id,
      uncertainDraft.id,
      uncertainDraft.version,
      new Date().toISOString(),
      "direct-uncertain",
    );
    const failedClaim = await store.claimDraftSend(
      "test-tenant",
      account.id,
      failedDraft.id,
      failedDraft.version,
      new Date().toISOString(),
      "direct-failed",
    );
    if (uncertainClaim.kind !== "claimed" || failedClaim.kind !== "claimed") {
      throw new Error("Expected fresh draft claims");
    }

    const uncertain = await store.markDraftSendUncertain(
      "test-tenant",
      account.id,
      uncertainDraft.id,
      uncertainClaim.draft.version,
      "   ",
      new Date().toISOString(),
      "direct-uncertain",
    );
    const failed = await store.markDraftSendFailed(
      "test-tenant",
      account.id,
      failedDraft.id,
      failedClaim.draft.version,
      "\t",
      new Date().toISOString(),
      "direct-failed",
    );

    expect(uncertain.delivery).toMatchObject({ status: "uncertain", error: "Delivery outcome is uncertain" });
    expect(failed.delivery).toMatchObject({ status: "failed", error: "Delivery failed before provider submission" });
    expect(await service.listDrafts(account.id)).toHaveLength(2);
    store.close();
  });

  test("recovers a prior-process claim as uncertain and copies its content without resending", async () => {
    const path = temporaryStore();
    const first = await createEmptyTestHarness({ storePath: path });
    const account = await first.service.createAccount(testAccountInput());
    const draft = await first.service.createDraft(deliverableDraftInput(account));
    const claim = await first.store.claimDraftSend(
      "test-tenant",
      account.id,
      draft.id,
      draft.version,
      new Date().toISOString(),
      "prior-process",
    );
    expect(claim.kind).toBe("claimed");
    first.store.close();

    const reopened = await createEmptyTestHarness({ storePath: path });
    const recovered = await reopened.service.recoverInterruptedDraftSends();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      id: draft.id,
      body: draft.body,
      version: 3,
      delivery: { status: "uncertain", error: "Delivery was interrupted before its outcome could be recorded" },
    });
    await expect(reopened.service.sendDraft(account.id, draft.id, { version: recovered[0]!.version }))
      .rejects.toThrow("cannot be retried automatically");
    const other = await reopened.service.createAccount(testAccountInput("Other", "other@example.test"));
    await expect(reopened.service.copyDraftForRecovery(other.id, draft.id, { version: recovered[0]!.version }))
      .rejects.toThrow("Draft not found");
    const copy = await reopened.service.copyDraftForRecovery(account.id, draft.id, { version: recovered[0]!.version });
    expect(copy).toMatchObject({
      accountId: account.id,
      body: draft.body,
      subject: draft.subject,
      delivery: { status: "editable" },
      version: 1,
    });
    expect(copy.id).not.toBe(draft.id);
    const original = await reopened.service.getDraft(account.id, draft.id);
    expect(original).toMatchObject({ version: 4, delivery: recovered[0]!.delivery });
    await expect(reopened.service.copyDraftForRecovery(account.id, draft.id, { version: recovered[0]!.version }))
      .rejects.toThrow("Draft version conflict");
    expect(reopened.sendAttempts).toHaveLength(0);
    reopened.store.close();
  });

  test("handles partial acceptance as settled and full rejection as safely retryable failure", async () => {
    const partial = await createEmptyTestHarness({ rejectRecipients: ["rejected@example.test"] });
    const account = await partial.service.createAccount(testAccountInput());
    const partialDraft = await partial.service.createDraft({
      ...deliverableDraftInput(account),
      to: [
        { name: "Accepted", address: "accepted@example.test" },
        { name: "Rejected", address: "rejected@example.test" },
      ],
    });
    const partialReceipt = await partial.service.sendDraft(account.id, partialDraft.id, { version: 1 });
    expect(partialReceipt).toMatchObject({
      accepted: ["accepted@example.test"],
      rejected: ["rejected@example.test"],
    });
    expect((await partial.service.getDraft(account.id, partialDraft.id)).delivery.status).toBe("sent");
    partial.store.close();

    const rejected = await createEmptyTestHarness({ rejectRecipients: ["recipient@example.test"] });
    const rejectedAccount = await rejected.service.createAccount(testAccountInput());
    const rejectedDraft = await rejected.service.createDraft(deliverableDraftInput(rejectedAccount));
    const rejectedReceipt = await rejected.service.sendDraft(rejectedAccount.id, rejectedDraft.id, { version: 1 });
    expect(rejectedReceipt.accepted).toEqual([]);
    const failed = await rejected.service.getDraft(rejectedAccount.id, rejectedDraft.id);
    expect(failed.delivery).toMatchObject({
      status: "failed",
      error: "No recipients were accepted for delivery",
      receipt: rejectedReceipt,
    });
    await rejected.service.sendDraft(rejectedAccount.id, rejectedDraft.id, { version: failed.version });
    expect(rejected.sendAttempts).toHaveLength(2);
    rejected.store.close();
  });

  test("keeps proven pre-dispatch failures retryable and post-accept persistence failures uncertain", async () => {
    const { store, service, sendAttempts } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const incomplete = await service.createDraft(draftInput(account));
    await expect(service.sendDraft(account.id, incomplete.id, { version: incomplete.version })).rejects.toThrow();
    expect(await service.getDraft(account.id, incomplete.id)).toEqual(incomplete);
    expect(sendAttempts).toHaveLength(0);

    const preDispatch = await createEmptyTestHarness({
      sendFailure: new MailSendPreDispatchError("message construction failed"),
    });
    const preDispatchAccount = await preDispatch.service.createAccount(testAccountInput());
    const retryable = await preDispatch.service.createDraft(deliverableDraftInput(preDispatchAccount));
    await expect(preDispatch.service.sendDraft(preDispatchAccount.id, retryable.id, { version: retryable.version }))
      .rejects.toThrow("message construction failed");
    const failed = await preDispatch.service.getDraft(preDispatchAccount.id, retryable.id);
    expect(failed.delivery).toEqual({
      status: "failed",
      failedAt: expect.any(String),
      error: "message construction failed",
    });
    expect(await preDispatch.service.updateDraft(
      preDispatchAccount.id,
      retryable.id,
      updateInput(failed, { body: "Corrected content" }),
    )).toMatchObject({ body: "Corrected content", delivery: { status: "editable" } });
    preDispatch.store.close();

    const deliverable = await service.createDraft(deliverableDraftInput(account));
    store.settleDraftSend = async () => {
      throw new Error("fixture settlement failure");
    };
    const receipt = await service.sendDraft(account.id, deliverable.id, { version: deliverable.version });
    expect(receipt.accepted).toEqual(["recipient@example.test"]);
    expect(receipt.warning).toContain("local draft receipt could not be stored");
    const uncertain = await service.getDraft(account.id, deliverable.id);
    expect(uncertain.delivery).toMatchObject({
      status: "uncertain",
      error: "Delivery was accepted, but its receipt could not be stored",
    });
    await expect(service.sendDraft(account.id, deliverable.id, { version: uncertain.version }))
      .rejects.toThrow("cannot be retried automatically");
    expect(sendAttempts).toHaveLength(1);
    store.close();
  });

  test("rejects a receipt for another account before conversation mutation and at Store settlement", async () => {
    const reply = await createTestHarness({ receiptAccountId: "another-account" });
    const source = reply.messages[0]!;
    const draft = await reply.service.createDraft({
      ...deliverableDraftInput(reply.account),
      mode: "reply",
      source: { canonicalMessageId: source.canonicalId, conversationId: source.conversationId },
    });
    let conversationWrites = 0;
    const recordConversationSend = reply.store.recordConversationSend.bind(reply.store);
    reply.store.recordConversationSend = async (...args) => {
      conversationWrites += 1;
      return recordConversationSend(...args);
    };

    await expect(reply.service.sendDraft(reply.account.id, draft.id, { version: draft.version }))
      .rejects.toThrow("receipt for another account");
    expect(conversationWrites).toBe(0);
    expect((await reply.service.getDraft(reply.account.id, draft.id)).delivery.status).toBe("uncertain");
    reply.store.close();

    const direct = await createEmptyTestHarness();
    const account = await direct.service.createAccount(testAccountInput());
    const storedDraft = await direct.service.createDraft(deliverableDraftInput(account));
    const claim = await direct.store.claimDraftSend(
      "test-tenant",
      account.id,
      storedDraft.id,
      storedDraft.version,
      new Date().toISOString(),
      "direct-claim",
    );
    if (claim.kind !== "claimed") throw new Error("Expected a fresh claim");
    await expect(direct.store.settleDraftSend(
      "test-tenant",
      account.id,
      storedDraft.id,
      claim.draft.version,
      {
        id: "wrong-account-receipt",
        accountId: "another-account",
        messageId: "<wrong-account@example.test>",
        accepted: ["recipient@example.test"],
        rejected: [],
        submittedAt: new Date().toISOString(),
      },
      "direct-claim",
    )).rejects.toThrow("belongs to another account");
    expect((await direct.service.getDraft(account.id, storedDraft.id)).delivery.status).toBe("sending");
    direct.store.close();
  });

  test("settles accepted delivery even when local conversation history cannot be recorded", async () => {
    const { store, service, account, messages, sendAttempts } = await createTestHarness();
    const source = messages[0]!;
    const draft = await service.createDraft({
      ...deliverableDraftInput(account),
      mode: "reply",
      source: {
        canonicalMessageId: source.canonicalId,
        conversationId: source.conversationId,
      },
    });
    store.recordConversationSend = async () => {
      throw new Error("fixture conversation persistence failure");
    };

    const receipt = await service.sendDraft(account.id, draft.id, { version: draft.version });
    expect(receipt.warning).toContain("accepted for delivery");
    const settled = await service.getDraft(account.id, draft.id);
    expect(settled.delivery).toMatchObject({ status: "sent", receipt });
    expect(sendAttempts).toHaveLength(1);
    expect(await service.sendDraft(account.id, draft.id, { version: draft.version })).toEqual(receipt);
    expect(sendAttempts).toHaveLength(1);
    store.close();
  });

  test("repairs a stale mirror completion to the winning edited version", async () => {
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let blockFirst = true;
    const harness = await createEmptyTestHarness({
      onDraftMirror: async (draft) => {
        if (draft.version !== 1 || !blockFirst) return;
        blockFirst = false;
        markStarted?.();
        await firstGate;
      },
    });
    const account = await harness.service.createAccount(testAccountInput());
    const creating = harness.service.createDraft({ ...draftInput(account), clientId: "stable-edit-id" });
    await started;
    const stored = await harness.store.getDraft("test-tenant", account.id, "stable-edit-id");
    if (!stored) throw new Error("Expected authoritative draft before provider completion");
    const update = updateInput(stored, { body: "Winning body" });
    const { version, ...content } = update;
    const updating = harness.store.updateDraft(
      "test-tenant",
      account.id,
      stored.id,
      version,
      content,
      new Date().toISOString(),
    );
    await waitForDraftVersion(harness.store, account.id, stored.id, 2);
    releaseFirst?.();
    const [updated, completed] = await Promise.all([updating, creating]);

    expect(completed).toMatchObject({ version: updated.version, body: "Winning body", mirror: { status: "synced", mirroredVersion: 2 } });
    expect(await harness.providerDrafts(account.id)).toEqual([
      { postreeveId: stored.id, version: 2, ref: expect.objectContaining({ kind: "imap" }) },
    ]);
    harness.store.close();
  });

  test("serializes a provider completion before an authoritative concurrent delete", async () => {
    let releaseMirror: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseMirror = resolve; });
    const harness = await createEmptyTestHarness({
      onDraftMirror: async () => {
        markStarted?.();
        await gate;
      },
    });
    const account = await harness.service.createAccount(testAccountInput());
    const creating = harness.service.createDraft({ ...draftInput(account), clientId: "stable-delete-id" });
    await started;
    const removing = harness.service.removeDraft(account.id, "stable-delete-id", { version: 1 });
    await Promise.resolve();
    releaseMirror?.();
    await Promise.all([creating, removing]);

    expect(await harness.store.getDraft("test-tenant", account.id, "stable-delete-id")).toBeNull();
    expect(await harness.providerDrafts(account.id)).toEqual([]);
    harness.store.close();
  });

  test("settles one send while the same authoritative edit is completing its provider mirror", async () => {
    let releaseMirror: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseMirror = resolve; });
    let blockVersionTwo = false;
    const harness = await createEmptyTestHarness({
      onDraftMirror: async (draft) => {
        if (!blockVersionTwo || draft.version !== 2) return;
        markStarted?.();
        await gate;
      },
    });
    const account = await harness.service.createAccount(testAccountInput());
    const created = await harness.service.createDraft(deliverableDraftInput(account));
    blockVersionTwo = true;
    const updating = harness.service.updateDraft(account.id, created.id, updateInput(created, { body: "Edited before send" }));
    await started;
    const sending = harness.service.sendDraft(account.id, created.id, { version: 2 });
    await Promise.resolve();
    releaseMirror?.();
    const [updated, receipt] = await Promise.all([updating, sending]);

    expect(updated).toMatchObject({ version: 2, body: "Edited before send" });
    expect(receipt.accepted).toEqual(["recipient@example.test"]);
    expect(harness.sendAttempts).toHaveLength(1);
    expect(await harness.providerDrafts(account.id)).toEqual([]);
    expect(await harness.store.getDraft("test-tenant", account.id, created.id)).toMatchObject({ delivery: { status: "sent" } });
    harness.store.close();
  });

  test("reports provider success followed by mirror persistence failure and repairs it on read", async () => {
    const harness = await createEmptyTestHarness();
    const account = await harness.service.createAccount(testAccountInput());
    const complete = harness.store.completeDraftMirror.bind(harness.store);
    harness.store.completeDraftMirror = async () => {
      throw new Error("fixture mirror persistence failure");
    };
    const created = await harness.service.createDraft({ ...draftInput(account), clientId: "persistence-repair-id" });
    expect(created.mirror).toMatchObject({ status: "failed", error: expect.stringContaining("could not be persisted") });
    expect(await harness.providerDrafts(account.id)).toHaveLength(1);

    harness.store.completeDraftMirror = complete;
    expect(await harness.service.getDraft(account.id, created.id)).toMatchObject({
      id: created.id,
      version: 1,
      mirror: { status: "synced", mirroredVersion: 1 },
    });
    harness.store.close();
  });

  test("overwrites an externally changed Postreeve marker without rolling back backend content or version", async () => {
    const harness = await createEmptyTestHarness();
    const account = await harness.service.createAccount(testAccountInput());
    const created = await harness.service.createDraft({ ...draftInput(account), body: "Authoritative body" });
    harness.replaceProviderDraftVersion(account.id, created.id, 999);

    const repaired = await harness.service.getDraft(account.id, created.id);
    expect(repaired).toMatchObject({ body: "Authoritative body", version: 1, mirror: { status: "synced", mirroredVersion: 1 } });
    expect(await harness.providerDrafts(account.id)).toEqual([
      { postreeveId: created.id, version: 1, ref: expect.objectContaining({ kind: "imap" }) },
    ]);
    harness.store.close();
  });

  test("restores the provider copy when provider deletion succeeds but local deletion loses a race", async () => {
    const harness = await createEmptyTestHarness();
    const account = await harness.service.createAccount(testAccountInput());
    const created = await harness.service.createDraft({ ...draftInput(account), body: "Keep authoritative content" });
    const remove = harness.store.deleteDraft.bind(harness.store);
    harness.store.deleteDraft = async () => {
      throw new Error("fixture local deletion failure");
    };

    await expect(harness.service.removeDraft(account.id, created.id, { version: created.version }))
      .rejects.toThrow("fixture local deletion failure");
    expect(await harness.providerDrafts(account.id)).toEqual([
      { postreeveId: created.id, version: created.version, ref: expect.objectContaining({ kind: "imap" }) },
    ]);
    expect(await harness.store.getDraft("test-tenant", account.id, created.id)).toMatchObject({ body: "Keep authoritative content" });
    harness.store.deleteDraft = remove;
    harness.store.close();
  });

  test("preserves authoritative content when explicit provider deletion is unresolved", async () => {
    let failRemoval = false;
    const harness = await createEmptyTestHarness({
      draftRemoveFailure: () => failRemoval ? new Error("ambiguous provider deletion") : undefined,
    });
    const account = await harness.service.createAccount(testAccountInput());
    const created = await harness.service.createDraft({ ...draftInput(account), body: "Do not lose this" });
    failRemoval = true;

    await expect(harness.service.removeDraft(account.id, created.id, { version: created.version }))
      .rejects.toThrow("ambiguous provider deletion");
    expect(await harness.store.getDraft("test-tenant", account.id, created.id)).toMatchObject({
      body: "Do not lose this",
      version: created.version,
      mirror: { status: "failed" },
    });
    failRemoval = false;
    await harness.service.removeDraft(account.id, created.id, { version: created.version });
    expect(await harness.store.getDraft("test-tenant", account.id, created.id)).toBeNull();
    harness.store.close();
  });

  test("keeps accepted delivery successful when provider draft cleanup needs repair", async () => {
    let failRemoval = false;
    const harness = await createEmptyTestHarness({
      draftRemoveFailure: () => failRemoval ? new Error("provider cleanup unavailable") : undefined,
    });
    const account = await harness.service.createAccount(testAccountInput());
    const created = await harness.service.createDraft(deliverableDraftInput(account));
    failRemoval = true;
    const receipt = await harness.service.sendDraft(account.id, created.id, { version: created.version });

    expect(receipt.accepted).toEqual(["recipient@example.test"]);
    expect(receipt.warning).toContain("provider draft could not be removed");
    expect(await harness.store.getDraft("test-tenant", account.id, created.id)).toMatchObject({
      delivery: { status: "sent" },
      mirror: { status: "failed" },
    });
    failRemoval = false;
    const replay = await harness.service.sendDraft(account.id, created.id, { version: created.version });
    expect(replay.warning).toBeUndefined();
    expect(await harness.providerDrafts(account.id)).toEqual([]);
    harness.store.close();
  });
});

function draftInput(account: Account): CreateDraftInput {
  return {
    accountId: account.id,
    mode: "new",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    identity: { name: account.name, address: account.email },
    attachments: [],
  };
}

function deliverableDraftInput(account: Account): CreateDraftInput {
  return {
    ...draftInput(account),
    to: [{ name: "Recipient", address: "recipient@example.test" }],
    subject: "Durable draft",
    body: "Deliver this once.",
  };
}

function updateInput(draft: Draft, changes: Partial<UpdateDraftInput> = {}): UpdateDraftInput {
  return {
    mode: draft.mode,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    identity: draft.identity,
    attachments: draft.attachments,
    ...(draft.source ? { source: draft.source } : {}),
    version: draft.version,
    ...changes,
  };
}

function contentOf(draft: Draft): DraftContent {
  return {
    mode: draft.mode,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    identity: draft.identity,
    ...(draft.source ? { source: draft.source } : {}),
    attachments: draft.attachments,
  };
}

async function waitForDraftVersion(
  store: Store,
  accountId: string,
  draftId: string,
  version: number,
): Promise<Draft> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const draft = await store.getDraft("test-tenant", accountId, draftId);
    if (draft?.version === version) return draft;
    await Promise.resolve();
  }
  throw new Error(`Draft ${draftId} did not reach version ${version}`);
}

function temporaryStore(): string {
  const path = join(tmpdir(), `postreeve-drafts-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
}
