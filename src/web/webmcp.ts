import type {
  CreateProposalInput,
  ListMessagesInput,
  MessageRef,
  UpdateProposalInput,
} from "../shared/contracts";
import type { WebMcpServices } from "../server/webmcp/types";
import { api } from "./api";

export const webMcpServices: WebMcpServices = {
  listAccounts: (signal) => api.accounts(signal),
  listFolders: (accountId, signal) => api.folders(accountId, signal),
  listMessages: (input: ListMessagesInput, signal) =>
    api.messages(input.accountId, input.mailbox, "", input.limit, signal),
  readMessages: (messages: readonly MessageRef[], signal) => api.readMessages(messages, signal),
  searchMessages: (input: ListMessagesInput & { query: string }, signal) =>
    api.messages(input.accountId, input.mailbox, input.query, input.limit, signal),
  createProposal: (input: CreateProposalInput, signal) => api.createProposal(input, signal),
  updateProposal: (proposalId: string, input: UpdateProposalInput, signal) =>
    api.updateProposal(proposalId, input, signal),
  applyProposal: (proposalId, signal) => api.applyProposalBatch(proposalId, signal),
  undoBatch: (batchId, signal) => api.undoBatch(batchId, signal),
};
