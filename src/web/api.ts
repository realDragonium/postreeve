import type { ZodType } from "zod";
import { z } from "zod";
import {
  accountSchema,
  accountSettingsSchema,
  connectionTestResultSchema,
  folderSchema,
  messageDetailSchema,
  messageSummarySchema,
  operationBatchSchema,
  proposalSchema,
  sendReceiptSchema,
  type Account,
  type AccountSettings,
  type CreateAccountInput,
  type CreateProposalInput,
  type DirectActionInput,
  type Folder,
  type MessageDetail,
  type MessageRef,
  type MessageSummary,
  type OperationBatch,
  type Proposal,
  type SendMessageInput,
  type SendReceipt,
  type UpdateProposalInput,
  type UpdateAccountInput,
} from "../shared/contracts";

const errorSchema = {
  parse(value: unknown): string | null {
    if (typeof value !== "object" || value === null) return null;
    if ("error" in value && typeof value.error === "string") return value.error;
    if ("message" in value && typeof value.message === "string") return value.message;
    return null;
  },
};

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
    throw new Error(errorSchema.parse(body) ?? `Request failed (${response.status})`);
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
  messages: (accountId: string, mailbox: string, query: string, limit = 50, signal?: AbortSignal): Promise<MessageSummary[]> => {
    const params = new URLSearchParams({ mailbox });
    if (query.trim()) params.set("query", query.trim());
    params.set("limit", String(limit));
    return request(
      `/accounts/${encodeURIComponent(accountId)}/messages?${params.toString()}`,
      messageSummarySchema.array(),
      withSignal(signal),
    );
  },
  readMessages: (references: readonly MessageRef[], signal?: AbortSignal): Promise<MessageDetail[]> =>
    request("/messages/read", messageDetailSchema.array(), {
      method: "POST",
      ...jsonBody({ references }),
      ...withSignal(signal),
    }),
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
  batches: (accountId: string): Promise<OperationBatch[]> =>
    request(`/batches?accountId=${encodeURIComponent(accountId)}`, operationBatchSchema.array()),
  undoBatch: (id: string, signal?: AbortSignal): Promise<OperationBatch> =>
    request(`/batches/${encodeURIComponent(id)}/undo`, operationBatchSchema, { method: "POST", ...withSignal(signal) }),
};
