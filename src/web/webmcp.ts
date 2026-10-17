import type {
  CreateFolderInput,
  CreateProposalInput,
  DeleteFolderInput,
  DirectActionInput,
  Folder,
  MessageRef,
  RenameFolderInput,
  SendMessageInput,
  UpdateProposalInput,
} from "../shared/contracts";
import { readConversationDetails } from "../server/webmcp/conversation";
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

type ProposalChangeListener = (accountId: string) => void;

const mailboxViewListeners = new Set<MailboxViewListener>();
const proposalChangeListeners = new Set<ProposalChangeListener>();

/** Agent-prepared proposals must show on their messages without a reload. */
export function subscribeToWebMcpProposalChanges(listener: ProposalChangeListener): () => void {
  proposalChangeListeners.add(listener);
  return () => proposalChangeListeners.delete(listener);
}

function proposalChanged<T extends { accountId: string }>(proposal: T): T {
  for (const listener of proposalChangeListeners) listener(proposal.accountId);
  return proposal;
}
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
  inspectSynchronization: (signal) => api.synchronization(signal),
  retrySynchronization: (accountId, signal) => api.retrySynchronization(accountId, signal),
  requestReauthorization: (accountId, signal) => api.requestReauthorization(accountId, signal),
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
    api.queryMessages({ sources: input.sources ?? [{ accountId: input.accountId, mailbox: input.mailbox }],
      limit: input.limit, filter: input.filter, sort: input.sort, ...(input.cursor ? { cursor: input.cursor } : {}) }, signal),
  readMessages: (messages: readonly MessageRef[], signal) => api.readMessages(messages, signal),
  readConversation: async (conversationId, signal) => readConversationDetails(
    await api.conversationMessages(conversationId, undefined, signal),
    (references) => api.readMessages(references, signal),
    50,
  ),
  searchMessages: (input: WebMcpSearchMessagesInput, signal) =>
    api.queryMessages({ sources: input.sources ?? [{ accountId: input.accountId, mailbox: input.mailbox }],
      query: input.query, limit: input.limit, filter: input.filter, sort: input.sort, ...(input.cursor ? { cursor: input.cursor } : {}) }, signal),
  sendMessage: (input: SendMessageInput, signal) => api.sendMessage(input, signal),
  applyMessageActions: async (input: DirectActionInput, signal) => {
    const batch = await api.applyDirectActions(input, signal);
    recordAssistantBatch(batch.id);
    return batch;
  },
  listActivity: (accountId, signal) => api.batches(accountId, signal),
  undoBatch: (batchId, signal) => api.undoBatch(batchId, signal),
  listProposals: (accountId, signal) => api.proposals(accountId, signal),
  createProposal: async (input: CreateProposalInput, signal) => proposalChanged(await api.createProposal(input, signal)),
  updateProposal: async (proposalId, input: UpdateProposalInput, signal) =>
    proposalChanged(await api.updateProposal(proposalId, input, signal)),
  showMailboxView,
};
