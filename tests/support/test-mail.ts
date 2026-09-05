import {
  sendMessageInputSchema,
  sendReceiptSchema,
  type CreateAccountInput,
  type Folder,
  type MessageDetail,
  type MessageRef,
  type MessageSummary,
  type SendMessageInput,
  type SendReceipt,
  type TriageAction,
} from "../../src/shared/contracts";
import { PostreeveService } from "../../src/server/core/postreeve";
import { Store } from "../../src/server/db/store";
import {
  MailProviderRegistry,
  type AppliedMailAction,
  type MailboxPage,
  type MailProvider,
  type ProviderLocationMove,
} from "../../src/server/mail/provider";
import { MailSenderRegistry, type MailSender } from "../../src/server/mail/sender";
import { CredentialVault } from "../../src/server/security/credentials";
import type { ImapAccountCredentials } from "../../src/server/security/credentials";

interface TestMessage extends MessageDetail {
  mailbox: string;
}

const uidValidity = "1723371481";
const testMasterKey = Buffer.alloc(32, 7).toString("base64");

export function testAccountInput(name = "Work", email = "person@example.test"): CreateAccountInput {
  return {
    kind: "imap",
    name,
    email,
    host: "imap.example.test",
    port: 993,
    secure: true,
    username: email,
    password: "incoming-test-password",
    smtpHost: "smtp.example.test",
    smtpPort: 465,
    smtpSecure: true,
    smtpUsername: email,
    smtpPassword: "outgoing-test-password",
  };
}

interface TestHarnessOptions {
  imapFailure?: Error;
  smtpFailure?: Error;
  duplicateDelivery?: boolean;
  missingMessageId?: boolean;
}

export async function createTestHarness(options: TestHarnessOptions = {}) {
  const harness = await createEmptyTestHarness(options);
  const { store, service, sent } = harness;
  const account = await service.createAccount(testAccountInput());
  const messages = await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 });
  return { ...harness, store, service, account, messages, sent };
}

export async function createEmptyTestHarness(options: TestHarnessOptions = {}) {
  const store = new Store(":memory:");
  const sent: SendMessageInput[] = [];
  const connections: ImapAccountCredentials[] = [];
  const providers = new Map<string, TestMailProvider>();
  const service = new PostreeveService(
    store,
    { tenantId: "test-tenant" },
    new MailProviderRegistry(),
    new MailSenderRegistry(),
    new CredentialVault(testMasterKey),
    (accountId) => {
      const provider = new TestMailProvider(
        accountId,
        options.imapFailure,
        options.duplicateDelivery ?? false,
        options.missingMessageId ?? false,
      );
      providers.set(accountId, provider);
      return provider;
    },
    (account, credentials) => {
      connections.push(structuredClone(credentials));
      return new TestMailSender(account.id, async (input, receipt) => {
        sent.push(structuredClone(input));
        providers.get(account.id)?.appendSent(input, receipt.messageId, receipt.submittedAt);
      }, options.smtpFailure);
    },
  );
  await service.initialize();
  return { store, service, sent, connections };
}

