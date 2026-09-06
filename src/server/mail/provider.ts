import type { OutgoingContent } from "./outgoing-content";
import type {
  Draft,
  Folder,
  MessageRef,
  MessageSummary,
  MessageDetail,
  CanonicalMessageObservation,
  MailProviderKind,
  TriageAction,
  ProviderDraftRef,
  ReceivedAttachment,
} from "../../shared/contracts";
import { normalizeMessageId, normalizeMessageIdList, normalizeMessageIdLists } from "./message-id";

interface ProviderMessageMetadata {
  providerConversationId?: string;
  canonicalReceivedAt?: string | null;
  referenceSequences?: readonly (readonly string[])[];
}

export type ProviderMessageSummary = MessageSummary & ProviderMessageMetadata;
export type ProviderAttachmentLocator =
  | { readonly kind: "gmail"; readonly messageId: string; readonly partId: string }
  | {
      readonly kind: "imap";
      readonly mailbox: string;
      readonly uidValidity: string;
      readonly uid: number;
      readonly part: string;
    };

export interface ProviderAttachment extends Omit<ReceivedAttachment, "reference" | "canonicalMessageId"> {
  readonly locator: ProviderAttachmentLocator;
}

export interface ProviderAttachmentDownload {
  readonly filename: string;
  readonly mediaType: string;
  readonly content: Uint8Array;
}

export type ProviderMessageDetail = Omit<MessageDetail, "attachments"> & ProviderMessageMetadata & {
  attachments: ProviderAttachment[];
};
export type ProviderMessageObservation = CanonicalMessageObservation & {
  providerConversationId?: string;
  referenceSequences?: readonly (readonly string[])[];
};

export function toCanonicalObservation(
  tenantId: string,
  provider: MailProviderKind,
  message: ProviderMessageSummary,
): ProviderMessageObservation {
  const messageId = normalizeMessageId(message.messageId);
  const inReplyTo = normalizeMessageIdList(message.inReplyTo);
  const references = normalizeMessageIdLists(message.references ?? []);
  const referenceSequences = message.referenceSequences?.map((sequence) => normalizeMessageIdLists(sequence))
    .filter((sequence) => sequence.length > 0);
  return {
    tenantId,
    receivedAt: message.canonicalReceivedAt === undefined
      ? message.receivedAt
      : message.canonicalReceivedAt,
    messageId,
    inReplyTo: inReplyTo.length > 0 ? inReplyTo.join(" ") : null,
    references,
    ...(referenceSequences ? { referenceSequences } : {}),
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

export interface ProviderDraft {
  readonly tenantId: string;
  readonly accountId: string;
  readonly postreeveId: string;
  readonly version: number;
  readonly ref: ProviderDraftRef;
}

export interface ProviderDraftScope {
  readonly tenantId: string;
  readonly accountId: string;
}

export type ProviderDraftInput = Draft & OutgoingContent;

export interface MailProvider {
  verifyConnection(): Promise<void>;
  listFolders(accountId: string): Promise<Folder[]>;
  createFolder(accountId: string, name: string): Promise<void>;
  renameFolder(accountId: string, path: string, name: string): Promise<void>;
  deleteFolder(accountId: string, path: string): Promise<void>;
  createDraft(scope: ProviderDraftScope, draft: ProviderDraftInput): Promise<ProviderDraftRef>;
  updateDraft(scope: ProviderDraftScope, draft: ProviderDraftInput, ref: ProviderDraftRef): Promise<ProviderDraftRef>;
  listDrafts(scope: ProviderDraftScope): Promise<ProviderDraft[]>;
  removeDraft(scope: ProviderDraftScope, postreeveId: string, ref?: ProviderDraftRef): Promise<void>;
  listMessagePage(accountId: string, mailbox: string, limit: number): Promise<MailboxPage>;
  listMessages(accountId: string, mailbox: string, limit: number): Promise<ProviderMessageSummary[]>;
  readMessages(accountId: string, references: MessageRef[]): Promise<ProviderMessageDetail[]>;
  downloadAttachment(
    accountId: string,
    locator: ProviderAttachmentLocator,
    maxBytes: number,
  ): Promise<ProviderAttachmentDownload>;
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
