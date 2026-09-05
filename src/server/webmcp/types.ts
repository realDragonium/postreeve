import type {
  Account,
  CanonicalMessageDetail,
  CanonicalMessageSummary,
  CreateFolderInput,
  DeleteFolderInput,
  DirectActionInput,
  Folder,
  ListMessagesInput,
  MessageRef,
  OperationBatch,
  RenameFolderInput,
  SendMessageInput,
  SendReceipt,
} from "../../shared/contracts.ts";

export interface WebMcpServices {
  listAccounts(signal: AbortSignal): Promise<readonly Account[]>;
  listFolders(accountId: string, signal: AbortSignal): Promise<readonly Folder[]>;
  createFolder(input: CreateFolderInput, signal: AbortSignal): Promise<readonly Folder[]>;
  renameFolder(input: RenameFolderInput, signal: AbortSignal): Promise<readonly Folder[]>;
  deleteFolder(input: DeleteFolderInput, signal: AbortSignal): Promise<readonly Folder[]>;
  listMessages(input: WebMcpListMessagesInput, signal: AbortSignal): Promise<readonly CanonicalMessageSummary[]>;
  readMessages(messages: readonly MessageRef[], signal: AbortSignal): Promise<readonly CanonicalMessageDetail[]>;
  searchMessages(input: WebMcpSearchMessagesInput, signal: AbortSignal): Promise<readonly CanonicalMessageSummary[]>;
  sendMessage(input: SendMessageInput, signal: AbortSignal): Promise<SendReceipt>;
  applyMessageActions(input: DirectActionInput, signal: AbortSignal): Promise<OperationBatch>;
  listActivity(accountId: string, signal: AbortSignal): Promise<readonly OperationBatch[]>;
  undoBatch(batchId: string, signal: AbortSignal): Promise<OperationBatch>;
  showMailboxView(view: WebMcpMailboxView): void;
}

export type WebMcpMessageFilter = "all" | "unread" | "flagged";
export type WebMcpMessageSort = "newest" | "oldest" | "sender" | "subject";

export interface WebMcpListMessagesInput extends ListMessagesInput {
  readonly filter: WebMcpMessageFilter;
  readonly sort: WebMcpMessageSort;
}

export interface WebMcpSearchMessagesInput extends WebMcpListMessagesInput {
  readonly query: string;
}

export interface WebMcpMailboxView extends WebMcpListMessagesInput {
  readonly query: string;
  readonly messages: readonly CanonicalMessageSummary[];
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