class TestMailProvider implements MailProvider {
  readonly #accountId: string;
  readonly #messages: TestMessage[];
  readonly #folders = new Map<string, { name: string; specialUse: Folder["specialUse"] }>([
    ["INBOX", { name: "Inbox", specialUse: "inbox" }],
    ["Archive", { name: "Archive", specialUse: "archive" }],
    ["Sent", { name: "Sent", specialUse: "sent" }],
    ["Trash", { name: "Trash", specialUse: "trash" }],
  ]);
  readonly #verificationFailure: Error | undefined;
  readonly #moveChangesUid: boolean;

  constructor(
    accountId: string,
    verificationFailure: Error | undefined,
    duplicateDelivery: boolean,
    missingMessageId: boolean,
  ) {
    this.#accountId = accountId;
    this.#messages = testMessages(accountId, duplicateDelivery);
    this.#moveChangesUid = missingMessageId;
    if (missingMessageId) {
      this.#messages[0]!.messageId = "missing-message-id";
      this.#messages[0]!.inReplyTo = "<parent@example.test>";
      this.#messages[0]!.references = ["<root@example.test>", "<parent@example.test>"];
    }
    this.#verificationFailure = verificationFailure;
  }

  async verifyConnection(): Promise<void> {
    if (this.#verificationFailure) throw this.#verificationFailure;
  }

  async listFolders(accountId: string): Promise<Folder[]> {
    this.#assertAccount(accountId);
    return [...this.#folders].map(([path, folder]) => this.#folder(path, folder.name, folder.specialUse));
  }

  async createFolder(accountId: string, name: string): Promise<void> {
    this.#assertAccount(accountId);
    if (this.#folders.has(name)) throw new Error(`Folder ${name} already exists`);
    this.#folders.set(name, { name, specialUse: null });
  }

  async renameFolder(accountId: string, path: string, name: string): Promise<void> {
    this.#assertAccount(accountId);
    const folder = this.#folders.get(path);
    if (!folder) throw new Error(`Folder ${path} does not exist`);
    if (folder.specialUse !== null) throw new Error("System and special-use folders cannot be changed");
    if (path !== name && this.#folders.has(name)) throw new Error(`Folder ${name} already exists`);
    this.#folders.delete(path);
    this.#folders.set(name, { name, specialUse: null });
    for (const message of this.#messages.filter((candidate) => candidate.mailbox === path)) {
      message.mailbox = name;
      message.ref.mailbox = name;
    }
  }

  async deleteFolder(accountId: string, path: string): Promise<void> {
    this.#assertAccount(accountId);
    const folder = this.#folders.get(path);
    if (!folder) throw new Error(`Folder ${path} does not exist`);
    if (folder.specialUse !== null) throw new Error("System and special-use folders cannot be changed");
    if (this.#messages.some((message) => message.mailbox === path)) {
      throw new Error("Move every message out of this IMAP folder before deleting it");
    }
    this.#folders.delete(path);
  }

  async listMessages(accountId: string, mailbox: string, limit: number): Promise<MessageSummary[]> {
    return (await this.listMessagePage(accountId, mailbox, limit)).messages;
  }

  async listMessagePage(accountId: string, mailbox: string, limit: number): Promise<MailboxPage> {
    this.#assertAccount(accountId);
    const observed = this.#messages
      .filter((message) => message.mailbox === mailbox)
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
    return { messages: observed.slice(0, limit).map(toSummary), complete: observed.length <= limit };
  }

  async readMessages(accountId: string, references: MessageRef[]): Promise<MessageDetail[]> {
    this.#assertAccount(accountId);
    return references.map((reference) => {
      const message = this.#find(reference);
      if (!message) throw new Error(`Message UID ${reference.uid} is stale or missing`);
      return toDetail(message);
    });
  }

  async searchMessages(accountId: string, mailbox: string, query: string, limit: number): Promise<MessageSummary[]> {
    this.#assertAccount(accountId);
    const needle = query.toLocaleLowerCase();
    return this.#messages
      .filter((message) => message.mailbox === mailbox)
      .filter((message) => [message.subject, message.preview, message.text, ...message.from.map(({ address }) => address)]
        .some((value) => value.toLocaleLowerCase().includes(needle)))
      .slice(0, limit)
      .map(toSummary);
  }

  async revalidate(reference: MessageRef): Promise<boolean> {
    return this.#find(reference) !== undefined;
  }

  async apply(reference: MessageRef, action: TriageAction): Promise<AppliedMailAction> {
    const message = this.#find(reference);
    if (!message) throw new Error(`Message UID ${reference.uid} changed or no longer exists`);
    const previous = structuredClone(message.ref);
    const previousRead = message.read;
    switch (action.type) {
      case "leave":
        break;
      case "mark_read":
        message.read = true;
        break;
      case "mark_unread":
        message.read = false;
        break;
      case "move":
        message.mailbox = action.destination;
        message.ref.mailbox = action.destination;
        if (this.#moveChangesUid) message.ref.uid += 100;
        break;
      case "trash":
        message.mailbox = "Trash";
        message.ref.mailbox = "Trash";
        if (this.#moveChangesUid) message.ref.uid += 100;
        break;
    }
    message.ref.modseq = String(Number(message.ref.modseq ?? "0") + 1);
    return { current: structuredClone(message.ref), previous, action, previousRead };
  }

  async undo(applied: AppliedMailAction): Promise<ProviderLocationMove | null> {
    const message = this.#find(applied.current);
    if (!message) throw new Error(`Applied message UID ${applied.current.uid} changed or no longer exists`);
    const previous = structuredClone(message.ref);
    message.mailbox = applied.previous.mailbox;
    message.read = applied.previousRead;
    message.ref = { ...applied.previous, modseq: String(Number(message.ref.modseq ?? "0") + 1) };
    return applied.action.type === "move" || applied.action.type === "trash"
      ? { previous, current: structuredClone(message.ref) }
      : null;
  }

  appendSent(input: SendMessageInput, messageId: string, sentAt: string): void {
    const uid = Math.max(0, ...this.#messages.map((message) => message.ref.uid)) + 1;
    const ref: MessageRef = { accountId: this.#accountId, mailbox: "Sent", uidValidity, uid, modseq: "1" };
    this.#messages.push({
      ref,
      mailbox: "Sent",
      messageId,
      subject: input.subject,
      from: [{ name: "Test user", address: "person@example.test" }],
      to: input.to,
      receivedAt: sentAt,
      preview: input.text.replace(/\s+/g, " ").trim().slice(0, 240),
      text: input.text,
      html: null,
      read: true,
      flagged: false,
    });
  }

  #folder(path: string, name: string, specialUse: Folder["specialUse"]): Folder {
    const messages = this.#messages.filter((message) => message.mailbox === path);
    return { path, name, specialUse, total: messages.length, unread: messages.filter((message) => !message.read).length };
  }

  #find(reference: MessageRef): TestMessage | undefined {
    if (reference.accountId !== this.#accountId || reference.uidValidity !== uidValidity) return undefined;
    return this.#messages.find((message) => message.mailbox === reference.mailbox
      && message.ref.uid === reference.uid
      && message.ref.modseq === reference.modseq);
  }

  #assertAccount(accountId: string): void {
    if (accountId !== this.#accountId) throw new Error("Account isolation violation");
  }
}

class TestMailSender implements MailSender {
  readonly #accountId: string;
  readonly #onSent: (input: SendMessageInput, receipt: SendReceipt) => void | Promise<void>;
  readonly #verificationFailure: Error | undefined;

  constructor(
    accountId: string,
    onSent: (input: SendMessageInput, receipt: SendReceipt) => void | Promise<void>,
    verificationFailure?: Error,
  ) {
    this.#accountId = accountId;
    this.#onSent = onSent;
    this.#verificationFailure = verificationFailure;
  }

  async verifyConnection(): Promise<void> {
    if (this.#verificationFailure) throw this.#verificationFailure;
  }

  async send(rawInput: SendMessageInput): Promise<SendReceipt> {
    const input = sendMessageInputSchema.parse(rawInput);
    if (input.accountId !== this.#accountId) throw new Error("Account isolation violation");
    const id = crypto.randomUUID();
    const receipt = sendReceiptSchema.parse({
      id,
      accountId: this.#accountId,
      messageId: `<${id}@example.test>`,
      accepted: [...input.to, ...input.cc, ...input.bcc].map(({ address }) => address),
      rejected: [],
      submittedAt: new Date().toISOString(),
    });
    await this.#onSent(input, receipt);
    return receipt;
  }
}

function toSummary(message: TestMessage): MessageSummary {
  const { html: _html, text: _text, mailbox: _mailbox, ...summary } = message;
  return structuredClone(summary);
}

function toDetail(message: TestMessage): MessageDetail {
  const { mailbox: _mailbox, ...detail } = message;
  return structuredClone(detail);
}

function testMessages(accountId: string, duplicateDelivery: boolean): TestMessage[] {
  const ref = (uid: number): MessageRef => ({ accountId, mailbox: "INBOX", uidValidity, uid, modseq: "1" });
  const recipient = [{ name: "Test user", address: "person@example.test" }];
  const messages: TestMessage[] = [
    {
      ref: ref(103), mailbox: "INBOX", messageId: "<message-103@example.test>", subject: "Quarterly planning notes",
      from: [{ name: "Sam Rivera", address: "sam@example.test" }], to: recipient,
      receivedAt: "2026-08-29T09:30:00.000Z", preview: "Here are the decisions and follow-ups.",
      text: "Here are the decisions and follow-ups.", html: null, read: false, flagged: true,
    },
    {
      ref: ref(102), mailbox: "INBOX", messageId: "<message-102@example.test>", subject: "Engineering newsletter",
      from: [{ name: "Engineering Weekly", address: "digest@example.test" }], to: recipient,
      receivedAt: "2026-08-28T16:00:00.000Z", preview: "This week's engineering stories.",
      text: "This week's engineering stories.", html: null, read: false, flagged: false,
    },
    {
      ref: ref(101), mailbox: "INBOX", messageId: "<message-101@example.test>", subject: "August receipt",
      from: [{ name: "Hosting", address: "billing@example.test" }], to: recipient,
      receivedAt: "2026-08-27T11:15:00.000Z", preview: "Your payment was successful.",
      text: "Your payment was successful.", html: null, read: true, flagged: false,
    },
  ];
  if (duplicateDelivery) {
    messages.splice(1, 0, {
      ...structuredClone(messages[0]!),
      ref: { ...ref(104), providerId: "provider-copy-104" },
      read: true,
      flagged: false,
      preview: "Duplicate provider delivery with different mutable flags.",
    });
  }
  return messages;
}
