import type { OutgoingContent } from "../../src/server/mail/outgoing-content";
import {
  sendMessageInputSchema,
  sendReceiptSchema,
  type CreateAccountInput,
  type Draft,
  type Folder,
  type MessageDetail,
  type MessageRef,
  type MessageSummary,
  type SendMessageInput,
  type SendReceipt,
  type TriageAction,
  type ProviderDraftRef,
} from "../../src/shared/contracts";
import { PostreeveService } from "../../src/server/core/postreeve";
import { Store } from "../../src/server/db/store";
import {
  MailProviderRegistry,
  type AppliedMailAction,
  type MailboxPage,
  type MailProvider,
  type ProviderMessageDetail,
  type ProviderLocationMove,
  type ProviderDraft,
  type ProviderDraftScope,
  type ProviderAttachmentDownload,
  type ProviderAttachmentLocator,
} from "../../src/server/mail/provider";
import {
  MailSenderRegistry,
  type ConversationSendContext,
  type MailSender,
} from "../../src/server/mail/sender";
import { CredentialVault } from "../../src/server/security/credentials";
import type { ImapAccountCredentials } from "../../src/server/security/credentials";

interface TestMessage extends Omit<MessageDetail, "attachments"> {
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
  tenantId?: string;
  maxAttachmentBytes?: number;
  maxUploadBytes?: number;
  maxMessageBytes?: number;
  storePath?: string;
  imapFailure?: Error;
  smtpFailure?: Error;
  sendFailure?: Error | (() => Error | undefined);
  sendWait?: Promise<void>;
  onSendAttempt?: () => void;
  rejectRecipients?: readonly string[];
  receiptAccountId?: string;
  duplicateDelivery?: boolean;
  archiveDelivery?: boolean;
  missingMessageId?: boolean;
  sourceThreading?: {
    messageId: string;
    inReplyTo: string | null;
    references: string[];
  };
  readOverrides?: Partial<ProviderMessageDetail>;
  onDraftMirror?: (draft: Draft) => void | Promise<void>;
  onDraftUpdate?: (draft: Draft, ref: ProviderDraftRef) => void | Promise<void>;
  rotateDraftRefOnUpdate?: boolean;
  onDraftRemove?: (draftId: string) => void | Promise<void>;
  draftRemoveFailure?: () => Error | undefined;
  providerDraftState?: Map<string, ProviderDraft>;
  providerForAccount?: (accountId: string) => MailProvider | undefined;
  downloadAttachment?: (
    accountId: string,
    locator: ProviderAttachmentLocator,
    maxBytes: number,
  ) => Promise<ProviderAttachmentDownload> | ProviderAttachmentDownload;
}

export async function createTestHarness(options: TestHarnessOptions = {}) {
  const harness = await createEmptyTestHarness(options);
  const { store, service, sent } = harness;
  const account = await service.createAccount(testAccountInput());
  const messages = await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 });
  return { ...harness, store, service, account, messages, sent };
}

