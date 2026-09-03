import type {
  Folder,
  MessageDetail,
  MessageRef,
  MessageSummary,
  CanonicalMessageObservation,
  MailProviderKind,
  TriageAction,
} from "../../shared/contracts";

export function toCanonicalObservation(
  tenantId: string,
  provider: MailProviderKind,
  message: MessageSummary,
): CanonicalMessageObservation {
  const messageId = normalizeMessageId(message.messageId);
  return {
    tenantId,
    messageId,
    inReplyTo: normalizeMessageId(message.inReplyTo),
    references: (message.references ?? []).flatMap((reference) => {
      const normalized = normalizeMessageId(reference);
      return normalized ? [normalized] : [];
    }),
    location: {
      accountId: message.ref.accountId,
      provider,
      mailbox: message.ref.mailbox,
      uidValidity: message.ref.uidValidity,
      uid: message.ref.uid,
      modseq: message.ref.modseq,
      providerId: message.ref.providerId ?? null,
      read: message.read,
      flagged: message.flagged,
    },
  };
}

function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const match = /^<([^<>\s@]+)@([^<>\s@]+)>$/.exec(trimmed);
  return match ? `<${match[1]}@${match[2]!.toLowerCase()}>` : null;
}

export interface AppliedMailAction {
  current: MessageRef;
  previous: MessageRef;
  action: TriageAction;
  previousRead: boolean;
}

export interface MailProvider {
  verifyConnection(): Promise<void>;
  listFolders(accountId: string): Promise<Folder[]>;
  createFolder(accountId: string, name: string): Promise<void>;
  renameFolder(accountId: string, path: string, name: string): Promise<void>;
  deleteFolder(accountId: string, path: string): Promise<void>;
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

  remove(accountId: string): void {
    this.#providers.delete(accountId);
  }

  forAccount(accountId: string): MailProvider {
    const provider = this.#providers.get(accountId);
    if (!provider) throw new Error(`No mail provider is configured for account ${accountId}`);
    return provider;
  }
}
