import type {
  Account,
  DirectActionInput,
  Folder,
  ListMessagesInput,
  MessageDetail,
  MessageRef,
  MessageSummary,
  OperationBatch,
  SendMessageInput,
  SendReceipt,
} from "../../shared/contracts.ts";

export interface WebMcpServices {
  listAccounts(signal: AbortSignal): Promise<readonly Account[]>;
  listFolders(accountId: string, signal: AbortSignal): Promise<readonly Folder[]>;
  listMessages(input: ListMessagesInput, signal: AbortSignal): Promise<readonly MessageSummary[]>;
  readMessages(messages: readonly MessageRef[], signal: AbortSignal): Promise<readonly MessageDetail[]>;
  searchMessages(input: ListMessagesInput & { query: string }, signal: AbortSignal): Promise<readonly MessageSummary[]>;
  sendMessage(input: SendMessageInput, signal: AbortSignal): Promise<SendReceipt>;
  applyMessageActions(input: DirectActionInput, signal: AbortSignal): Promise<OperationBatch>;
  listActivity(accountId: string, signal: AbortSignal): Promise<readonly OperationBatch[]>;
  undoBatch(batchId: string, signal: AbortSignal): Promise<OperationBatch>;
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
