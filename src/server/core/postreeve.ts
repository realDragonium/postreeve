import type {
  Account,
  AccountSettings,
  CanonicalConversation,
  CanonicalMessageDetail,
  CanonicalMessageSummary,
  CreateDraftInput,
  CreateAccountInput,
  CreateFolderInput,
  CreateProposalInput,
  DeleteFolderInput,
  DirectActionInput,
  Draft,
  DraftRecipientField,
  DraftVersionInput,
  Folder,
  ListMessagesInput,
  MessageRef,
  OperationBatch,
  OperationResult,
  OutboundAddress,
  Proposal,
  ProviderDraftRef,
  RenameFolderInput,
  SendMessageInput,
  SendReceipt,
  UpdateDraftInput,
  UpdateProposalInput,
  UpdateAccountInput,
} from "../../shared/contracts";
import {
  createFolderInputSchema,
  createDraftInputSchema,
  createProposalInputSchema,
  deleteFolderInputSchema,
  directActionInputSchema,
  draftSchema,
  draftVersionInputSchema,
  renameFolderInputSchema,
  sendMessageInputSchema,
  sendReceiptSchema,
  updateDraftInputSchema,
  updateProposalInputSchema,
} from "../../shared/contracts";
import { uniqueCanonicalMessages } from "../../shared/canonical-messages";
import type { Store, StoredAccount, StoredBatch } from "../db/store";
import type { StoredOperation } from "../db/schema";
import {
  MailProviderRegistry,
  toCanonicalObservation,
  type MailProvider,
  type ProviderMessageDetail,
  type ProviderLocationMove,
  type ProviderMessageSummary,
  type ProviderDraft,
} from "../mail/provider";
import {
  MailSendPreDispatchError,
  MailSenderRegistry,
  type ConversationSendContext,
  type MailSender,
} from "../mail/sender";
import { DraftConflictError, DraftNotFoundError } from "./errors";
import { normalizeMessageId, normalizeMessageIdList, normalizeMessageIdLists } from "../mail/message-id";
import {
  CredentialVault,
  type AccountCredentials,
  type GmailAccountCredentials,
  type ImapAccountCredentials,
  type ImapCredentials,
} from "../security/credentials";

export type ImapProviderFactory = (accountId: string, credentials: ImapCredentials) => MailProvider;
export type MailSenderFactory = (account: Account & { kind: "imap" }, credentials: ImapAccountCredentials) => MailSender;
export type GmailClientFactory = (
  account: Account & { kind: "gmail" },
  credentials: GmailAccountCredentials,
) => { provider: MailProvider; sender: MailSender };

export interface PostreeveContext {
  tenantId: string;
}

interface PreparedMessageSend {
  readonly account: StoredAccount;
  readonly input: SendMessageInput;
  readonly sender: MailSender;
  readonly context?: ConversationSendContext;
}

const draftClaimOwner = crypto.randomUUID();
const draftReconciliationLimit = 100;
const draftLifecycleTurns = new Map<string, Promise<void>>();

export class PostreeveService {
  readonly #store: Store;
  readonly #context: PostreeveContext;
  readonly #providers: MailProviderRegistry;
  readonly #senders: MailSenderRegistry;
  readonly #vault: CredentialVault;
  readonly #imapProviderFactory: ImapProviderFactory;
  readonly #mailSenderFactory: MailSenderFactory;
  readonly #gmailClientFactory: GmailClientFactory;

  constructor(
    store: Store,
    context: PostreeveContext,
    providers: MailProviderRegistry,
    senders: MailSenderRegistry,
    vault: CredentialVault,
    imapProviderFactory: ImapProviderFactory,
    mailSenderFactory: MailSenderFactory,
    gmailClientFactory: GmailClientFactory = () => {
      throw new Error("Google account support is not configured");
    },
  ) {
    if (!context.tenantId.trim()) throw new Error("A tenant ID is required");
    this.#store = store;
    this.#context = context;
    this.#providers = providers;
    this.#senders = senders;
    this.#vault = vault;
    this.#imapProviderFactory = imapProviderFactory;
    this.#mailSenderFactory = mailSenderFactory;
    this.#gmailClientFactory = gmailClientFactory;
  }

  async initialize(): Promise<void> {
    const accounts = await this.#store.listAccounts();
    for (const account of accounts) this.#registerStoredAccount(account);
  }

