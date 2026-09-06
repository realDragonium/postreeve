import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Account, CreateDraftInput, Draft, UpdateDraftInput } from "../src/shared/contracts";
import { AccountConflictError } from "../src/server/core/errors";
import { Store } from "../src/server/db/store";
import { MailSendPreDispatchError } from "../src/server/mail/sender";
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
