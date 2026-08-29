import type {
  DirectActionInput,
  MessageRef,
  SendMessageInput,
} from "../shared/contracts";
import type {
  WebMcpListMessagesInput,
  WebMcpMailboxView,
  WebMcpSearchMessagesInput,
  WebMcpServices,
} from "../server/webmcp/types";
import { api } from "./api";

type MailboxViewListener = (view: WebMcpMailboxView) => void;

const mailboxViewListeners = new Set<MailboxViewListener>();

export function subscribeToWebMcpMailboxViews(listener: MailboxViewListener): () => void {
  mailboxViewListeners.add(listener);
  return () => mailboxViewListeners.delete(listener);
}

function showMailboxView(view: WebMcpMailboxView): void {
  for (const listener of mailboxViewListeners) listener(view);
}

export const webMcpServices: WebMcpServices = {
  listAccounts: (signal) => api.accounts(signal),
  listFolders: (accountId, signal) => api.folders(accountId, signal),
  listMessages: (input: WebMcpListMessagesInput, signal) =>
    api.messages(input.accountId, input.mailbox, "", input.limit, signal),
  readMessages: (messages: readonly MessageRef[], signal) => api.readMessages(messages, signal),
  searchMessages: (input: WebMcpSearchMessagesInput, signal) =>
    api.messages(input.accountId, input.mailbox, input.query, input.limit, signal),
  sendMessage: (input: SendMessageInput, signal) => api.sendMessage(input, signal),
  applyMessageActions: (input: DirectActionInput, signal) => api.applyDirectActions(input, signal),
  listActivity: (accountId, signal) => api.batches(accountId, signal),
  undoBatch: (batchId, signal) => api.undoBatch(batchId, signal),
  showMailboxView,
};
