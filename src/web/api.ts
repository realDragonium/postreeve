import type { ZodType } from "zod";
import { z } from "zod";
import {
  accountSchema,
  accountSettingsSchema,
  connectionTestResultSchema,
  folderSchema,
  canonicalMessageDetailSchema,
  canonicalMessageSummarySchema,
  canonicalConversationSchema,
  draftSchema,
  operationBatchSchema,
  proposalSchema,
  sendReceiptSchema,
  type Account,
  type AccountSettings,
  type CreateAccountInput,
  type CreateFolderInput,
  type CreateProposalInput,
  type DeleteFolderInput,
  type DirectActionInput,
  type Folder,
  type CanonicalMessageDetail,
  type CanonicalMessageSummary,
  type CanonicalConversation,
  type CreateDraftInput,
  type Draft,
  type DraftVersionInput,
  type MessageRef,
  type OperationBatch,
  type Proposal,
  type RenameFolderInput,
  type SendMessageInput,
  type SendReceipt,
  type UpdateDraftInput,
  type UpdateProposalInput,
  type UpdateAccountInput,
} from "../shared/contracts";

export type ApiErrorCode = "account_conflict" | "draft_conflict" | "draft_not_found";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | null;

  constructor(message: string, status: number, code: ApiErrorCode | null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

function apiError(value: unknown): { message: string | null; code: ApiErrorCode | null } {
  if (typeof value !== "object" || value === null) return { message: null, code: null };
  const message = "error" in value && typeof value.error === "string"
    ? value.error
    : "message" in value && typeof value.message === "string"
      ? value.message
      : null;
  const code = "code" in value && (
    value.code === "account_conflict" || value.code === "draft_conflict" || value.code === "draft_not_found"
  )
    ? value.code
    : null;
  return { message, code };
}

async function request<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = apiError(body);
    throw new ApiRequestError(error.message ?? `Request failed (${response.status})`, response.status, error.code);
  }

  const direct = schema.safeParse(body);
  if (direct.success) return direct.data;
  if (typeof body === "object" && body !== null && "data" in body) {
    return schema.parse(body.data);
  }
  return schema.parse(body);
}

function jsonBody(value: unknown): RequestInit {
  return { body: JSON.stringify(value) };
}

function withSignal(signal?: AbortSignal): RequestInit {
  return signal ? { signal } : {};
}

