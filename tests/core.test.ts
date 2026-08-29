import { describe, expect, test } from "bun:test";
import type { MessageRef, ProposalItem } from "../src/shared/contracts";
import { createEmptyTestHarness, createTestHarness, testAccountInput } from "./support/test-mail";

function proposalItem(message: MessageRef, id: string = crypto.randomUUID()): ProposalItem {
  return {
    id,
    message,
    subject: "Test message",
    action: { type: "mark_read" },
    reason: "Focused test",
  };
}

describe("Postreeve core workflow", () => {
  test("starts with no synthetic account or mail", async () => {
    const { store, service } = await createEmptyTestHarness();
    expect(await service.listAccounts()).toEqual([]);
    store.close();
  });

  test("does not persist or register an account when either connection check fails", async () => {
    const imap = await createEmptyTestHarness({ imapFailure: new Error("incoming-test-password") });
    await expect(imap.service.createAccount(testAccountInput())).rejects.toThrow("IMAP connection failed");
    expect(await imap.service.listAccounts()).toEqual([]);
    await expect(imap.service.createAccount(testAccountInput())).rejects.not.toThrow("incoming-test-password");
    imap.store.close();

    const smtp = await createEmptyTestHarness({ smtpFailure: new Error("outgoing-test-password") });
    await expect(smtp.service.createAccount(testAccountInput())).rejects.toThrow("SMTP connection failed");
    expect(await smtp.service.listAccounts()).toEqual([]);
    await expect(smtp.service.createAccount(testAccountInput())).rejects.not.toThrow("outgoing-test-password");
    smtp.store.close();
  });

  test("isolates multiple accounts", async () => {
    const { store, service, account, messages } = await createTestHarness();
    const second = await service.createAccount(testAccountInput("Second", "second@example.test"));
    const secondMessages = await service.listMessages({ accountId: second.id, mailbox: "INBOX", limit: 50 });

    expect(secondMessages[0]?.ref.accountId).toBe(second.id);
    expect(messages[0]?.ref.accountId).toBe(account.id);
    await expect(service.readMessages([messages[0]!.ref, secondMessages[0]!.ref]))
      .rejects.toThrow("different accounts");
    store.close();
  });

  test("keeps proposal edits separate from human approval", async () => {
    const { store, service, account, messages } = await createTestHarness();
    const proposal = await service.createProposal({
      accountId: account.id,
      title: "Inbox pass",
      items: [proposalItem(messages[0]!.ref)],
    });

    expect(proposal.status).toBe("draft");
    await expect(service.applyApprovedProposal(proposal.id)).rejects.toThrow("Human approval");
    const review = await service.updateProposal(proposal.id, { status: "review", title: "Edited pass" });
    expect(review.status).toBe("review");
    const approved = await service.approveProposalFromHumanInterface(proposal.id);
    expect(approved.status).toBe("approved");
    expect(approved.approvedAt).not.toBeNull();
    store.close();
  });

  test("reports stale messages as partial failures without touching another message", async () => {
    const { store, service, account, messages } = await createTestHarness();
    const valid = messages[0]!;
    const stale: MessageRef = { ...messages[1]!.ref, modseq: "stale" };
    const proposal = await service.createProposal({
      accountId: account.id,
      title: "Partly stale",
      items: [proposalItem(valid.ref, "valid"), proposalItem(stale, "stale")],
    });
    await service.approveProposalFromHumanInterface(proposal.id);
    const batch = await service.applyApprovedProposal(proposal.id);

    expect(batch.status).toBe("partially_applied");
    expect(batch.operations.map((operation) => operation.status)).toEqual(["applied", "failed"]);
    expect(batch.operations[1]?.error).toContain("stale");
    const untouched = await service.readMessages([messages[1]!.ref]);
    expect(untouched[0]?.read).toBe(false);
    store.close();
  });

  test("undoes supported applied actions and records the audit state", async () => {
    const { store, service, account, messages } = await createTestHarness();
    const message = messages.find(({ read }) => !read)!;
    const proposal = await service.createProposal({
      accountId: account.id,
      title: "Read then undo",
      items: [proposalItem(message.ref)],
    });
    await service.approveProposalFromHumanInterface(proposal.id);
    const batch = await service.applyApprovedProposal(proposal.id);
    const appliedRef = (await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 }))
      .find(({ ref }) => ref.uid === message.ref.uid)!.ref;
    expect((await service.readMessages([appliedRef]))[0]?.read).toBe(true);

    const undone = await service.undoBatch(batch.id);
    expect(undone.status).toBe("undone");
    expect(undone.operations[0]?.status).toBe("undone");
    const restoredRef = (await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 }))
      .find(({ ref }) => ref.uid === message.ref.uid)!.ref;
    expect((await service.readMessages([restoredRef]))[0]?.read).toBe(false);
    store.close();
  });

  test("lets the human manage mail directly through the audited action path", async () => {
    const { store, service, account, messages } = await createTestHarness();
    const message = messages[0]!;
    const batch = await service.applyDirectActions({
      accountId: account.id,
      items: [{
        message: message.ref,
        subject: message.subject,
        action: { type: "move", destination: "Archive" },
      }],
    });

    expect(batch.status).toBe("applied");
    expect((await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 }))
      .some(({ ref }) => ref.uid === message.ref.uid)).toBe(false);
    expect((await service.listMessages({ accountId: account.id, mailbox: "Archive", limit: 50 }))
      .some(({ ref }) => ref.uid === message.ref.uid)).toBe(true);
    expect((await service.getProposal(batch.proposalId)).approvedAt).not.toBeNull();
    store.close();
  });

  test("sends from the selected account without crossing account boundaries", async () => {
    const { store, service, account, sent } = await createTestHarness();
    const receipt = await service.sendMessage({
      accountId: account.id,
      to: [{ name: "Recipient", address: "recipient@example.com" }],
      cc: [],
      bcc: [],
      subject: "Hello from Postreeve",
      text: "This is a real outgoing message workflow.",
    });

    expect(receipt.accountId).toBe(account.id);
    expect(receipt.accepted).toEqual(["recipient@example.com"]);
    expect(sent).toHaveLength(1);
    const sentFolder = await service.listMessages({ accountId: account.id, mailbox: "Sent", limit: 50 });
    expect(sentFolder[0]?.subject).toBe("Hello from Postreeve");
    expect(service.sendMessage({
      accountId: "another-account",
      to: [{ name: "", address: "recipient@example.com" }],
      cc: [],
      bcc: [],
      subject: "Wrong account",
      text: "Must not send.",
    })).rejects.toThrow("Account not found");
    store.close();
  });

  test("tests and reconnects an account without returning or replacing blank passwords", async () => {
    const { store, service, account, connections } = await createTestHarness();
    const settings = await service.getAccountSettings(account.id);
    expect(settings).not.toHaveProperty("password");
    expect(settings).not.toHaveProperty("smtpPassword");
    const { id: _id, kind: _kind, ...unchanged } = settings;

    await service.testAccountConnection(account.id, unchanged);
    expect(connections.at(-1)?.imap.password).toBe("incoming-test-password");
    expect(connections.at(-1)?.smtp?.password).toBe("outgoing-test-password");

    const updated = await service.updateAccount(account.id, {
      ...unchanged,
      name: "Primary work",
      password: "new-incoming-password",
      smtpPassword: "new-outgoing-password",
    });
    expect(updated.name).toBe("Primary work");
    expect((await service.getAccountSettings(account.id)).name).toBe("Primary work");
    expect(connections.at(-1)?.imap.password).toBe("new-incoming-password");
    expect(connections.at(-1)?.smtp?.password).toBe("new-outgoing-password");
    store.close();
  });

  test("removes encrypted account data and its local workflow history", async () => {
    const { store, service, account, messages } = await createTestHarness();
    const batch = await service.applyDirectActions({
      accountId: account.id,
      items: [{ message: messages[0]!.ref, subject: messages[0]!.subject, action: { type: "mark_read" } }],
    });

    await service.removeAccount(account.id);

    expect(await service.listAccounts()).toEqual([]);
    await expect(service.getProposal(batch.proposalId)).rejects.toThrow("Proposal not found");
    await expect(service.listFolders(account.id)).rejects.toThrow("Account not found");
    store.close();
  });
});
