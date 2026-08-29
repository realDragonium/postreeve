import type {
  Folder,
  MessageDetail,
  MessageRef,
  MessageSummary,
  TriageAction,
} from "../../shared/contracts";

export interface AppliedMailAction {
  current: MessageRef;
  previous: MessageRef;
  action: TriageAction;
  previousRead: boolean;
}

export interface MailProvider {
  listFolders(accountId: string): Promise<Folder[]>;
  listMessages(accountId: string, mailbox: string, limit: number): Promise<MessageSummary[]>;
  readMessages(accountId: string, references: MessageRef[]): Promise<MessageDetail[]>;
  searchMessages(accountId: string, mailbox: string, query: string, limit: number): Promise<MessageSummary[]>;
  revalidate(reference: MessageRef): Promise<boolean>;
  apply(reference: MessageRef, action: TriageAction): Promise<AppliedMailAction>;
  undo(applied: AppliedMailAction): Promise<void>;
}

export class MailProviderRegistry {
  readonly #providers = new Map<string, MailProvider>();

  register(accountId: string, provider: MailProvider): void {
    this.#providers.set(accountId, provider);
  }

  forAccount(accountId: string): MailProvider {
    const provider = this.#providers.get(accountId);
    if (!provider) throw new Error(`No mail provider is configured for account ${accountId}`);
    return provider;
  }
}