export const api = {
  googleOAuthStatus: (signal?: AbortSignal): Promise<{ configured: boolean }> =>
    request("/oauth/google/status", z.object({ configured: z.boolean() }), withSignal(signal)),
  accounts: (signal?: AbortSignal): Promise<Account[]> => request("/accounts", accountSchema.array(), withSignal(signal)),
  createAccount: (input: CreateAccountInput): Promise<Account> =>
    request("/accounts", accountSchema, { method: "POST", ...jsonBody(input) }),
  testNewAccount: (input: CreateAccountInput, signal?: AbortSignal) =>
    request("/accounts/test", connectionTestResultSchema, {
      method: "POST",
      ...jsonBody(input),
      ...withSignal(signal),
    }),
  accountSettings: (accountId: string, signal?: AbortSignal): Promise<AccountSettings> =>
    request(`/accounts/${encodeURIComponent(accountId)}/settings`, accountSettingsSchema, withSignal(signal)),
  testAccount: (accountId: string, input: UpdateAccountInput, signal?: AbortSignal) =>
    request(`/accounts/${encodeURIComponent(accountId)}/test`, connectionTestResultSchema, {
      method: "POST",
      ...jsonBody(input),
      ...withSignal(signal),
    }),
  updateAccount: (accountId: string, input: UpdateAccountInput, signal?: AbortSignal): Promise<Account> =>
    request(`/accounts/${encodeURIComponent(accountId)}`, accountSchema, {
      method: "PUT",
      ...jsonBody(input),
      ...withSignal(signal),
    }),
  removeAccount: (accountId: string, signal?: AbortSignal) =>
    request(`/accounts/${encodeURIComponent(accountId)}`, connectionTestResultSchema, {
      method: "DELETE",
      ...withSignal(signal),
    }),
  folders: (accountId: string, signal?: AbortSignal): Promise<Folder[]> =>
    request(`/accounts/${encodeURIComponent(accountId)}/folders`, folderSchema.array(), withSignal(signal)),
  createFolder: (input: CreateFolderInput, signal?: AbortSignal): Promise<Folder[]> =>
    request(`/accounts/${encodeURIComponent(input.accountId)}/folders`, folderSchema.array(), {
      method: "POST",
      ...jsonBody({ name: input.name }),
      ...withSignal(signal),
    }),
  renameFolder: (input: RenameFolderInput, signal?: AbortSignal): Promise<Folder[]> =>
    request(`/accounts/${encodeURIComponent(input.accountId)}/folders`, folderSchema.array(), {
      method: "PUT",
      ...jsonBody({ path: input.path, name: input.name }),
      ...withSignal(signal),
    }),
  deleteFolder: (input: DeleteFolderInput, signal?: AbortSignal): Promise<Folder[]> =>
    request(`/accounts/${encodeURIComponent(input.accountId)}/folders`, folderSchema.array(), {
      method: "DELETE",
      ...jsonBody({ path: input.path }),
      ...withSignal(signal),
    }),
  drafts: (accountId: string, signal?: AbortSignal): Promise<Draft[]> =>
    request(`/accounts/${encodeURIComponent(accountId)}/drafts`, draftSchema.array(), withSignal(signal)),
  draft: (accountId: string, draftId: string, signal?: AbortSignal): Promise<Draft> =>
    request(
      `/accounts/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}`,
      draftSchema,
      withSignal(signal),
    ),
  createDraft: (input: CreateDraftInput, signal?: AbortSignal): Promise<Draft> => {
    const { accountId, ...content } = input;
    return request(`/accounts/${encodeURIComponent(accountId)}/drafts`, draftSchema, {
      method: "POST",
      ...jsonBody(content),
      ...withSignal(signal),
    });
  },
  updateDraft: (
    accountId: string,
    draftId: string,
    input: UpdateDraftInput,
    signal?: AbortSignal,
  ): Promise<Draft> => request(
    `/accounts/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}`,
    draftSchema,
    { method: "PUT", ...jsonBody(input), ...withSignal(signal) },
  ),
  removeDraft: (
    accountId: string,
    draftId: string,
    input: DraftVersionInput,
    signal?: AbortSignal,
  ) => request(
    `/accounts/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}`,
    connectionTestResultSchema,
    { method: "DELETE", ...jsonBody(input), ...withSignal(signal) },
  ),
  copyDraft: (
    accountId: string,
    draftId: string,
    input: DraftVersionInput,
    signal?: AbortSignal,
  ): Promise<Draft> => request(
    `/accounts/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}/copy`,
    draftSchema,
    { method: "POST", ...jsonBody(input), ...withSignal(signal) },
  ),
  sendDraft: (
    accountId: string,
    draftId: string,
    input: DraftVersionInput,
    signal?: AbortSignal,
  ): Promise<SendReceipt> => request(
    `/accounts/${encodeURIComponent(accountId)}/drafts/${encodeURIComponent(draftId)}/send`,
    sendReceiptSchema,
    { method: "POST", ...jsonBody(input), ...withSignal(signal) },
  ),
  messages: (accountId: string, mailbox: string, query: string, limit = 50, signal?: AbortSignal): Promise<CanonicalMessageSummary[]> => {
    const params = new URLSearchParams({ mailbox });
    if (query.trim()) params.set("query", query.trim());
    params.set("limit", String(limit));
    return request(
      `/accounts/${encodeURIComponent(accountId)}/messages?${params.toString()}`,
      canonicalMessageSummarySchema.array(),
      withSignal(signal),
    );
  },
  readMessages: (references: readonly MessageRef[], signal?: AbortSignal): Promise<CanonicalMessageDetail[]> =>
    request("/messages/read", canonicalMessageDetailSchema.array(), {
      method: "POST",
      ...jsonBody({ references }),
      ...withSignal(signal),
    }),
  conversation: (id: string, signal?: AbortSignal): Promise<CanonicalConversation> =>
    request(`/conversations/${encodeURIComponent(id)}`, canonicalConversationSchema, withSignal(signal)),
  sendMessage: (input: SendMessageInput, signal?: AbortSignal): Promise<SendReceipt> =>
    request("/messages/send", sendReceiptSchema, {
      method: "POST",
      ...jsonBody(input),
      ...withSignal(signal),
    }),
  applyDirectActions: (input: DirectActionInput, signal?: AbortSignal): Promise<OperationBatch> =>
    request("/messages/actions", operationBatchSchema, {
      method: "POST",
      ...jsonBody(input),
      ...withSignal(signal),
    }),
  proposals: (accountId: string): Promise<Proposal[]> =>
    request(`/proposals?accountId=${encodeURIComponent(accountId)}`, proposalSchema.array()),
  updateProposal: (id: string, input: UpdateProposalInput, signal?: AbortSignal): Promise<Proposal> =>
    request(`/proposals/${encodeURIComponent(id)}`, proposalSchema, {
      method: "PUT",
      ...jsonBody(input),
      ...withSignal(signal),
    }),
  createProposal: (input: CreateProposalInput, signal?: AbortSignal): Promise<Proposal> =>
    request("/proposals", proposalSchema, {
      method: "POST",
      ...jsonBody(input),
      ...withSignal(signal),
    }),
  approveProposal: (id: string): Promise<Proposal> =>
    request(`/proposals/${encodeURIComponent(id)}/approve`, proposalSchema, { method: "POST" }),
  applyProposal: (id: string): Promise<Proposal | OperationBatch> =>
    request(
      `/proposals/${encodeURIComponent(id)}/apply`,
      proposalSchema.or(operationBatchSchema),
      { method: "POST" },
    ),
  applyProposalBatch: (id: string, signal?: AbortSignal): Promise<OperationBatch> =>
    request(`/proposals/${encodeURIComponent(id)}/apply`, operationBatchSchema, {
      method: "POST",
      ...withSignal(signal),
    }),
  batches: (accountId: string, signal?: AbortSignal): Promise<OperationBatch[]> =>
    request(`/batches?accountId=${encodeURIComponent(accountId)}`, operationBatchSchema.array(), withSignal(signal)),
  undoBatch: (id: string, signal?: AbortSignal): Promise<OperationBatch> =>
    request(`/batches/${encodeURIComponent(id)}/undo`, operationBatchSchema, { method: "POST", ...withSignal(signal) }),
};
