import type {
  Folder,
  MessageRef,
  MessageSummary,
  MessageDetail,
  CanonicalMessageObservation,
  MailProviderKind,
  TriageAction,
} from "../../shared/contracts";
import { normalizeMessageId } from "./message-id";

interface ProviderMessageMetadata {
  providerConversationId?: string;
  canonicalReceivedAt?: string | null;
}

export type ProviderMessageSummary = MessageSummary & ProviderMessageMetadata;
export type ProviderMessageDetail = MessageDetail & ProviderMessageMetadata;
export type ProviderMessageObservation = CanonicalMessageObservation & { providerConversationId?: string };

export function toCanonicalObservation(
  tenantId: string,
  provider: MailProviderKind,
  message: ProviderMessageSummary,
): ProviderMessageObservation {
  const messageId = normalizeMessageId(message.messageId);
  return {
    tenantId,
    receivedAt: message.canonicalReceivedAt === undefined
      ? message.receivedAt
      : message.canonicalReceivedAt,
    messageId,
    inReplyTo: normalizeMessageId(message.inReplyTo),
    references: (message.references ?? []).flatMap((reference) => {
      const normalized = normalizeMessageId(reference);
      return normalized ? [normalized] : [];
    }),
    ...(message.providerConversationId ? { providerConversationId: message.providerConversationId } : {}),
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

export interface AppliedMailAction {
  current: MessageRef;
  previous: MessageRef;
  action: TriageAction;
  previousRead: boolean;
}

export interface ProviderLocationMove {
  current: MessageRef;
  previous: MessageRef;
}

export interface MailboxPage {
  messages: ProviderMessageSummary[];
  complete: boolean;
}

export interface MailProvider {
  verifyConnection(): Promise<void>;
  listFolders(accountId: string): Promise<Folder[]>;
  createFolder(accountId: string, name: string): Promise<void>;
  renameFolder(accountId: string, path: string, name: string): Promise<void>;
  deleteFolder(accountId: string, path: string): Promise<void>;
  listMessagePage(accountId: string, mailbox: string, limit: number): Promise<MailboxPage>;
  listMessages(accountId: string, mailbox: string, limit: number): Promise<ProviderMessageSummary[]>;
  readMessages(accountId: string, references: MessageRef[]): Promise<ProviderMessageDetail[]>;
  searchMessages(accountId: string, mailbox: string, query: string, limit: number): Promise<ProviderMessageSummary[]>;
  revalidate(reference: MessageRef): Promise<boolean>;
  apply(reference: MessageRef, action: TriageAction): Promise<AppliedMailAction>;
  undo(applied: AppliedMailAction): Promise<ProviderLocationMove | null>;
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