  async recoverInterruptedDraftSends(): Promise<Draft[]> {
    return this.#store.recoverInterruptedDraftSends(
      this.#context.tenantId,
      draftClaimOwner,
      new Date().toISOString(),
    );
  }

  async listAccounts(): Promise<Account[]> {
    return (await this.#store.listAccounts()).map(toPublicAccount);
  }

  async createAccount(input: CreateAccountInput): Promise<Account> {
    const id = crypto.randomUUID();
    const publicAccount: Account & { kind: "imap" } = { id, name: input.name, email: input.email, kind: "imap" };
    const credentials: ImapAccountCredentials = {
      kind: "imap",
      imap: {
        host: input.host,
        port: input.port,
        secure: input.secure,
        username: input.username,
        password: input.password,
      },
      smtp: {
        host: input.smtpHost,
        port: input.smtpPort,
        secure: input.smtpSecure,
        username: input.smtpUsername,
        password: input.smtpPassword,
      },
    };
    const clients = await this.#verifiedClients(publicAccount, credentials);
    const account: StoredAccount = {
      ...publicAccount,
      encryptedCredentials: this.#vault.encrypt(credentials),
    };
    await this.#store.insertAccount(account);
    this.#registerClients(id, clients);
    return publicAccount;
  }

  async testNewAccountConnection(input: CreateAccountInput): Promise<void> {
    const account: Account & { kind: "imap" } = { id: crypto.randomUUID(), name: input.name, email: input.email, kind: "imap" };
    await this.#verifiedClients(account, {
      kind: "imap",
      imap: {
        host: input.host,
        port: input.port,
        secure: input.secure,
        username: input.username,
        password: input.password,
      },
      smtp: {
        host: input.smtpHost,
        port: input.smtpPort,
        secure: input.smtpSecure,
        username: input.smtpUsername,
        password: input.smtpPassword,
      },
    });
  }

  async getAccountSettings(id: string): Promise<AccountSettings> {
    const account = await this.#requireAccount(id);
    const credentials = this.#credentialsFor(account);
    if (credentials.kind !== "imap") throw new Error("Google account access is managed through Google authorization");
    if (!credentials.smtp) throw new Error("This account has no outgoing-mail settings; reconnect it before editing");
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      kind: "imap",
      host: credentials.imap.host,
      port: credentials.imap.port,
      secure: credentials.imap.secure,
      username: credentials.imap.username,
      smtpHost: credentials.smtp.host,
      smtpPort: credentials.smtp.port,
      smtpSecure: credentials.smtp.secure,
      smtpUsername: credentials.smtp.username,
    };
  }

  async testAccountConnection(id: string, input: UpdateAccountInput): Promise<void> {
    const account = await this.#requireAccount(id);
    const { publicAccount, credentials } = this.#updatedConnection(account, input);
    await this.#verifiedClients(publicAccount, credentials);
  }

  async updateAccount(id: string, input: UpdateAccountInput): Promise<Account> {
    const account = await this.#requireAccount(id);
    const { publicAccount, credentials } = this.#updatedConnection(account, input);
    const clients = await this.#verifiedClients(publicAccount, credentials);
    await this.#store.updateAccount({
      ...publicAccount,
      encryptedCredentials: this.#vault.encrypt(credentials),
    });
    this.#registerClients(id, clients);
    return publicAccount;
  }

  async removeAccount(id: string): Promise<void> {
    await this.#withDraftLifecycle(id, "account-removal", async () => {
      if (!await this.#store.deleteAccount(id)) throw new Error("Account not found");
      this.#providers.remove(id);
      this.#senders.remove(id);
    });
  }

  async connectGmailAccount(email: string, refreshToken: string): Promise<Account> {
    const credentials: GmailAccountCredentials = { kind: "gmail", refreshToken };
    const existing = (await this.#store.listAccounts())
      .find((account) => account.kind === "gmail" && account.email.toLocaleLowerCase() === email.toLocaleLowerCase());
    const publicAccount: Account & { kind: "gmail" } = existing
      ? { id: existing.id, name: existing.name, email, kind: "gmail" }
      : { id: crypto.randomUUID(), name: "Gmail", email, kind: "gmail" };
    const clients = this.#gmailClientFactory(publicAccount, credentials);
    await clients.provider.verifyConnection();
    const stored: StoredAccount = {
      ...publicAccount,
      encryptedCredentials: this.#vault.encrypt(credentials),
    };
    if (existing) await this.#store.updateAccount(stored);
    else await this.#store.insertAccount(stored);
    this.#registerClients(publicAccount.id, clients);
    return publicAccount;
  }

  async listFolders(accountId: string): Promise<Folder[]> {
    await this.#requireAccount(accountId);
    return this.#providers.forAccount(accountId).listFolders(accountId);
  }

  async createFolder(rawInput: CreateFolderInput): Promise<Folder[]> {
    const input = createFolderInputSchema.parse(rawInput);
    await this.#requireAccount(input.accountId);
    const provider = this.#providers.forAccount(input.accountId);
    await provider.createFolder(input.accountId, input.name);
    return provider.listFolders(input.accountId);
  }

  async renameFolder(rawInput: RenameFolderInput): Promise<Folder[]> {
    const input = renameFolderInputSchema.parse(rawInput);
    await this.#requireAccount(input.accountId);
    const provider = this.#providers.forAccount(input.accountId);
    await provider.renameFolder(input.accountId, input.path, input.name);
    return provider.listFolders(input.accountId);
  }

  async deleteFolder(rawInput: DeleteFolderInput): Promise<Folder[]> {
    const input = deleteFolderInputSchema.parse(rawInput);
    await this.#requireAccount(input.accountId);
    const provider = this.#providers.forAccount(input.accountId);
    await provider.deleteFolder(input.accountId, input.path);
    return provider.listFolders(input.accountId);
  }

  async listMessages(input: ListMessagesInput): Promise<CanonicalMessageSummary[]> {
    const account = await this.#requireAccount(input.accountId);
    const provider = this.#providers.forAccount(input.accountId);
    if (input.query) {
      const messages = await provider.searchMessages(input.accountId, input.mailbox, input.query, input.limit);
      return this.#persistObservedMessages(account, input.mailbox, messages, false);
    }

    const page = await provider.listMessagePage(input.accountId, input.mailbox, input.limit);
    return this.#persistObservedMessages(account, input.mailbox, page.messages, page.complete);
  }

  async searchMessages(input: ListMessagesInput & { query: string }): Promise<CanonicalMessageSummary[]> {
    const account = await this.#requireAccount(input.accountId);
    const messages = await this.#providers.forAccount(input.accountId)
      .searchMessages(input.accountId, input.mailbox, input.query, input.limit);
    return this.#persistObservedMessages(account, input.mailbox, messages, false);
  }

  async getConversation(id: string): Promise<CanonicalConversation> {
    const conversation = await this.#store.getConversation(this.#context.tenantId, id);
    if (!conversation) throw new Error("Conversation not found");
    return conversation;
  }

  async readMessages(references: MessageRef[]): Promise<CanonicalMessageDetail[]> {
    if (references.length === 0) return [];
    const accountId = references[0]!.accountId;
    if (references.some((reference) => reference.accountId !== accountId)) {
      throw new Error("Messages from different accounts cannot be read in one request");
    }
    const account = await this.#requireAccount(accountId);
    const details = await this.#providers.forAccount(accountId).readMessages(accountId, references);
    if (details.length !== references.length) {
      throw new Error("Provider read result count does not match references");
    }

    const canonicalByIndex = new Map<number, string>();
    const mailboxGroups = new Map<string, Array<{ detail: typeof details[number]; index: number }>>();
    for (const [index, detail] of details.entries()) {
      if (detail.ref.accountId !== accountId) throw new Error("Provider read returned a message from a different account");
      const group = mailboxGroups.get(detail.ref.mailbox) ?? [];
      group.push({ detail, index });
      mailboxGroups.set(detail.ref.mailbox, group);
    }
    for (const [mailbox, group] of mailboxGroups) {
      const canonical = await this.#store.reconcileMailbox({
        tenantId: this.#context.tenantId,
        accountId,
        provider: account.kind,
        mailbox,
        observations: group.map(({ detail }) => toCanonicalObservation(this.#context.tenantId, account.kind, detail)),
        authoritative: false,
      });
      if (canonical.length !== group.length) throw new Error("Canonical reconciliation result count does not match observations");
      group.forEach(({ index }, groupIndex) => canonicalByIndex.set(index, canonical[groupIndex]!.id));
    }

    return Promise.all(details.map(async (detail, index) => {
      const observedId = canonicalByIndex.get(index);
      if (!observedId) throw new Error("Canonical read result is missing");
      const canonical = await this.#store.getMessage(this.#context.tenantId, observedId);
      if (!canonical) throw new Error("Canonical read message is missing");
      const {
        providerConversationId: _providerConversationId,
        canonicalReceivedAt: _canonicalReceivedAt,
        referenceSequences: _referenceSequences,
        ...publicDetail
      } = detail;
      return {
        ...publicDetail,
        canonicalId: canonical.id,
        canonicalAliases: canonical.aliases,
        conversationId: canonical.conversationId,
        ...(_providerConversationId ? { providerConversationId: _providerConversationId } : {}),
      };
    }));
  }

  async sendMessage(rawInput: SendMessageInput): Promise<SendReceipt> {
    const input = sendMessageInputSchema.parse(rawInput);
    return this.#dispatchMessageSend(await this.#prepareMessageSend(input));
  }

  async createDraft(rawInput: CreateDraftInput): Promise<Draft> {
    const input = createDraftInputSchema.parse(rawInput);
    const { clientId, ...content } = input;
    const now = new Date().toISOString();
    const draft = draftSchema.parse({
      ...content,
      id: clientId ?? crypto.randomUUID(),
      delivery: { status: "editable" },
      mirror: { status: "pending" },
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    return this.#withDraftLifecycle(input.accountId, draft.id, async () => {
      await this.#requireAccount(input.accountId);
      const stored = await this.#store.insertDraft(this.#context.tenantId, draft);
      if (stored.delivery.status === "sent" || stored.delivery.status === "sending") return stored;
      return this.#mirrorDraftLocked(stored, true);
    });
  }

  async listDrafts(accountId: string): Promise<Draft[]> {
    await this.#requireAccount(accountId);
    await this.#reconcileDrafts(accountId);
    return this.#store.listDrafts(this.#context.tenantId, accountId);
  }

  async getDraft(accountId: string, id: string): Promise<Draft> {
    await this.#requireAccount(accountId);
    await this.#reconcileDrafts(accountId);
    const draft = await this.#store.getDraft(this.#context.tenantId, accountId, id);
    if (!draft) throw new DraftNotFoundError();
    return draft;
  }

  async updateDraft(accountId: string, id: string, rawInput: UpdateDraftInput): Promise<Draft> {
    const input = updateDraftInputSchema.parse(rawInput);
    const { version, ...content } = input;
    return this.#withDraftLifecycle(accountId, id, async () => {
      await this.#requireAccount(accountId);
      const draft = await this.#store.updateDraft(
        this.#context.tenantId,
        accountId,
        id,
        version,
        content,
        new Date().toISOString(),
      );
      return this.#mirrorDraftLocked(draft, true);
    });
  }

  async removeDraft(accountId: string, id: string, rawInput: DraftVersionInput): Promise<void> {
    const { version } = draftVersionInputSchema.parse(rawInput);
    return this.#withDraftLifecycle(accountId, id, () => this.#removeDraftLocked(accountId, id, version));
  }

  async #removeDraftLocked(accountId: string, id: string, version: number): Promise<void> {
    await this.#requireAccount(accountId);
    const draft = await this.#store.getDraft(this.#context.tenantId, accountId, id);
    if (!draft) throw new DraftNotFoundError();
    if (draft.version !== version) throw new DraftConflictError();
    if (draft.delivery.status === "sending") throw new DraftConflictError("Draft cannot be removed while delivery is sending");
    try {
      await this.#providers.forAccount(accountId).removeDraft(accountId, id, draft.mirror.ref);
    } catch (error) {
      await this.#store.failDraftMirror(this.#context.tenantId, accountId, id, version, errorMessage(error));
      throw error;
    }
    try {
      await this.#store.deleteDraft(this.#context.tenantId, accountId, id, version);
    } catch (error) {
      const current = await this.#store.getDraft(this.#context.tenantId, accountId, id);
      if (current && current.delivery.status !== "sent") await this.#mirrorDraftLocked(current, false);
      throw error;
    }
  }

  async copyDraftForRecovery(accountId: string, id: string, rawInput: DraftVersionInput): Promise<Draft> {
    const { version } = draftVersionInputSchema.parse(rawInput);
    return this.#withDraftLifecycle(accountId, id, async () => {
      await this.#requireAccount(accountId);
      const copy = await this.#store.copyUncertainDraft(
        this.#context.tenantId,
        accountId,
        id,
        version,
        crypto.randomUUID(),
        new Date().toISOString(),
      );
      const original = await this.#store.getDraft(this.#context.tenantId, accountId, id);
      if (original) await this.#mirrorDraftLocked(original, false);
      return this.#mirrorDraftLocked(copy, true);
    });
  }

  async sendDraft(accountId: string, id: string, rawInput: DraftVersionInput): Promise<SendReceipt> {
    const { version } = draftVersionInputSchema.parse(rawInput);
    const draft = await this.getDraft(accountId, id);
    if (draft.delivery.status === "sent") {
      const warning = await this.#cleanupProviderDraft(draft);
      return warning ? withReceiptWarning(draft.delivery.receipt, warning) : draft.delivery.receipt;
    }
    if (draft.version !== version) throw new DraftConflictError();
    if (draft.delivery.status === "sending") {
      throw new DraftConflictError("Draft delivery is already in progress");
    }
    if (draft.delivery.status === "uncertain") {
      throw new DraftConflictError("Draft delivery is uncertain and cannot be retried automatically");
    }
    if (draft.attachments.length > 0) {
      throw new Error("Draft attachment delivery is not supported yet");
    }
    const account = await this.#requireAccount(accountId);
    if (draft.identity.address.toLocaleLowerCase() !== account.email.toLocaleLowerCase()) {
      throw new Error("Draft identity does not belong to the selected account");
    }
    const intent = draft.mode === "new"
      ? { type: "new" as const }
      : draft.source
        ? { type: draft.mode, source: draft.source }
        : null;
    if (!intent) throw new Error("Conversation draft source was not found");
    const input = sendMessageInputSchema.parse({
      accountId,
      to: draftRecipientsForSend(draft.to),
      cc: draftRecipientsForSend(draft.cc),
      bcc: draftRecipientsForSend(draft.bcc),
      subject: draft.subject,
      text: draft.body,
      intent,
    });
    const prepared = await this.#prepareMessageSend(input);
    const claim = await this.#store.claimDraftSend(
      this.#context.tenantId,
      accountId,
      id,
      version,
      new Date().toISOString(),
      draftClaimOwner,
    );
    if (claim.kind === "sent") return claim.receipt;

    let receipt: SendReceipt;
    try {
      receipt = await this.#dispatchMessageSend(prepared);
    } catch (error) {
      const failedAt = new Date().toISOString();
      try {
        if (error instanceof MailSendPreDispatchError) {
          await this.#store.markDraftSendFailed(
            this.#context.tenantId,
            accountId,
            id,
            claim.draft.version,
            errorMessage(error),
            failedAt,
            draftClaimOwner,
          );
        } else {
          await this.#store.markDraftSendUncertain(
            this.#context.tenantId,
            accountId,
            id,
            claim.draft.version,
            errorMessage(error),
            failedAt,
            draftClaimOwner,
          );
        }
      } catch (persistenceError) {
        throw new Error(
          `${errorMessage(error)}; the draft remains claimed because its delivery state could not be persisted: ${errorMessage(persistenceError)}`,
        );
      }
      throw error;
    }

    try {
      const settled = await this.#store.settleDraftSend(
        this.#context.tenantId,
        accountId,
        id,
        claim.draft.version,
        receipt,
        draftClaimOwner,
      );
      const warning = await this.#cleanupProviderDraft(settled);
      return warning ? withReceiptWarning(receipt, warning) : receipt;
    } catch (settlementError) {
      const recoveredAt = new Date().toISOString();
      let recoveryError: unknown;
      try {
        if (receipt.accepted.length > 0) {
          await this.#store.markDraftSendUncertain(
            this.#context.tenantId,
            accountId,
            id,
            claim.draft.version,
            "Delivery was accepted, but its receipt could not be stored",
            recoveredAt,
            draftClaimOwner,
          );
        } else {
          await this.#store.markDraftSendFailed(
            this.#context.tenantId,
            accountId,
            id,
            claim.draft.version,
            "No recipients were accepted for delivery",
            recoveredAt,
            draftClaimOwner,
          );
        }
      } catch (error) {
        recoveryError = error;
      }
      const recovered = await this.#store.getDraft(this.#context.tenantId, accountId, id);
      const cleanupWarning = receipt.accepted.length > 0 && recovered
        ? await this.#cleanupProviderDraft(recovered)
        : undefined;
      return sendReceiptSchema.parse({
        ...receipt,
        warning: [
          receipt.warning,
          `Delivery completed, but the local draft receipt could not be stored: ${errorMessage(settlementError)}.`,
          recoveryError
            ? `Its recoverable delivery state also could not be stored: ${errorMessage(recoveryError)}. Automatic retry remains blocked.`
            : "The draft remains recoverable without automatic retry.",
          cleanupWarning,
        ].filter((message): message is string => message !== undefined).join(" "),
      });
    }
  }

  async #mirrorDraftLocked(draft: Draft, repairStale: boolean): Promise<Draft> {
    const provider = this.#providers.forAccount(draft.accountId);
    let ref: ProviderDraftRef;
    try {
      ref = draft.mirror.ref
        ? await provider.updateDraft(draft.accountId, draft, draft.mirror.ref)
        : await provider.createDraft(draft.accountId, draft);
    } catch (error) {
      const message = errorMessage(error);
      try {
        const recorded = await this.#store.failDraftMirror(
          this.#context.tenantId,
          draft.accountId,
          draft.id,
          draft.version,
          message,
        );
        if (!recorded && repairStale) return this.#repairStaleMirrorLocked(draft, undefined);
        return await this.#store.getDraft(this.#context.tenantId, draft.accountId, draft.id) ?? {
          ...draft,
          mirror: mirrorFailure(draft, message),
        };
      } catch (persistenceError) {
        return {
          ...draft,
          mirror: mirrorFailure(draft, `Provider mirror failed: ${message}; its failure could not be stored: ${errorMessage(persistenceError)}`),
        };
      }
    }
    try {
      const recorded = await this.#store.completeDraftMirror(
        this.#context.tenantId,
        draft.accountId,
        draft.id,
        draft.version,
        ref,
      );
      if (!recorded && repairStale) return this.#repairStaleMirrorLocked(draft, ref);
      return await this.#store.getDraft(this.#context.tenantId, draft.accountId, draft.id) ?? draft;
    } catch (persistenceError) {
      return {
        ...draft,
        mirror: mirrorFailure(
          draft,
          `Provider draft version ${draft.version} was stored, but its mirror state could not be persisted: ${errorMessage(persistenceError)}`,
          ref,
        ),
      };
    }
  }

  async #repairStaleMirrorLocked(completed: Draft, ref: ProviderDraftRef | undefined): Promise<Draft> {
    const current = await this.#store.getDraft(this.#context.tenantId, completed.accountId, completed.id);
    if (!current) {
      await this.#providers.forAccount(completed.accountId).removeDraft(completed.accountId, completed.id, ref);
      return completed;
    }
    if (current.delivery.status === "sent") {
      await this.#cleanupProviderDraftLocked(current);
      return current;
    }
    return this.#mirrorDraftLocked(current, false);
  }

  async #reconcileDrafts(accountId: string): Promise<void> {
    return this.#withDraftLifecycle(accountId, "reconciliation", async () => {
      await this.#requireAccount(accountId);
      await this.#reconcileDraftsLocked(accountId);
    });
  }

  async #reconcileDraftsLocked(accountId: string): Promise<void> {
    const allLocal = await this.#store.listDrafts(this.#context.tenantId, accountId);
    let providerDrafts: ProviderDraft[];
    try {
      providerDrafts = (await this.#providers.forAccount(accountId).listDrafts(accountId))
        .filter((draft) => draft.accountId === accountId);
    } catch {
      return;
    }
    let remainingRepairs = draftReconciliationLimit;
    for (const draft of allLocal) {
      if (draft.delivery.status === "sending") continue;
      const matches = providerDrafts.filter(({ postreeveId }) => postreeveId === draft.id);
      const healthy = matches.length === 1
        && matches[0]!.version === draft.version
        && draft.mirror.status === "synced"
        && draft.mirror.mirroredVersion === draft.version
        && sameProviderRef(matches[0]!.ref, draft.mirror.ref);
      if (!healthy && remainingRepairs > 0) {
        await this.#mirrorDraftLocked(draft, false);
        remainingRepairs -= 1;
      }
    }
  }

  async #cleanupProviderDraft(draft: Draft): Promise<string | undefined> {
    return this.#withDraftLifecycle(draft.accountId, draft.id, async () => {
      const current = await this.#store.getDraft(this.#context.tenantId, draft.accountId, draft.id);
      return this.#cleanupProviderDraftLocked(current ?? draft);
    });
  }

  async #cleanupProviderDraftLocked(draft: Draft): Promise<string | undefined> {
    try {
      await this.#providers.forAccount(draft.accountId).removeDraft(draft.accountId, draft.id, draft.mirror.ref);
      return undefined;
    } catch (error) {
      const message = `Message delivery succeeded, but the provider draft could not be removed: ${errorMessage(error)}`;
      try {
        await this.#store.failDraftMirror(this.#context.tenantId, draft.accountId, draft.id, draft.version, message);
      } catch {
        return `${message}. The cleanup failure could not be persisted.`;
      }
      return message;
    }
  }

  async #withDraftLifecycle<T>(accountId: string, draftId: string, operation: () => Promise<T>): Promise<T> {
    const accountKey = JSON.stringify([
      this.#store.coordinationIdentity,
      this.#context.tenantId,
      accountId,
    ]);
    const draftKey = JSON.stringify([
      this.#store.coordinationIdentity,
      this.#context.tenantId,
      accountId,
      draftId,
    ]);
    return serializeDraftLifecycle(accountKey, () => serializeDraftLifecycle(draftKey, operation));
  }

  async #prepareMessageSend(input: SendMessageInput): Promise<PreparedMessageSend> {
    const account = await this.#requireAccount(input.accountId);
    const sender = this.#senders.forAccount(input.accountId);
    const intent = input.intent ?? { type: "new" as const };
    if (intent.type === "new") return { account, input, sender };

    const source = await this.#store.getMessage(this.#context.tenantId, intent.source.canonicalMessageId);
    const conversation = await this.#store.getConversation(this.#context.tenantId, intent.source.conversationId);
    if (!source || !conversation || source.conversationId !== conversation.id) {
      throw new Error("Conversation send source was not found");
    }
    const locations = await this.#store.listMessageLocations(this.#context.tenantId, source.id);
    const accountLocations = locations.filter(({ accountId }) => accountId === input.accountId);
    if (!await this.#store.hasMessageProviderAssociation(
      this.#context.tenantId,
      source.id,
      input.accountId,
      account.kind,
    )) {
      throw new Error("Conversation send source does not belong to the selected account");
    }
    if (intent.type === "forward") {
      const context: ConversationSendContext = {
        type: "forward",
        sourceMessageId: source.id,
        conversationId: source.conversationId,
      };
      return { account, input, sender, context };
    }

    const canonicalMessageId = normalizeMessageId(source.messageId);
    const canonicalReferences = normalizeMessageIdLists(source.references);
    const canonicalInReplyTo = normalizeMessageIdList(source.inReplyTo);
    const sourceProviderConversationId = account.kind === "gmail"
      ? await this.#store.getProviderConversationId(
        this.#context.tenantId,
        source.id,
        input.accountId,
        account.kind,
        intent.source.providerConversationId,
      )
      : null;
    const sourceDetail = sourceProviderConversationId
      ? await this.#readMessageForProviderConversation(
        input.accountId,
        accountLocations.map((location) => ({
          accountId: location.accountId,
          mailbox: location.mailbox,
          uidValidity: location.uidValidity,
          uid: location.uid,
          modseq: location.modseq,
          ...(location.providerId ? { providerId: location.providerId } : {}),
        })),
        sourceProviderConversationId,
      )
      : null;
    const selectedMessageId = normalizeMessageId(sourceDetail?.messageId);
    const selectedIdentityConflicts = canonicalMessageId !== null
      && selectedMessageId !== null
      && selectedMessageId !== canonicalMessageId;
    const selectedSourceIsConsistent = sourceDetail !== null
      && !selectedIdentityConflicts
      && (canonicalMessageId !== null || selectedMessageId !== null);
    const inReplyTo = canonicalMessageId ?? (selectedSourceIsConsistent ? selectedMessageId : null);
    const selectedReferences = selectedSourceIsConsistent
      ? normalizeMessageIdLists(sourceDetail.references ?? [])
      : [];
    const selectedInReplyTo = selectedSourceIsConsistent
      ? normalizeMessageIdList(sourceDetail.inReplyTo)
      : [];
    const parentReferences = selectedReferences.length > 0
      ? selectedReferences
      : canonicalReferences.length > 0
        ? canonicalReferences
        : selectedInReplyTo.length === 1
          ? selectedInReplyTo
          : canonicalInReplyTo.length === 1
            ? canonicalInReplyTo
            : [];
    const references = normalizeMessageIdLists([...parentReferences, inReplyTo]);
    const providerConversationId = sourceProviderConversationId
      && sourceDetail
      && !selectedIdentityConflicts
      && inReplyTo
      && input.subject === replySubject(sourceDetail.subject)
      ? sourceProviderConversationId
      : null;
    const context: ConversationSendContext = {
      type: intent.type,
      sourceMessageId: source.id,
      conversationId: source.conversationId,
      ...(sourceDetail ? { sourceSubject: sourceDetail.subject } : {}),
      ...(inReplyTo ? { inReplyTo } : {}),
      references,
      ...(providerConversationId ? { providerConversationId } : {}),
    };
    return { account, input, sender, context };
  }

  async #dispatchMessageSend(prepared: PreparedMessageSend): Promise<SendReceipt> {
    const receipt = sendReceiptSchema.parse(await prepared.sender.send(prepared.input, prepared.context));
    if (receipt.accountId !== prepared.input.accountId) {
      throw new Error("Mail sender returned a receipt for another account");
    }
    return prepared.context && receipt.accepted.length > 0
      ? this.#recordConversationSend(prepared.input.accountId, prepared.account.kind, receipt, prepared.context)
      : receipt;
  }

  async applyDirectActions(rawInput: DirectActionInput): Promise<OperationBatch> {
    const input = directActionInputSchema.parse(rawInput);
    await this.#requireAccount(input.accountId);
    if (input.items.some(({ message }) => message.accountId !== input.accountId)) {
      throw new Error("Every direct action must belong to the selected account");
    }
    const proposal = await this.createProposal({
      accountId: input.accountId,
      title: `Direct mailbox action${input.items.length === 1 ? "" : "s"}`,
      items: input.items.map((item) => ({
        id: crypto.randomUUID(),
        message: item.message,
        subject: item.subject,
        action: item.action,
        reason: "Requested directly through Postreeve.",
      })),
    });
    await this.approveProposalFromHumanInterface(proposal.id);
    return this.applyApprovedProposal(proposal.id);
  }

  async createProposal(rawInput: CreateProposalInput): Promise<Proposal> {
    const input = createProposalInputSchema.parse(rawInput);
    await this.#requireAccount(input.accountId);
    if (input.items.some((item) => item.message.accountId !== input.accountId)) {
      throw new Error("Every proposal item must belong to the proposal account");
    }
    const now = new Date().toISOString();
    const proposal: Proposal = {
      id: crypto.randomUUID(),
      accountId: input.accountId,
      title: input.title,
      status: "draft",
      items: input.items,
      createdAt: now,
      updatedAt: now,
      approvedAt: null,
      batchId: null,
    };
    await this.#store.insertProposal(proposal);
    return proposal;
  }

  async listProposals(accountId: string): Promise<Proposal[]> {
    await this.#requireAccount(accountId);
    return this.#store.listProposals(accountId);
  }

  async getProposal(id: string): Promise<Proposal> {
    const proposal = await this.#store.getProposal(id);
    if (!proposal) throw new Error("Proposal not found");
    return proposal;
  }

  async updateProposal(id: string, rawInput: UpdateProposalInput): Promise<Proposal> {
    const input = updateProposalInputSchema.parse(rawInput);
    const proposal = await this.getProposal(id);
    if (proposal.status !== "draft" && proposal.status !== "review") {
      throw new Error("Only draft or review proposals can be edited");
    }
    const items = input.items ?? proposal.items;
    if (items.some((item) => item.message.accountId !== proposal.accountId)) {
      throw new Error("Every proposal item must belong to the proposal account");
    }
    const updated: Proposal = {
      ...proposal,
      title: input.title ?? proposal.title,
      items,
      status: input.status ?? proposal.status,
      updatedAt: new Date().toISOString(),
    };
    await this.#store.updateProposal(updated);
    return updated;
  }

  async approveProposalFromHumanInterface(id: string): Promise<Proposal> {
    const proposal = await this.getProposal(id);
    if (proposal.status !== "draft" && proposal.status !== "review") {
      throw new Error("Only a draft or review proposal can be approved");
    }
    const now = new Date().toISOString();
    const approved: Proposal = { ...proposal, status: "approved", approvedAt: now, updatedAt: now };
    await this.#store.updateProposal(approved);
    return approved;
  }

  async applyApprovedProposal(id: string): Promise<OperationBatch> {
    const proposal = await this.getProposal(id);
    if (proposal.status !== "approved" || !proposal.approvedAt) {
      throw new Error("Human approval is required before applying a proposal");
    }
    const applying: Proposal = { ...proposal, status: "applying", updatedAt: new Date().toISOString() };
    await this.#store.updateProposal(applying);
    const provider = this.#providers.forAccount(proposal.accountId);
    const storedOperations: StoredOperation[] = [];

    for (const item of proposal.items) {
      let operation: StoredOperation;
      try {
        if (!await provider.revalidate(item.message)) {
          throw new Error("Message is stale, changed, or missing");
        }
        if (item.action.type === "leave") {
          operation = { result: operationResult(item, "applied", null), applied: null };
        } else {
          const applied = await provider.apply(item.message, item.action);
          const identityError = await this.#recordProviderMove(proposal.accountId, applied);
          operation = { result: operationResult(item, "applied", identityError), applied };
        }
      } catch (error) {
        operation = { result: operationResult(item, "failed", errorMessage(error)), applied: null };
      }
      storedOperations.push(operation);
    }

    const succeeded = storedOperations.filter(({ result }) => result.status === "applied").length;
    const status = succeeded === storedOperations.length ? "applied"
      : succeeded === 0 ? "failed"
      : "partially_applied";
    const now = new Date().toISOString();
    const batch: StoredBatch = {
      id: crypto.randomUUID(),
      proposalId: proposal.id,
      accountId: proposal.accountId,
      status,
      operations: storedOperations.map(({ result }) => result),
      storedOperations,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.insertBatch(batch);
    await this.#store.updateProposal({ ...applying, status, batchId: batch.id, updatedAt: now });
    return toPublicBatch(batch);
  }

  async listBatches(accountId: string): Promise<OperationBatch[]> {
    await this.#requireAccount(accountId);
    return (await this.#store.listBatches(accountId)).map(toPublicBatch);
  }

  async undoBatch(id: string): Promise<OperationBatch> {
    const batch = await this.#store.getBatch(id);
    if (!batch) throw new Error("Operation batch not found");
    if (batch.status !== "applied" && batch.status !== "partially_applied") {
      throw new Error("Only an applied batch can be undone");
    }
    const provider = this.#providers.forAccount(batch.accountId);
    const storedOperations: StoredOperation[] = [];
    for (const operation of batch.storedOperations) {
      if (operation.result.status !== "applied" || !operation.applied) {
        storedOperations.push(operation.result.status === "failed" ? operation : {
          ...operation,
          result: { ...operation.result, status: "not_undoable", error: null },
        });
        continue;
      }
      try {
        const reversed = await provider.undo(operation.applied);
        const identityError = reversed ? await this.#recordProviderMove(batch.accountId, reversed) : null;
        storedOperations.push({
          ...operation,
          result: { ...operation.result, status: "undone", error: identityError },
        });
      } catch (error) {
        storedOperations.push({
          ...operation,
          result: { ...operation.result, status: "undo_failed", error: errorMessage(error) },
        });
      }
    }
    const undoable = storedOperations.filter(({ result }) => result.status === "undone" || result.status === "undo_failed");
    const status = undoable.every(({ result }) => result.status === "undone") ? "undone" : "partially_undone";
    const updated: StoredBatch = {
      ...batch,
      status,
      operations: storedOperations.map(({ result }) => result),
      storedOperations,
      updatedAt: new Date().toISOString(),
    };
    await this.#store.updateBatch(updated);
    const proposal = await this.getProposal(batch.proposalId);
    await this.#store.updateProposal({ ...proposal, status, updatedAt: updated.updatedAt });
    return toPublicBatch(updated);
  }

  async #recordProviderMove(accountId: string, move: ProviderLocationMove): Promise<string | null> {
    try {
      const account = await this.#requireAccount(accountId);
      const retained = await this.#store.recordProviderMove(
        this.#context.tenantId,
        account.kind,
        move.previous,
        move.current,
      );
      if (!retained) {
        return "Provider action succeeded, but local message identity could not be retained: source identity is unknown";
      }
      return null;
    } catch (error) {
      return `Provider action succeeded, but local message identity could not be retained: ${errorMessage(error)}`;
    }
  }

  async #recordConversationSend(
    accountId: string,
    provider: Account["kind"],
    receipt: SendReceipt,
    context: ConversationSendContext,
  ): Promise<SendReceipt> {
    try {
      await this.#store.recordConversationSend(this.#context.tenantId, accountId, provider, receipt, context);
      return receipt;
    } catch (error) {
      return sendReceiptSchema.parse({
        ...receipt,
        warning: `Message was accepted for delivery, but its local conversation could not be updated: ${errorMessage(error)}`,
      });
    }
  }

  async #readMessageForProviderConversation(
    accountId: string,
    references: readonly MessageRef[],
    providerConversationId: string,
  ): Promise<ProviderMessageDetail | null> {
    const provider = this.#providers.forAccount(accountId);
    for (const reference of references) {
      try {
        const [detail] = await provider.readMessages(accountId, [reference]);
        if (detail?.providerConversationId === providerConversationId) return detail;
      } catch {
        continue;
      }
    }
    return null;
  }

  #registerStoredAccount(account: StoredAccount): void {
    const credentials = this.#credentialsFor(account);
    this.#registerClients(account.id, this.#clientsFor(toPublicAccount(account), credentials));
  }

  async #persistObservedMessages(
    account: StoredAccount,
    mailbox: string,
    messages: ProviderMessageSummary[],
    authoritative: boolean,
  ): Promise<CanonicalMessageSummary[]> {
    const canonical = await this.#store.reconcileMailbox({
      tenantId: this.#context.tenantId,
      accountId: account.id,
      provider: account.kind,
      mailbox,
      observations: messages.map((message) => toCanonicalObservation(this.#context.tenantId, account.kind, message)),
      authoritative,
    });
    if (canonical.length !== messages.length) throw new Error("Canonical reconciliation result count does not match observations");
    return uniqueCanonicalMessages(messages.map((message, index) => {
      const {
        providerConversationId: _providerConversationId,
        canonicalReceivedAt: _canonicalReceivedAt,
        referenceSequences: _referenceSequences,
        ...publicMessage
      } = message;
      return {
        ...publicMessage,
        canonicalId: canonical[index]!.id,
        canonicalAliases: canonical[index]!.aliases,
        conversationId: canonical[index]!.conversationId,
      };
    }));
  }

  #credentialsFor(account: StoredAccount): AccountCredentials {
    if (!account.encryptedCredentials) throw new Error(`Mail account ${account.id} has no credentials`);
    return this.#vault.decrypt(account.encryptedCredentials);
  }

  #updatedConnection(account: StoredAccount, input: UpdateAccountInput): {
    publicAccount: Account & { kind: "imap" };
    credentials: ImapAccountCredentials;
  } {
    const current = this.#credentialsFor(account);
    if (account.kind !== "imap" || current.kind !== "imap") {
      throw new Error("Google account access is managed through Google authorization");
    }
    if (!current.smtp) throw new Error("This account has no outgoing-mail settings; add SMTP credentials to reconnect it");
    return {
      publicAccount: { id: account.id, name: input.name, email: input.email, kind: "imap" },
      credentials: {
        kind: "imap",
        imap: {
          host: input.host,
          port: input.port,
          secure: input.secure,
          username: input.username,
          password: input.password ?? current.imap.password,
        },
        smtp: {
          host: input.smtpHost,
          port: input.smtpPort,
          secure: input.smtpSecure,
          username: input.smtpUsername,
          password: input.smtpPassword ?? current.smtp.password,
        },
      },
    };
  }

  #clientsFor(account: Account, credentials: AccountCredentials): { provider: MailProvider; sender: MailSender } {
    if (account.kind === "gmail") {
      if (credentials.kind !== "gmail") throw new Error("Stored Google credentials do not match the account type");
      return this.#gmailClientFactory(account, credentials);
    }
    if (credentials.kind !== "imap") throw new Error("Stored IMAP credentials do not match the account type");
    return {
      provider: this.#imapProviderFactory(account.id, credentials.imap),
      sender: this.#mailSenderFactory(account, credentials),
    };
  }

  async #verifiedClients(
    account: Account & { kind: "imap" },
    credentials: ImapAccountCredentials,
  ): Promise<{ provider: MailProvider; sender: MailSender }> {
    const clients = this.#clientsFor(account, credentials);
    try {
      await clients.provider.verifyConnection();
    } catch {
      throw new Error("IMAP connection failed. Check the server, port, TLS setting, username, and password.");
    }
    try {
      await clients.sender.verifyConnection();
    } catch {
      throw new Error("SMTP connection failed. Check the server, port, TLS setting, username, and password.");
    }
    return clients;
  }

  #registerClients(accountId: string, clients: { provider: MailProvider; sender: MailSender }): void {
    this.#providers.register(accountId, clients.provider);
    this.#senders.register(accountId, clients.sender);
  }

  async #requireAccount(id: string): Promise<StoredAccount> {
    const account = await this.#store.getAccount(id);
    if (!account) throw new Error("Account not found");
    return account;
  }
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

