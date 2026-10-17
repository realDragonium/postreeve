import type { MessageRef } from "../../shared/contracts";
import type { MailboxSource } from "../../shared/mailbox-query";
import type { PostreeveService } from "../core/postreeve";
import { readConversationDetails } from "../webmcp/conversation";
import type { WebMcpListMessagesInput, WebMcpSearchMessagesInput, WebMcpServices } from "../webmcp/types";

export const accountNotAvailable = "Account not available to this agent";

/**
 * The shared tool layer's services, backed by the server itself and narrowed to a grant's accounts.
 * `allowedAccountIds` null means every account, including ones added later.
 */
export function createServerAgentServices(service: PostreeveService, allowedAccountIds: readonly string[] | null): WebMcpServices {
  const allowed = (accountId: string) => allowedAccountIds === null || allowedAccountIds.includes(accountId);
  const requireAccount = (accountId: string) => {
    if (!allowed(accountId)) throw new Error(accountNotAvailable);
  };
  const query = (input: WebMcpListMessagesInput & { query?: string | undefined }) => {
    const sources: MailboxSource[] = input.sources ?? [{ accountId: input.accountId, mailbox: input.mailbox }];
    sources.forEach(({ accountId }) => requireAccount(accountId));
    return service.queryMessages({
      sources, query: input.query ?? "", limit: input.limit, filter: input.filter, sort: input.sort,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  };
  // One provider read covers one account, so mixed references are read per account in their order.
  const readMessages = async (references: readonly MessageRef[]) => {
    references.forEach(({ accountId }) => requireAccount(accountId));
    const byAccount = new Map<string, number[]>();
    references.forEach((reference, index) => byAccount.set(reference.accountId, [...byAccount.get(reference.accountId) ?? [], index]));
    const results = new Array(references.length);
    for (const indexes of byAccount.values()) {
      const details = await service.readMessages(indexes.map((index) => references[index]!));
      indexes.forEach((index, position) => { results[index] = details[position]; });
    }
    return results;
  };

  return {
    inspectSynchronization: async () => {
      const status = await service.synchronizationStatus();
      return { ...status, accounts: status.accounts.filter(({ account }) => allowed(account.id)) };
    },
    retrySynchronization: async (accountId) => { requireAccount(accountId); return service.retrySynchronization(accountId); },
    requestReauthorization: async (accountId) => { requireAccount(accountId); return service.requestReauthorization(accountId); },
    listAccounts: async () => (await service.listAccounts()).filter(({ id }) => allowed(id)),
    listFolders: async (accountId) => { requireAccount(accountId); return service.listFolders(accountId); },
    createFolder: async (input) => { requireAccount(input.accountId); return service.createFolder(input); },
    renameFolder: async (input) => { requireAccount(input.accountId); return service.renameFolder(input); },
    deleteFolder: async (input) => { requireAccount(input.accountId); return service.deleteFolder(input); },
    listMessages: async (input) => query(input),
    searchMessages: async (input: WebMcpSearchMessagesInput) => query(input),
    readMessages,
    readConversation: async (conversationId) => {
      const summaries = (await service.getConversationMessages(conversationId)).filter(({ ref }) => allowed(ref.accountId));
      if (summaries.length === 0) throw new Error("Conversation not found");
      return readConversationDetails(summaries, (references) => service.readMessages(references), 50);
    },
    sendMessage: async () => {
      throw new Error("Remote agents cannot send mail; prepare it for the person to send in Postreeve");
    },
    applyMessageActions: async (input) => { requireAccount(input.accountId); return service.applyDirectActions(input); },
    listActivity: async (accountId) => { requireAccount(accountId); return service.listBatches(accountId); },
    undoBatch: async (batchId) => {
      if (allowedAccountIds !== null) {
        const batches = (await Promise.all(allowedAccountIds.map((accountId) => service.listBatches(accountId).catch(() => [])))).flat();
        if (!batches.some(({ id }) => id === batchId)) throw new Error("Operation batch not found");
      }
      return service.undoBatch(batchId);
    },
    listProposals: async (accountId) => { requireAccount(accountId); return service.listProposals(accountId); },
    createProposal: async (input) => { requireAccount(input.accountId); return service.createProposal(input); },
    updateProposal: async (proposalId, input) => {
      requireAccount((await service.getProposal(proposalId)).accountId);
      return service.updateProposal(proposalId, input);
    },
    listIdentities: async (accountId) => { requireAccount(accountId); return service.listIdentities(accountId); },
    listSignatures: async (accountId) => { requireAccount(accountId); return service.listSignatures(accountId); },
    listDrafts: async (accountId) => { requireAccount(accountId); return service.listDrafts(accountId); },
    getDraft: async (accountId, draftId) => { requireAccount(accountId); return service.getDraft(accountId, draftId); },
    createDraft: async (input) => { requireAccount(input.accountId); return service.createDraft(input); },
    updateDraft: async (accountId, draftId, input) => { requireAccount(accountId); return service.updateDraft(accountId, draftId, input); },
    readAttachment: async (accountId, canonicalMessageId, reference) => {
      requireAccount(accountId);
      const { mediaType, content } = await service.downloadAttachment(accountId, canonicalMessageId, reference);
      return { mediaType, content };
    },
    showMailboxView: () => undefined,
  };
}
