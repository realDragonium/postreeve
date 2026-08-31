import type {
  CreateFolderInput,
  DeleteFolderInput,
  DirectActionInput,
  Folder,
  MessageRef,
  RenameFolderInput,
  SendMessageInput,
} from "../shared/contracts";
import type {
  WebMcpListMessagesInput,
  WebMcpMailboxView,
  WebMcpSearchMessagesInput,
  WebMcpServices,
} from "../server/webmcp/types";
import { api } from "./api";
import { recordAssistantBatch } from "./provenance";

type MailboxViewListener = (view: WebMcpMailboxView) => void;
type FolderListListener = (accountId: string, folders: readonly Folder[]) => void;

const mailboxViewListeners = new Set<MailboxViewListener>();
const folderListListeners = new Set<FolderListListener>();

export function subscribeToWebMcpMailboxViews(listener: MailboxViewListener): () => void {
  mailboxViewListeners.add(listener);
  return () => mailboxViewListeners.delete(listener);
}

export function subscribeToWebMcpFolderLists(listener: FolderListListener): () => void {
  folderListListeners.add(listener);
  return () => folderListListeners.delete(listener);
}

function showMailboxView(view: WebMcpMailboxView): void {
  for (const listener of mailboxViewListeners) listener(view);
}

function showFolderList(accountId: string, folders: readonly Folder[]): void {
  for (const listener of folderListListeners) listener(accountId, folders);
}

export const webMcpServices: WebMcpServices = {
  listAccounts: (signal) => api.accounts(signal),
  listFolders: (accountId, signal) => api.folders(accountId, signal),
  createFolder: async (input: CreateFolderInput, signal) => {
    const folders = await api.createFolder(input, signal);
    showFolderList(input.accountId, folders);
    return folders;
  },
  renameFolder: async (input: RenameFolderInput, signal) => {
    const folders = await api.renameFolder(input, signal);
    showFolderList(input.accountId, folders);
    return folders;
  },
  deleteFolder: async (input: DeleteFolderInput, signal) => {
    const folders = await api.deleteFolder(input, signal);
    showFolderList(input.accountId, folders);
    return folders;
  },
  listMessages: (input: WebMcpListMessagesInput, signal) =>
    api.messages(input.accountId, input.mailbox, "", input.limit, signal),
  readMessages: (messages: readonly MessageRef[], signal) => api.readMessages(messages, signal),
  searchMessages: (input: WebMcpSearchMessagesInput, signal) =>
    api.messages(input.accountId, input.mailbox, input.query, input.limit, signal),
  sendMessage: (input: SendMessageInput, signal) => api.sendMessage(input, signal),
  applyMessageActions: async (input: DirectActionInput, signal) => {
    const batch = await api.applyDirectActions(input, signal);
    recordAssistantBatch(batch.id);
    return batch;
  },
  listActivity: (accountId, signal) => api.batches(accountId, signal),
  undoBatch: (batchId, signal) => api.undoBatch(batchId, signal),
  showMailboxView,
};