function operationResult(
  item: Proposal["items"][number],
  status: OperationResult["status"],
  error: string | null,
): OperationResult {
  return { itemId: item.id, message: item.message, action: item.action, status, error };
}

function toPublicAccount(account: StoredAccount): Account {
  return { id: account.id, name: account.name, email: account.email, kind: account.kind };
}

function toPublicBatch(batch: StoredBatch): OperationBatch {
  const { storedOperations: _storedOperations, ...publicBatch } = batch;
  return publicBatch;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || "Unknown mail provider failure";
}

function sameProviderRef(left: ProviderDraftRef, right: ProviderDraftRef | undefined): boolean {
  if (!right || left.kind !== right.kind) return false;
  if (left.kind === "gmail") return right.kind === "gmail" && left.draftId === right.draftId;
  return right.kind === "imap"
    && left.mailbox === right.mailbox
    && left.uidValidity === right.uidValidity
    && left.uid === right.uid;
}

function mirrorFailure(draft: Draft, error: string, ref?: ProviderDraftRef): Draft["mirror"] {
  const previousRef = ref ?? draft.mirror.ref;
  const mirroredVersion = draft.mirror.mirroredVersion;
  return {
    status: "failed",
    error,
    ...(mirroredVersion ? { mirroredVersion } : {}),
    ...(previousRef ? { ref: previousRef } : {}),
  };
}

function withReceiptWarning(receipt: SendReceipt, warning: string): SendReceipt {
  return sendReceiptSchema.parse({
    ...receipt,
    warning: [receipt.warning, warning].filter((message): message is string => message !== undefined).join(" "),
  });
}

async function serializeDraftLifecycle<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = draftLifecycleTurns.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  draftLifecycleTurns.set(key, turn);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (draftLifecycleTurns.get(key) === turn) draftLifecycleTurns.delete(key);
  }
}

function draftRecipientsForSend(recipients: DraftRecipientField): OutboundAddress[] {
  if (Array.isArray(recipients)) return recipients;
  return recipients
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean)
    .map((address) => ({ name: "", address }));
}
