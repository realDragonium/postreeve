import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import type { CreateAccountInput, SendMessageInput } from "../src/shared/contracts";
import { defaultSaveSentCopy } from "../src/shared/sent-copy";
import { createEmptyTestHarness, createTestHarness, testAccountInput, testCredentialVault } from "./support/test-mail";

function message(accountId: string, extra: Partial<SendMessageInput> = {}): SendMessageInput {
  return {
    accountId,
    to: [{ name: "Recipient", address: "recipient@example.com" }],
    cc: [],
    bcc: [],
    subject: "Sent copy",
    text: "Keep this in Sent.",
    ...extra,
  };
}

function accountInput(extra: Partial<CreateAccountInput>): CreateAccountInput {
  return { ...testAccountInput(), ...extra };
}

describe("sent copies for IMAP accounts", () => {
  test("defaults the setting off only for providers that file SMTP submissions themselves", () => {
    expect(defaultSaveSentCopy("imap.gmail.com")).toBe(false);
    expect(defaultSaveSentCopy("IMAP.GoogleMail.com")).toBe(false);
    expect(defaultSaveSentCopy("outlook.office365.com")).toBe(false);
    expect(defaultSaveSentCopy("imap-mail.outlook.com")).toBe(false);
    expect(defaultSaveSentCopy("imap.mail.me.com")).toBe(true);
    expect(defaultSaveSentCopy("notgmail.com")).toBe(true);
  });

  test("indexes the copy of a reply into the conversation the send recorded", async () => {
    const { store, service, account, messages, sentCopies } = await createTestHarness();
    const source = messages[0]!;

    const receipt = await service.sendMessage(message(account.id, {
      to: source.from,
      subject: `Re: ${source.subject}`,
      intent: { type: "reply", source: { canonicalMessageId: source.canonicalId, conversationId: source.conversationId } },
    }));

    expect(receipt.warning).toBeUndefined();
    expect(sentCopies).toHaveLength(1);
    expect((await simpleParser(sentCopies[0]!)).messageId).toBe(receipt.messageId);
    const recorded = (await service.getConversation(source.conversationId)).messages
      .find(({ messageId }) => messageId === receipt.messageId);
    const indexed = store.synchronization.indexed("test-tenant", account.id, "Sent");
    expect(indexed).toHaveLength(1);
    expect(indexed[0]).toMatchObject({ canonicalId: recorded?.id, conversationId: source.conversationId });
    store.close();
  });

  test("appends nothing when the setting is off or no recipient accepted", async () => {
    const { store, service, sentCopies } = await createEmptyTestHarness({ rejectRecipients: ["refused@example.com"] });
    const off = await service.createAccount(accountInput({ saveSentCopy: false }));
    const on = await service.createAccount(accountInput({ name: "Other", email: "other@example.test" }));

    await service.sendMessage(message(off.id));
    await service.sendMessage(message(on.id, { to: [{ name: "", address: "refused@example.com" }] }));

    expect(sentCopies).toHaveLength(0);
    store.close();
  });

  test("keeps a delivered draft sent and records the append failure as a receipt warning", async () => {
    const { store, service, sendAttempts } = await createEmptyTestHarness({ sentCopyFailure: new Error("APPEND refused") });
    const account = await service.createAccount(testAccountInput());
    const draft = await service.createDraft({
      accountId: account.id,
      mode: "new",
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Delivered anyway",
      format: "plain",
      body: "The send must stand.",
      identity: { name: account.name, address: account.email },
      attachments: [],
    });

    const receipt = await service.sendDraft(account.id, draft.id, { version: draft.version });

    const warning = "Message was sent, but a copy could not be saved to Sent: APPEND refused";
    expect(receipt.warning).toBe(warning);
    const stored = await service.getDraft(account.id, draft.id);
    expect(stored.delivery).toMatchObject({ status: "sent", receipt: { warning } });
    expect(sendAttempts).toHaveLength(1);
    store.close();
  });

  test("records a delivered draft as sent before its copy is appended", async () => {
    let statusDuringCopy: string | undefined;
    let draftId = "";
    let accountId = "";
    const { store, service } = await createEmptyTestHarness({
      beforeSentCopy: async () => {
        statusDuringCopy = (await service.getDraft(accountId, draftId)).delivery.status;
      },
    });
    const account = await service.createAccount(testAccountInput());
    const draft = await service.createDraft({
      accountId: account.id,
      mode: "new",
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Settled first",
      body: "Durable before the copy.",
      format: "plain",
      identity: { name: account.name, address: account.email },
      attachments: [],
    });
    accountId = account.id;
    draftId = draft.id;

    await service.sendDraft(account.id, draft.id, { version: draft.version });

    expect(statusDuringCopy).toBe("sent");
    store.close();
  });

  test("round-trips the setting and falls back to the host default for accounts stored without it", async () => {
    const { store, service, sentCopies } = await createEmptyTestHarness();
    const account = await service.createAccount(accountInput({ host: "outlook.office365.com" }));
    const settings = await service.getAccountSettings(account.id);
    expect(settings.saveSentCopy).toBe(false);
    const { id: _id, kind: _kind, saveSentCopy: _saveSentCopy, ...rest } = settings;

    await service.updateAccount(account.id, { ...rest, name: "Renamed" });
    expect((await service.getAccountSettings(account.id)).saveSentCopy).toBe(false);
    await service.updateAccount(account.id, { ...rest, saveSentCopy: true });
    expect((await service.getAccountSettings(account.id)).saveSentCopy).toBe(true);
    await service.sendMessage(message(account.id));
    expect(sentCopies).toHaveLength(1);

    const vault = testCredentialVault();
    const stored = (await store.getAccount(account.id))!;
    const credentials = vault.decrypt(stored.encryptedCredentials!);
    if (credentials.kind !== "imap" || !credentials.smtp) throw new Error("Expected IMAP credentials");
    const { saveSentCopy: _stored, ...legacySmtp } = credentials.smtp;
    await store.updateAccount({ ...stored, encryptedCredentials: vault.encrypt({ ...credentials, smtp: legacySmtp }) });
    expect((await service.getAccountSettings(account.id)).saveSentCopy).toBe(false);
    await service.sendMessage(message(account.id));
    expect(sentCopies).toHaveLength(1);
    store.close();
  });
});
