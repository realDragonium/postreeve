import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, CreateDraftInput, Draft, UpdateDraftInput } from "../src/shared/contracts";
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
    });
    first.store.close();

    const reopened = await createEmptyTestHarness({ storePath: path });
    expect(await reopened.service.getDraft(account.id, created.id)).toEqual(created);
    expect(await reopened.service.listDrafts(account.id)).toEqual([created]);
    await expect(reopened.service.getDraft(other.id, created.id)).rejects.toThrow("Draft not found");
    expect(await reopened.store.getDraft("another-tenant", account.id, created.id)).toBeNull();
    reopened.store.close();

    const inspected = new Database(path);
    expect(inspected.query("SELECT version FROM schema_migrations WHERE version = 479").get()).toEqual({ version: 479 });
    expect(inspected.query("PRAGMA foreign_key_check('drafts')").all()).toEqual([]);
    inspected.close();
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

  test("does not dispatch a fetched snapshot updated by another client during send preflight", async () => {
    const { store, service, sendAttempts } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const draft = await service.createDraft(deliverableDraftInput(account));
    const claimDraftSend = store.claimDraftSend.bind(store);
    let releaseClaim: () => void = () => {};
    let markClaimReached: () => void = () => {};
    const claimWait = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const claimReached = new Promise<void>((resolve) => { markClaimReached = resolve; });
    store.claimDraftSend = async (tenantId, accountId, id, expectedVersion, claimedAt) => {
      markClaimReached();
      await claimWait;
      return claimDraftSend(tenantId, accountId, id, expectedVersion, claimedAt);
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
    expect(first.sendAttempts).toHaveLength(1);

    releaseSend();
    const receipt = await sending;
    const settled = await first.service.getDraft(account.id, draft.id);
    expect(settled.delivery).toEqual({ status: "sent", settledAt: receipt.submittedAt, receipt });
    expect(await first.service.listDrafts(account.id)).toEqual([]);
    first.store.close();

    const reopened = await createEmptyTestHarness({ storePath: path });
    expect(await reopened.service.sendDraft(account.id, draft.id, { version: draft.version })).toEqual(receipt);
    expect(reopened.sendAttempts).toHaveLength(0);
    reopened.store.close();
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

  test("preserves an in-progress claim across restart instead of risking a second dispatch", async () => {
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
    );
    expect(claim.kind).toBe("claimed");
    first.store.close();

    const reopened = await createEmptyTestHarness({ storePath: path });
    const claimed = await reopened.service.getDraft(account.id, draft.id);
    expect(claimed.delivery.status).toBe("sending");
    await expect(reopened.service.sendDraft(account.id, draft.id, { version: claimed.version }))
      .rejects.toThrow("already in progress");
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

  test("keeps pre-dispatch failures editable and post-accept persistence failures claimed", async () => {
    const { store, service, sendAttempts } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const incomplete = await service.createDraft(draftInput(account));
    await expect(service.sendDraft(account.id, incomplete.id, { version: incomplete.version })).rejects.toThrow();
    expect(await service.getDraft(account.id, incomplete.id)).toEqual(incomplete);
    expect(sendAttempts).toHaveLength(0);

    const deliverable = await service.createDraft(deliverableDraftInput(account));
    store.settleDraftSend = async () => {
      throw new Error("fixture settlement failure");
    };
    const receipt = await service.sendDraft(account.id, deliverable.id, { version: deliverable.version });
    expect(receipt.accepted).toEqual(["recipient@example.test"]);
    expect(receipt.warning).toContain("local draft could not be settled");
    const claimed = await service.getDraft(account.id, deliverable.id);
    expect(claimed.delivery.status).toBe("sending");
    await expect(service.sendDraft(account.id, deliverable.id, { version: claimed.version }))
      .rejects.toThrow("already in progress");
    expect(sendAttempts).toHaveLength(1);
    store.close();
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
    ...(draft.source ? { source: draft.source } : {}),
    version: draft.version,
    ...changes,
  };
}

function temporaryStore(): string {
  const path = join(tmpdir(), `postreeve-drafts-${crypto.randomUUID()}.sqlite`);
  paths.push(path);
  return path;
}
