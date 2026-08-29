import type {
  DirectActionInput,
  ListMessagesInput,
  MessageRef,
  SendMessageInput,
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
  sendMessage: (input: SendMessageInput, signal) => api.sendMessage(input, signal),
  applyMessageActions: (input: DirectActionInput, signal) => api.applyDirectActions(input, signal),
  listActivity: (accountId, signal) => api.batches(accountId, signal),
  undoBatch: (batchId, signal) => api.undoBatch(batchId, signal),
};
