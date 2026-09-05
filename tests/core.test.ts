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
    expect(secondMessages[0]?.canonicalId).toBe(messages[0]?.canonicalId);
    await expect(service.readMessages([messages[0]!.ref, secondMessages[0]!.ref]))
      .rejects.toThrow("different accounts");
    store.close();
  });

  test("persists provider listings in the tenant without treating truncated results as authoritative", async () => {
    const { store, service } = await createEmptyTestHarness();
    const account = await service.createAccount(testAccountInput());
    const stale = (uid: number, read: boolean) => ({
      tenantId: "test-tenant",
      messageId: null,
      inReplyTo: null,
      references: [],
      location: {
        accountId: account.id,
        provider: "imap" as const,
        mailbox: "INBOX",
        uidValidity: "1723371481",
        uid,
        modseq: "1",
        providerId: null,
        read,
        flagged: false,
      },
    });
    const [listed, unseen] = await store.reconcileMailbox({
      tenantId: "test-tenant",
      accountId: account.id,
      provider: "imap",
      mailbox: "INBOX",
      observations: [stale(103, true), stale(101, true)],
      authoritative: true,
    });

    const messages = await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 1 });

    expect(messages.map(({ ref }) => ref.uid)).toEqual([103]);
    expect(messages[0]?.canonicalId).toBe(listed!.id);
    expect((await service.listMessages({ accountId: account.id, mailbox: "INBOX", query: "planning", limit: 1 }))[0]?.canonicalId)
      .toBe(listed!.id);
    expect((await service.searchMessages({ accountId: account.id, mailbox: "INBOX", query: "planning", limit: 1 }))[0]?.canonicalId)
      .toBe(listed!.id);
    expect(await store.listMessageLocations("test-tenant", listed!.id)).toMatchObject([{ read: false, flagged: true }]);
    expect(await store.listMessageLocations("test-tenant", unseen!.id)).toHaveLength(1);
    store.close();
  });

  test("returns one canonical summary while retaining duplicate delivery locations", async () => {
    const { store, service } = await createEmptyTestHarness({ duplicateDelivery: true });
    const account = await service.createAccount(testAccountInput());

    const listed = await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 });
    const searched = await service.searchMessages({
      accountId: account.id,
      mailbox: "INBOX",
      query: "planning",
      limit: 50,
    });
    const queried = await service.listMessages({
      accountId: account.id,
      mailbox: "INBOX",
      query: "planning",
      limit: 50,
    });
    const planning = listed.filter(({ messageId }) => messageId === "<message-103@example.test>");

    expect(planning).toHaveLength(1);
    expect(planning[0]).toMatchObject({ ref: { uid: 103 }, read: false, flagged: true });
    expect(searched.map(({ canonicalId }) => canonicalId)).toEqual([planning[0]!.canonicalId]);
    expect(queried.map(({ canonicalId }) => canonicalId)).toEqual([planning[0]!.canonicalId]);
    const locations = await store.listMessageLocations("test-tenant", planning[0]!.canonicalId);
    expect(locations.map(({ uid, providerId }) => ({ uid, providerId })).toSorted((left, right) => left.uid - right.uid))
      .toEqual([
      { uid: 103, providerId: null },
      { uid: 104, providerId: "provider-copy-104" },
      ]);
    expect((await service.readMessages([
      { accountId: account.id, mailbox: "INBOX", uidValidity: "1723371481", uid: 103, modseq: "1" },
      {
        accountId: account.id,
        mailbox: "INBOX",
        uidValidity: "1723371481",
        uid: 104,
        modseq: "1",
        providerId: "provider-copy-104",
      },
    ])).map(({ ref }) => ref.uid)).toEqual([103, 104]);
    store.close();
  });

  test("creates, renames, and deletes custom folders while protecting system folders", async () => {
    const { store, service, account } = await createTestHarness();

    const created = await service.createFolder({ accountId: account.id, name: "Projects" });
    expect(created.some(({ path, specialUse }) => path === "Projects" && specialUse === null)).toBe(true);

    const renamed = await service.renameFolder({ accountId: account.id, path: "Projects", name: "Clients" });
    expect(renamed.some(({ path }) => path === "Projects")).toBe(false);
    expect(renamed.some(({ path }) => path === "Clients")).toBe(true);

    await expect(service.renameFolder({ accountId: account.id, path: "INBOX", name: "Incoming" }))
      .rejects.toThrow("System and special-use folders cannot be changed");
    const deleted = await service.deleteFolder({ accountId: account.id, path: "Clients" });
    expect(deleted.some(({ path }) => path === "Clients")).toBe(false);
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
    const [moved] = await service.listMessages({ accountId: account.id, mailbox: "Archive", limit: 50 });
    expect(moved?.ref.uid).toBe(message.ref.uid);
    expect(moved?.canonicalId).toBe(message.canonicalId);
    expect((await service.getProposal(batch.proposalId)).approvedAt).not.toBeNull();
    store.close();
  });

  test("retains a missing-ID message through an applied move and its undo", async () => {
    const { store, service, account, messages } = await createTestHarness({ missingMessageId: true });
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
    expect(batch.operations[0]?.error).toBeNull();
    await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 });
    const [moved] = await service.listMessages({ accountId: account.id, mailbox: "Archive", limit: 50 });
    expect(moved?.canonicalId).toBe(message.canonicalId);
    expect(await store.getMessage("test-tenant", message.canonicalId!)).toMatchObject({
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });

    const undone = await service.undoBatch(batch.id);
    expect(undone.status).toBe("undone");
    expect(undone.operations[0]?.error).toBeNull();
    await service.listMessages({ accountId: account.id, mailbox: "Archive", limit: 50 });
    const restored = await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 });
    expect(restored.find(({ subject }) => subject === message.subject)?.canonicalId).toBe(message.canonicalId);
    store.close();
  });

  test("keeps provider success and undoability when local move identity persistence fails", async () => {
    const { store, service, account, messages } = await createTestHarness({ missingMessageId: true });
    store.recordProviderMove = async () => {
      throw new Error("fixture identity persistence failure");
    };
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
    expect(batch.operations[0]?.status).toBe("applied");
    expect(batch.operations[0]?.error).toContain("local message identity");
    const undone = await service.undoBatch(batch.id);
    expect(undone.status).toBe("undone");
    expect(undone.operations[0]?.error).toContain("local message identity");
    const restored = await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 });
    expect(restored.some(({ subject }) => subject === message.subject)).toBe(true);
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
