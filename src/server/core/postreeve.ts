import type {
  Account,
  CreateAccountInput,
  CreateProposalInput,
  DirectActionInput,
  Folder,
  ListMessagesInput,
  MessageDetail,
  MessageRef,
  MessageSummary,
  OperationBatch,
  OperationResult,
  Proposal,
  SendMessageInput,
  SendReceipt,
  UpdateProposalInput,
} from "../../shared/contracts";
import {
  createProposalInputSchema,
  directActionInputSchema,
  sendMessageInputSchema,
  updateProposalInputSchema,
} from "../../shared/contracts";
import type { Store, StoredAccount, StoredBatch } from "../db/store";
import type { StoredOperation } from "../db/schema";
import { FixtureMailProvider } from "../mail/fixture";
import { MailProviderRegistry, type MailProvider } from "../mail/provider";
import { MailSenderRegistry, type MailSender } from "../mail/sender";
import { CredentialVault, type AccountCredentials, type ImapCredentials } from "../security/credentials";

export type ImapProviderFactory = (accountId: string, credentials: ImapCredentials) => MailProvider;
export type MailSenderFactory = (
  account: Account,
  credentials: AccountCredentials | null,
  fixtureProvider: FixtureMailProvider | null,
) => MailSender;

export class PostreeveService {
  readonly #store: Store;
  readonly #providers: MailProviderRegistry;
  readonly #senders: MailSenderRegistry;
  readonly #vault: CredentialVault;
  readonly #imapProviderFactory: ImapProviderFactory;
  readonly #mailSenderFactory: MailSenderFactory;

  constructor(
    store: Store,
    providers: MailProviderRegistry,
    senders: MailSenderRegistry,
    vault: CredentialVault,
    imapProviderFactory: ImapProviderFactory,
    mailSenderFactory: MailSenderFactory,
  ) {
    this.#store = store;
    this.#providers = providers;
    this.#senders = senders;
    this.#vault = vault;
    this.#imapProviderFactory = imapProviderFactory;
    this.#mailSenderFactory = mailSenderFactory;
  }

  async initialize(): Promise<void> {
    const accounts = await this.#store.listAccounts();
    if (accounts.length === 0) {
      const account = await this.createAccount({
        kind: "fixture",
        name: "Postreeve Demo",
        email: "demo@postreeve.local",
      });
      const messages = await this.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 50 });
      const digest = messages.find(({ subject }) => subject.includes("weekly engineering"));
      const receipt = messages.find(({ subject }) => subject.includes("Receipt"));
      if (digest && receipt) {
        await this.createProposal({
          accountId: account.id,
          title: "Agent proposal: tidy the demo inbox",
          items: [
            {
              id: crypto.randomUUID(),
              message: digest.ref,
              subject: digest.subject,
              action: { type: "move", destination: "Archive" },
              reason: "Keep the newsletter available without leaving it in the active inbox.",
            },
            {
              id: crypto.randomUUID(),
              message: receipt.ref,
              subject: receipt.subject,
              action: { type: "leave" },
              reason: "No action is required and the receipt is already read.",
            },
          ],
        });
      }
      return;
    }
    for (const account of accounts) this.#registerStoredAccount(account);
  }

  async listAccounts(): Promise<Account[]> {
    return (await this.#store.listAccounts()).map(toPublicAccount);
  }

  async createAccount(input: CreateAccountInput): Promise<Account> {
    const id = crypto.randomUUID();
    const account: StoredAccount = input.kind === "fixture"
      ? { id, name: input.name, email: input.email, kind: "fixture", encryptedCredentials: null }
      : {
          id,
          name: input.name,
          email: input.email,
          kind: "imap",
          encryptedCredentials: this.#vault.encrypt({
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
          }),
        };
    await this.#store.insertAccount(account);
    this.#registerStoredAccount(account);
    return toPublicAccount(account);
  }

  async listFolders(accountId: string): Promise<Folder[]> {
    await this.#requireAccount(accountId);
    return this.#providers.forAccount(accountId).listFolders(accountId);
  }

  async listMessages(input: ListMessagesInput): Promise<MessageSummary[]> {
    await this.#requireAccount(input.accountId);
    const provider = this.#providers.forAccount(input.accountId);
    return input.query
      ? provider.searchMessages(input.accountId, input.mailbox, input.query, input.limit)
      : provider.listMessages(input.accountId, input.mailbox, input.limit);
  }

  async searchMessages(input: ListMessagesInput & { query: string }): Promise<MessageSummary[]> {
    await this.#requireAccount(input.accountId);
    return this.#providers.forAccount(input.accountId)
      .searchMessages(input.accountId, input.mailbox, input.query, input.limit);
  }

  async readMessages(references: MessageRef[]): Promise<MessageDetail[]> {
    if (references.length === 0) return [];
    const accountId = references[0]!.accountId;
    if (references.some((reference) => reference.accountId !== accountId)) {
      throw new Error("Messages from different accounts cannot be read in one request");
    }
    await this.#requireAccount(accountId);
    return this.#providers.forAccount(accountId).readMessages(accountId, references);
  }

  async sendMessage(rawInput: SendMessageInput): Promise<SendReceipt> {
    const input = sendMessageInputSchema.parse(rawInput);
    await this.#requireAccount(input.accountId);
    return this.#senders.forAccount(input.accountId).send(input);
  }

  async applyDirectActions(rawInput: DirectActionInput): Promise<OperationBatch> {
    const input = directActionInputSchema.parse(rawInput);
    await this.#requireAccount(input.accountId);
    if (input.items.some(({ message }) => message.accountId !== input.accountId)) {
      throw new Error("Every direct action must belong to the selected account");
    }
    const proposal = await this.createProposal({
      accountId: input.accountId,
      title: `Manual mailbox action${input.items.length === 1 ? "" : "s"}`,
      items: input.items.map((item) => ({
        id: crypto.randomUUID(),
        message: item.message,
        subject: item.subject,
        action: item.action,
        reason: "Requested directly through the human interface.",
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
          operation = { result: operationResult(item, "applied", null), applied };
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
        await provider.undo(operation.applied);
        storedOperations.push({
          ...operation,
          result: { ...operation.result, status: "undone", error: null },
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

  #registerStoredAccount(account: StoredAccount): void {
    if (account.kind === "fixture") {
      const provider = new FixtureMailProvider(account.id);
      this.#providers.register(account.id, provider);
      this.#senders.register(account.id, this.#mailSenderFactory(toPublicAccount(account), null, provider));
      return;
    }
    if (!account.encryptedCredentials) throw new Error(`IMAP account ${account.id} has no credentials`);
    const credentials = this.#vault.decrypt(account.encryptedCredentials);
    this.#providers.register(account.id, this.#imapProviderFactory(account.id, credentials.imap));
    this.#senders.register(account.id, this.#mailSenderFactory(toPublicAccount(account), credentials, null));
  }

  async #requireAccount(id: string): Promise<StoredAccount> {
    const account = await this.#store.getAccount(id);
    if (!account) throw new Error("Account not found");
    return account;
  }
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
  return error instanceof Error ? error.message : "Unknown mail provider failure";
}