export async function createEmptyTestHarness(options: TestHarnessOptions = {}) {
  const tenantId = options.tenantId ?? "test-tenant";
  const store = new Store(options.storePath ?? ":memory:");
  const sent: SendMessageInput[] = [];
  const sendAttempts: SendMessageInput[] = [];
  const sendContents: Array<OutgoingContent | undefined> = [];
  const sendContexts: Array<ConversationSendContext | undefined> = [];
  const connections: ImapAccountCredentials[] = [];
  const draftMirrorAttempts: Draft[] = [];
  const providers = new Map<string, MailProvider>();
  const service = new PostreeveService(
    store,
    { tenantId, ...(options.maxAttachmentBytes === undefined ? {} : { maxAttachmentBytes: options.maxAttachmentBytes }),
      ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
      ...(options.maxMessageBytes === undefined ? {} : { maxMessageBytes: options.maxMessageBytes }) },
    new MailProviderRegistry(),
    new MailSenderRegistry(),
    new CredentialVault(testMasterKey),
    (accountId) => {
      const provider = options.providerForAccount?.(accountId) ?? new TestMailProvider(
        accountId,
        options.imapFailure,
        options.duplicateDelivery ?? false,
        options.archiveDelivery ?? false,
        options.missingMessageId ?? false,
        options.sourceThreading,
        options.readOverrides ?? {},
        async (draft) => {
          draftMirrorAttempts.push(structuredClone(draft));
          await options.onDraftMirror?.(draft);
        },
        options.onDraftRemove,
        options.draftRemoveFailure,
        options.providerDraftState,
        options.onDraftUpdate,
        options.rotateDraftRefOnUpdate ?? false,
        options.downloadAttachment,
      );
      providers.set(accountId, provider);
      return provider;
    },
    (account, credentials) => {
      connections.push(structuredClone(credentials));
      return new TestMailSender(account.id, async (input, receipt, context) => {
        sent.push(structuredClone(input));
        sendContexts.push(context ? structuredClone(context) : undefined);
        const provider = providers.get(account.id);
        if (provider instanceof TestMailProvider) {
          provider.appendSent(input, receipt.messageId, receipt.submittedAt, context);
        }
      }, options.smtpFailure, {
        onAttempt: (input, content) => {
          sendContents.push(content ? structuredClone(content) : undefined);
          sendAttempts.push(structuredClone(input));
          options.onSendAttempt?.();
        },
        wait: options.sendWait,
        failure: options.sendFailure,
        rejectRecipients: options.rejectRecipients ?? [],
        receiptAccountId: options.receiptAccountId ?? account.id,
      });
    },
  );
  await service.initialize();
  return {
    store,
    service,
    sent,
    sendAttempts,
    sendContexts,
    sendContents,
    connections,
    draftMirrorAttempts,
    providerForAccount: (accountId: string): MailProvider | undefined => providers.get(accountId),
    providerDrafts: async (accountId: string) => providers.get(accountId)?.listDrafts({ tenantId, accountId }) ?? [],
    replaceProviderDraftVersion: (accountId: string, id: string, version: number) => {
      const provider = providers.get(accountId);
      if (!(provider instanceof TestMailProvider)) throw new Error("Test provider is missing");
      provider.replaceDraftVersion(tenantId, id, version);
    },
  };
}

