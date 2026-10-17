import type { MailboxPage, MailboxSource } from "../../shared/mailbox-query";
import type { AccountHealth, SynchronizationStatus, Reauthorization } from "../../shared/synchronization";
import type {
  Account,
  CanonicalMessageDetail,
  CreateDraftInput,
  CreateProposalInput,
  Draft,
  Identity,
  Signature,
  UpdateDraftInput,
  CanonicalMessageSummary,
  CreateFolderInput,
  DeleteFolderInput,
  DirectActionInput,
  Folder,
  ListMessagesInput,
  MessageRef,
  OperationBatch,
  Proposal,
  RenameFolderInput,
  SendMessageInput,
  SendReceipt,
  UpdateProposalInput,
} from "../../shared/contracts.ts";

export interface WebMcpServices {
  inspectSynchronization(signal: AbortSignal): Promise<SynchronizationStatus>;
  retrySynchronization(accountId: string, signal: AbortSignal): Promise<AccountHealth>;
  requestReauthorization(accountId: string, signal: AbortSignal): Promise<Reauthorization>;
  listAccounts(signal: AbortSignal): Promise<readonly Account[]>;
  listFolders(accountId: string, signal: AbortSignal): Promise<readonly Folder[]>;
  createFolder(input: CreateFolderInput, signal: AbortSignal): Promise<readonly Folder[]>;
  renameFolder(input: RenameFolderInput, signal: AbortSignal): Promise<readonly Folder[]>;
  deleteFolder(input: DeleteFolderInput, signal: AbortSignal): Promise<readonly Folder[]>;
  listMessages(input: WebMcpListMessagesInput, signal: AbortSignal): Promise<MailboxPage>;
  readMessages(messages: readonly MessageRef[], signal: AbortSignal): Promise<readonly CanonicalMessageDetail[]>;
  /** Every message of the conversation the caller may see, with full details, oldest first. */
  readConversation(conversationId: string, signal: AbortSignal): Promise<readonly CanonicalMessageDetail[]>;
  searchMessages(input: WebMcpSearchMessagesInput, signal: AbortSignal): Promise<MailboxPage>;
  sendMessage(input: SendMessageInput, signal: AbortSignal): Promise<SendReceipt>;
  applyMessageActions(input: DirectActionInput, signal: AbortSignal): Promise<OperationBatch>;
  listActivity(accountId: string, signal: AbortSignal): Promise<readonly OperationBatch[]>;
  undoBatch(batchId: string, signal: AbortSignal): Promise<OperationBatch>;
  listProposals(accountId: string, signal: AbortSignal): Promise<readonly Proposal[]>;
  listIdentities(accountId: string, signal: AbortSignal): Promise<readonly Identity[]>;
  listSignatures(accountId: string, signal: AbortSignal): Promise<readonly Signature[]>;
  listDrafts(accountId: string, signal: AbortSignal): Promise<readonly Draft[]>;
  getDraft(accountId: string, draftId: string, signal: AbortSignal): Promise<Draft>;
  createDraft(input: CreateDraftInput, signal: AbortSignal): Promise<Draft>;
  updateDraft(accountId: string, draftId: string, input: UpdateDraftInput, signal: AbortSignal): Promise<Draft>;
  readAttachment(accountId: string, canonicalMessageId: string, reference: string, signal: AbortSignal): Promise<AttachmentContent>;
  createProposal(input: CreateProposalInput, signal: AbortSignal): Promise<Proposal>;
  updateProposal(proposalId: string, input: UpdateProposalInput, signal: AbortSignal): Promise<Proposal>;
  showMailboxView(view: WebMcpMailboxView): void;
}

export type WebMcpMessageFilter = "all" | "unread" | "flagged";
export type WebMcpMessageSort = "newest" | "oldest" | "sender" | "subject";

export interface WebMcpListMessagesInput extends ListMessagesInput {
  readonly sources?: MailboxSource[] | undefined;
  readonly cursor?: string | undefined;
  readonly filter: WebMcpMessageFilter;
  readonly sort: WebMcpMessageSort;
}

export interface WebMcpSearchMessagesInput extends WebMcpListMessagesInput {
  readonly query: string;
}

export interface WebMcpMailboxView extends WebMcpListMessagesInput {
  readonly query: string;
  readonly messages: readonly CanonicalMessageSummary[];
  readonly nextCursor: string | null;
  readonly coverage: MailboxPage["coverage"];
}

export interface WebMcpToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  annotations?: WebMcpToolAnnotations;
  execute(input: unknown, options: WebMcpExecuteOptions): Promise<unknown>;
}

/** Which grant scope a tool needs on remote MCP; the page offers every tool the person exposes. */
export type AgentToolScope = "read" | "propose" | "draft" | "act";

export interface AttachmentContent {
  readonly mediaType: string;
  readonly content: Uint8Array;
}
export type AgentToolSurface = "webmcp" | "remote";

/** One definition shared by page WebMCP and remote MCP. */
export interface AgentTool extends WebMcpTool {
  readonly scope: AgentToolScope;
  readonly surfaces: readonly AgentToolSurface[];
  readonly destructive: boolean;
}

export interface WebMcpExecuteOptions {
  signal: AbortSignal;
}

export interface WebMcpRegisterOptions {
  signal?: AbortSignal;
}

export interface WebMcpModelContext {
  registerTool(tool: WebMcpTool, options?: WebMcpRegisterOptions): Promise<void>;
}

export interface WebMcpEnvironment {
  readonly document?: object;
  readonly navigator?: object;
}

export interface WebMcpRegistration {
  readonly toolNames: readonly string[];
  dispose(): void;
}
