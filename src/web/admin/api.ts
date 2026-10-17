import { z, type ZodType } from "zod";
import {
  aliasResultSchema,
  catchAllResultSchema,
  createMailboxResultSchema,
  dkimKeySchema,
  dnsChecklistSchema,
  mailDomainSchema,
  mailReportSchema,
  mailServerProposalSchema,
  mailServerSchema,
  mailServerSummarySchema,
  mailboxSchema,
  mailingListSchema,
  queuedMessageSchema,
  spamListEntrySchema,
  spamSettingsSchema,
  type ApproveMailServerProposalInput,
  type ConnectMailServerInput,
  type CreateMailboxInput,
  type CreateMailingListInput,
  type DkimAlgorithm,
  type SpamListName,
  type UpdateMailServerInput,
  type UpdateMailboxInput,
  type UpdateMailingListInput,
  type UpdateSpamSettingsInput,
} from "../../shared/mail-server";

const ok = z.object({ ok: z.literal(true) });

async function request<T>(path: string, schema: ZodType<T>, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`/api/mail-servers${path}`, {
    method,
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
      ? payload.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return schema.parse(payload);
}

const server = (id: string) => `/${encodeURIComponent(id)}`;

export const mailServerApi = {
  list: () => request("", z.array(mailServerSummarySchema)),
  connect: (input: ConnectMailServerInput) => request("", mailServerSchema, "POST", input),
  update: (id: string, input: UpdateMailServerInput) => request(server(id), mailServerSchema, "PUT", input),
  disconnect: (id: string) => request(server(id), ok, "DELETE"),

  domains: (id: string) => request(`${server(id)}/domains`, z.array(mailDomainSchema)),
  addDomain: (id: string, name: string) => request(`${server(id)}/domains`, mailDomainSchema, "POST", { name }),
  deleteDomain: (id: string, domainId: string, confirm: string) => request(`${server(id)}/domains/${domainId}`, ok, "DELETE", { confirm }),
  setCatchAll: (id: string, domainId: string, address: string | null) => request(`${server(id)}/domains/${domainId}/catch-all`, catchAllResultSchema, "PUT", { address }),
  dns: (id: string, domainId: string) => request(`${server(id)}/domains/${domainId}/dns`, dnsChecklistSchema),

  mailboxes: (id: string, domainId: string) => request(`${server(id)}/domains/${domainId}/mailboxes`, z.array(mailboxSchema)),
  createMailbox: (id: string, input: CreateMailboxInput) => request(`${server(id)}/mailboxes`, createMailboxResultSchema, "POST", input),
  updateMailbox: (id: string, mailboxId: string, input: UpdateMailboxInput) => request(`${server(id)}/mailboxes/${mailboxId}`, mailboxSchema, "PUT", input),
  resetPassword: (id: string, mailboxId: string, password: string) => request(`${server(id)}/mailboxes/${mailboxId}/password`, ok, "POST", { password }),
  addAlias: (id: string, mailboxId: string, address: string) => request(`${server(id)}/mailboxes/${mailboxId}/aliases`, aliasResultSchema, "POST", { address }),
  removeAlias: (id: string, mailboxId: string, address: string) => request(`${server(id)}/mailboxes/${mailboxId}/aliases`, mailboxSchema, "DELETE", { address }),
  addToPostreeve: (id: string, mailboxId: string) => request(`${server(id)}/mailboxes/${mailboxId}/postreeve-account`, createMailboxResultSchema, "POST"),
  deleteMailbox: (id: string, mailboxId: string, confirm: string) => request(`${server(id)}/mailboxes/${mailboxId}`, ok, "DELETE", { confirm }),

  lists: (id: string, domainId: string) => request(`${server(id)}/domains/${domainId}/lists`, z.array(mailingListSchema)),
  createList: (id: string, input: CreateMailingListInput) => request(`${server(id)}/lists`, mailingListSchema, "POST", input),
  updateList: (id: string, listId: string, input: UpdateMailingListInput) => request(`${server(id)}/lists/${listId}`, mailingListSchema, "PUT", input),
  deleteList: (id: string, listId: string) => request(`${server(id)}/lists/${listId}`, ok, "DELETE"),

  dkim: (id: string, domainId: string) => request(`${server(id)}/domains/${domainId}/dkim`, z.array(dkimKeySchema)),
  generateDkim: (id: string, domainId: string, algorithm: DkimAlgorithm, selector: string) =>
    request(`${server(id)}/domains/${domainId}/dkim`, dkimKeySchema, "POST", { algorithm, selector }),
  deleteDkim: (id: string, keyId: string) => request(`${server(id)}/dkim/${keyId}`, ok, "DELETE"),

  queue: (id: string) => request(`${server(id)}/queue`, z.array(queuedMessageSchema)),
  retry: (id: string, messageId: string) => request(`${server(id)}/queue/${messageId}/retry`, ok, "POST"),
  cancel: (id: string, messageId: string) => request(`${server(id)}/queue/${messageId}`, ok, "DELETE"),
  reports: (id: string) => request(`${server(id)}/reports`, z.array(mailReportSchema)),

  spam: (id: string) => request(`${server(id)}/spam`, spamSettingsSchema),
  updateSpam: (id: string, input: UpdateSpamSettingsInput) => request(`${server(id)}/spam`, spamSettingsSchema, "PUT", input),
  spamList: (id: string, list: SpamListName) => request(`${server(id)}/spam/${list}`, z.array(spamListEntrySchema)),
  addSpamEntry: (id: string, list: SpamListName, domain: string) => request(`${server(id)}/spam/${list}`, spamListEntrySchema, "POST", { domain }),
  removeSpamEntry: (id: string, list: SpamListName, entryId: string) => request(`${server(id)}/spam/${list}/${entryId}`, ok, "DELETE"),

  proposals: () => request("/proposals", z.array(mailServerProposalSchema)),
  approve: (proposalId: string, input: ApproveMailServerProposalInput) => request(`/proposals/${proposalId}/approve`, mailServerProposalSchema, "POST", input),
  reject: (proposalId: string) => request(`/proposals/${proposalId}/reject`, mailServerProposalSchema, "POST"),
};