class TestMailProvider implements MailProvider {
  readonly #accountId: string;
  readonly #messages: TestMessage[];
  readonly #folders = new Map<string, { name: string; specialUse: Folder["specialUse"] }>([
    ["INBOX", { name: "Inbox", specialUse: "inbox" }],
    ["Archive", { name: "Archive", specialUse: "archive" }],
    ["Sent", { name: "Sent", specialUse: "sent" }],
    ["Trash", { name: "Trash", specialUse: "trash" }],
    ["Drafts", { name: "Drafts", specialUse: "drafts" }],
  ]);
  readonly #drafts: Map<string, ProviderDraft>;
  readonly #verificationFailure: Error | undefined;
  readonly #moveChangesUid: boolean;
  readonly #readOverrides: Partial<ProviderMessageDetail>;
  readonly #onDraftMirror: (draft: Draft) => void | Promise<void>;
  readonly #onDraftRemove: ((draftId: string) => void | Promise<void>) | undefined;
  readonly #draftRemoveFailure: (() => Error | undefined) | undefined;
  readonly #onDraftUpdate: ((draft: Draft, ref: ProviderDraftRef) => void | Promise<void>) | undefined;
  readonly #rotateDraftRefOnUpdate: boolean;
  readonly #downloadAttachment: TestHarnessOptions["downloadAttachment"];

  constructor(
    accountId: string,
    verificationFailure: Error | undefined,
    duplicateDelivery: boolean,
    archiveDelivery: boolean,
    missingMessageId: boolean,
    sourceThreading: TestHarnessOptions["sourceThreading"],
    readOverrides: Partial<ProviderMessageDetail>,
    onDraftMirror: (draft: Draft) => void | Promise<void>,
    onDraftRemove: ((draftId: string) => void | Promise<void>) | undefined,
    draftRemoveFailure: (() => Error | undefined) | undefined,
    draftState: Map<string, ProviderDraft> | undefined,
    onDraftUpdate: ((draft: Draft, ref: ProviderDraftRef) => void | Promise<void>) | undefined,
    rotateDraftRefOnUpdate: boolean,
    downloadAttachment: TestHarnessOptions["downloadAttachment"],
  ) {
    this.#accountId = accountId;
    this.#messages = testMessages(accountId, duplicateDelivery, archiveDelivery);
    this.#moveChangesUid = missingMessageId;
    this.#readOverrides = structuredClone(readOverrides);
    this.#onDraftMirror = onDraftMirror;
    this.#onDraftRemove = onDraftRemove;
    this.#draftRemoveFailure = draftRemoveFailure;
    this.#onDraftUpdate = onDraftUpdate;
    this.#rotateDraftRefOnUpdate = rotateDraftRefOnUpdate;
    this.#downloadAttachment = downloadAttachment;
    this.#drafts = draftState ?? new Map();
    if (missingMessageId) {
      this.#messages[0]!.messageId = "missing-message-id";
      this.#messages[0]!.inReplyTo = "<parent@example.test>";
      this.#messages[0]!.references = ["<root@example.test>", "<parent@example.test>"];
    }
    if (sourceThreading) {
      this.#messages[0]!.messageId = sourceThreading.messageId;
      this.#messages[0]!.inReplyTo = sourceThreading.inReplyTo;
      this.#messages[0]!.references = [...sourceThreading.references];
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

  async createDraft(scope: ProviderDraftScope, draft: Draft): Promise<ProviderDraftRef> {
    this.#assertDraftScope(scope, draft);
    return this.#storeDraft(scope, draft);
  }

  async updateDraft(scope: ProviderDraftScope, draft: Draft, ref: ProviderDraftRef): Promise<ProviderDraftRef> {
    this.#assertDraftScope(scope, draft);
    if (ref.kind !== "imap") throw new Error("Test IMAP provider received another provider's reference");
    const current = this.#drafts.get(draftStateKey(scope, draft.id));
    if (this.#rotateDraftRefOnUpdate && current?.ref.kind === "imap"
      && (current.ref.mailbox !== ref.mailbox
        || current.ref.uidValidity !== ref.uidValidity
        || current.ref.uid !== ref.uid)) {
      throw new Error("Test provider received a stale draft reference");
    }
    await this.#onDraftUpdate?.(draft, structuredClone(ref));
    const existingUid = !this.#rotateDraftRefOnUpdate && current?.ref.kind === "imap"
      ? current.ref.uid
      : undefined;
    return this.#storeDraft(scope, draft, existingUid);
  }

  async listDrafts(scope: ProviderDraftScope): Promise<ProviderDraft[]> {
    this.#assertDraftScope(scope);
    return [...this.#drafts.values()]
      .filter((draft) => draft.tenantId === scope.tenantId && draft.accountId === scope.accountId)
      .map((draft) => structuredClone(draft));
  }

  async removeDraft(scope: ProviderDraftScope, postreeveId: string, ref?: ProviderDraftRef): Promise<void> {
    this.#assertDraftScope(scope);
    if (ref?.kind === "gmail") throw new Error("Test IMAP provider received another provider's reference");
    await this.#onDraftRemove?.(postreeveId);
    const failure = this.#draftRemoveFailure?.();
    if (failure) throw failure;
    this.#drafts.delete(draftStateKey(scope, postreeveId));
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

  async readMessages(accountId: string, references: MessageRef[]): Promise<ProviderMessageDetail[]> {
    this.#assertAccount(accountId);
    return references.map((reference) => {
      const message = this.#find(reference);
      if (!message) throw new Error(`Message UID ${reference.uid} is stale or missing`);
      return { ...toDetail(message), attachments: [], ...structuredClone(this.#readOverrides) };
    });
  }

  async downloadAttachment(
    accountId: string,
    locator: ProviderAttachmentLocator,
    maxBytes: number,
  ): Promise<ProviderAttachmentDownload> {
    if (!this.#downloadAttachment) throw new Error("Test message has no attachment");
    return this.#downloadAttachment(accountId, locator, maxBytes);
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

  appendSent(input: SendMessageInput, messageId: string, sentAt: string, context?: ConversationSendContext): void {
    const uid = Math.max(0, ...this.#messages.map((message) => message.ref.uid)) + 1;
    const ref: MessageRef = { accountId: this.#accountId, mailbox: "Sent", uidValidity, uid, modseq: "1" };
    this.#messages.push({
      ref,
      mailbox: "Sent",
      messageId,
      ...(context?.type === "reply" || context?.type === "reply_all" ? {
        inReplyTo: context.inReplyTo,
        references: [...context.references],
      } : {}),
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

  replaceDraftVersion(tenantId: string, id: string, version: number): void {
    const key = draftStateKey({ tenantId, accountId: this.#accountId }, id);
    const draft = this.#drafts.get(key);
    if (!draft) throw new Error("Test provider draft is missing");
    this.#drafts.set(key, { ...draft, version });
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

  #assertDraftScope(scope: ProviderDraftScope, draft?: Draft): void {
    this.#assertAccount(scope.accountId);
    if (!scope.tenantId.trim()) throw new Error("A tenant ID is required for provider drafts");
    if (draft) this.#assertAccount(draft.accountId);
  }

  async #storeDraft(scope: ProviderDraftScope, draft: Draft, existingUid?: number): Promise<ProviderDraftRef> {
    await this.#onDraftMirror(draft);
    const uid = existingUid ?? Math.max(0, ...[...this.#drafts.values()].flatMap(({ ref }) => ref.kind === "imap" ? [ref.uid] : [])) + 1;
    const ref: ProviderDraftRef = { kind: "imap", mailbox: "Drafts", uidValidity, uid };
    this.#drafts.set(draftStateKey(scope, draft.id), {
      tenantId: scope.tenantId,
      accountId: draft.accountId,
      postreeveId: draft.id,
      version: draft.version,
      ref,
    });
    return ref;
  }
}

function draftStateKey(scope: ProviderDraftScope, draftId: string): string {
  return JSON.stringify([scope.tenantId, scope.accountId, draftId]);
}

class TestMailSender implements MailSender {
  readonly #accountId: string;
  readonly #onSent: (
    input: SendMessageInput,
    receipt: SendReceipt,
    context?: ConversationSendContext,
  ) => void | Promise<void>;
  readonly #verificationFailure: Error | undefined;
  readonly #behavior: {
    readonly onAttempt: (input: SendMessageInput, content?: OutgoingContent) => void;
    readonly wait: Promise<void> | undefined;
    readonly failure: Error | (() => Error | undefined) | undefined;
    readonly rejectRecipients: readonly string[];
    readonly receiptAccountId: string;
  };

  constructor(
    accountId: string,
    onSent: (input: SendMessageInput, receipt: SendReceipt, context?: ConversationSendContext) => void | Promise<void>,
    verificationFailure?: Error,
    behavior: {
      readonly onAttempt: (input: SendMessageInput, content?: OutgoingContent) => void;
      readonly wait: Promise<void> | undefined;
      readonly failure: Error | (() => Error | undefined) | undefined;
      readonly rejectRecipients: readonly string[];
      readonly receiptAccountId: string;
    } = {
      onAttempt: () => {},
      wait: undefined,
      failure: undefined,
      rejectRecipients: [],
      receiptAccountId: accountId,
    },
  ) {
    this.#accountId = accountId;
    this.#onSent = onSent;
    this.#verificationFailure = verificationFailure;
    this.#behavior = behavior;
  }

  async verifyConnection(): Promise<void> {
    if (this.#verificationFailure) throw this.#verificationFailure;
  }

  async send(rawInput: SendMessageInput, context?: ConversationSendContext, content?: OutgoingContent): Promise<SendReceipt> {
    const input = sendMessageInputSchema.parse(rawInput);
    if (input.accountId !== this.#accountId) throw new Error("Account isolation violation");
    this.#behavior.onAttempt(input, content);
    await this.#behavior.wait;
    const failure = typeof this.#behavior.failure === "function"
      ? this.#behavior.failure()
      : this.#behavior.failure;
    if (failure) throw failure;
    const id = crypto.randomUUID();
    const recipients = [...input.to, ...input.cc, ...input.bcc].map(({ address }) => address);
    const rejected = new Set(this.#behavior.rejectRecipients.map((address) => address.toLocaleLowerCase()));
    const receipt = sendReceiptSchema.parse({
      id,
      accountId: this.#behavior.receiptAccountId,
      messageId: `<${id}@example.test>`,
      accepted: recipients.filter((address) => !rejected.has(address.toLocaleLowerCase())),
      rejected: recipients.filter((address) => rejected.has(address.toLocaleLowerCase())),
      submittedAt: new Date().toISOString(),
    });
    if (receipt.accepted.length > 0) await this.#onSent(input, receipt, context);
    return receipt;
  }
}

function toSummary(message: TestMessage): MessageSummary {
  const { html: _html, text: _text, mailbox: _mailbox, ...summary } = message;
  return structuredClone(summary);
}

function toDetail(message: TestMessage): Omit<MessageDetail, "attachments"> {
  const { mailbox: _mailbox, ...detail } = message;
  return structuredClone(detail);
}

function testMessages(accountId: string, duplicateDelivery: boolean, archiveDelivery: boolean): TestMessage[] {
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
  if (archiveDelivery) {
    messages.push({
      ...structuredClone(messages[0]!),
      ref: { accountId, mailbox: "Archive", uidValidity, uid: 105, modseq: "3", providerId: "archive-copy-105" },
      mailbox: "Archive",
      text: "Archived full body.",
      html: "<p>Archived full body.</p>",
      read: true,
      flagged: false,
    });
  }
  return messages;
}
