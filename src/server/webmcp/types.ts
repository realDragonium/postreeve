import type {
  Account,
  CreateProposalInput,
  Folder,
  ListMessagesInput,
  MessageDetail,
  MessageRef,
  MessageSummary,
  OperationBatch,
  Proposal,
  UpdateProposalInput,
} from "../../shared/contracts.ts";

export interface WebMcpServices {
  listAccounts(signal: AbortSignal): Promise<readonly Account[]>;
  listFolders(accountId: string, signal: AbortSignal): Promise<readonly Folder[]>;
  listMessages(input: ListMessagesInput, signal: AbortSignal): Promise<readonly MessageSummary[]>;
  readMessages(messages: readonly MessageRef[], signal: AbortSignal): Promise<readonly MessageDetail[]>;
  searchMessages(input: ListMessagesInput & { query: string }, signal: AbortSignal): Promise<readonly MessageSummary[]>;
  createProposal(input: CreateProposalInput, signal: AbortSignal): Promise<Proposal>;
  updateProposal(
    proposalId: string,
    input: UpdateProposalInput,
    signal: AbortSignal,
  ): Promise<Proposal>;
  applyProposal(proposalId: string, signal: AbortSignal): Promise<OperationBatch>;
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
