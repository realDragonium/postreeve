import { z } from "zod";

// Contracts for the Mail server admin area (server/mail-server-admin, server/dns-checklist, agents/mail-server-tools).

export const mailServerIdSchema = z.uuid();
const domainNameSchema = z.string().trim().toLowerCase().min(1).max(253)
  .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, "Enter a domain name such as example.org");
const localPartSchema = z.string().trim().toLowerCase().min(1).max(64)
  .regex(/^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/, "Enter the part before the @");
const addressSchema = z.email().transform((address) => address.toLowerCase());
const passwordSchema = z.string().min(8).max(256);
const quotaSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable();
const displayNameSchema = z.string().trim().max(120);

export const mailServerCredentialSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("apiKey"), apiKey: z.string().trim().min(1).max(4096) }),
  z.object({ kind: z.literal("basic"), username: z.string().trim().min(1).max(320), password: z.string().min(1).max(4096) }),
]);

export const mailServerSchema = z.object({
  id: mailServerIdSchema,
  name: z.string().min(1),
  baseUrl: z.string().min(1),
  credentialKind: z.enum(["apiKey", "basic"]),
  mailHostname: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const mailServerSummarySchema = mailServerSchema.extend({
  domainCount: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});

export const connectMailServerInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().min(1).max(2048),
  credential: mailServerCredentialSchema,
  mailHostname: z.string().trim().toLowerCase().min(1).max(253).optional(),
});

export const updateMailServerInputSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  mailHostname: z.string().trim().toLowerCase().min(1).max(253).optional(),
  credential: mailServerCredentialSchema.optional(),
});

export const mailDomainSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  aliases: z.array(z.string()),
  catchAll: z.string().nullable(),
  dkimManagement: z.enum(["automatic", "manual"]),
});

export const addDomainInputSchema = z.object({ name: domainNameSchema });
export const confirmInputSchema = z.object({ confirm: z.string().trim().toLowerCase().min(1).max(320) });
export const catchAllInputSchema = z.object({ address: addressSchema.nullable() });

export const mailAliasSchema = z.object({ address: z.string().min(1), enabled: z.boolean() });

export const mailboxSchema = z.object({
  id: z.string().min(1),
  domainId: z.string().min(1),
  address: z.string().min(1),
  displayName: z.string(),
  aliases: z.array(mailAliasSchema),
  quotaBytes: z.number().int().nonnegative().nullable(),
  usedBytes: z.number().int().nonnegative(),
  postreeveAccountId: z.string().nullable(),
});

export const createMailboxInputSchema = z.object({
  domainId: z.string().min(1),
  localPart: localPartSchema,
  displayName: displayNameSchema.default(""),
  password: passwordSchema,
  quotaBytes: quotaSchema.default(null),
  addToPostreeve: z.boolean().default(false),
});

export const updateMailboxInputSchema = z.object({
  displayName: displayNameSchema.optional(),
  quotaBytes: quotaSchema.optional(),
});

export const resetPasswordInputSchema = z.object({ password: passwordSchema });
export const aliasInputSchema = z.object({ address: addressSchema });

export const identityRegistrationSchema = z.object({
  address: z.string(),
  accountId: z.string().nullable(),
  status: z.enum(["registered", "existing", "skipped"]),
  reason: z.string().nullable(),
});

export const postreeveAccountLinkSchema = z.object({
  status: z.enum(["added", "failed", "not_requested"]),
  accountId: z.string().nullable(),
  reason: z.string().nullable(),
});

export const createMailboxResultSchema = z.object({
  mailbox: mailboxSchema,
  account: postreeveAccountLinkSchema,
});

export const aliasResultSchema = z.object({
  mailbox: mailboxSchema,
  identity: identityRegistrationSchema.nullable(),
});

export const catchAllResultSchema = z.object({
  domain: mailDomainSchema,
  identity: identityRegistrationSchema.nullable(),
});

export const mailingListSchema = z.object({
  id: z.string().min(1),
  domainId: z.string().min(1),
  address: z.string().min(1),
  description: z.string(),
  recipients: z.array(z.string()),
});

export const createMailingListInputSchema = z.object({
  domainId: z.string().min(1),
  localPart: localPartSchema,
  description: displayNameSchema.default(""),
  recipients: z.array(addressSchema).max(1000).default([]),
});

export const updateMailingListInputSchema = z.object({
  description: displayNameSchema.optional(),
  recipients: z.array(addressSchema).max(1000).optional(),
});

export const dkimAlgorithmSchema = z.enum(["rsa", "ed25519"]);
export const dkimKeySchema = z.object({
  id: z.string().min(1),
  domainId: z.string().min(1),
  algorithm: z.string(),
  selector: z.string(),
  stage: z.string(),
  publicKey: z.string(),
  createdAt: z.string().nullable(),
});

export const generateDkimInputSchema = z.object({
  algorithm: dkimAlgorithmSchema,
  selector: z.string().trim().toLowerCase().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/, "Use letters, digits and hyphens"),
});

export const dnsRecordCategorySchema = z.enum([
  "mx", "spf", "dkim", "dmarc", "mta-sts", "tls-rpt", "autoconfig", "autodiscover", "srv", "caa", "other",
]);
export const dnsRecordSchema = z.object({
  category: dnsRecordCategorySchema,
  name: z.string(),
  type: z.string(),
  value: z.string(),
});
export const dnsCheckSchema = dnsRecordSchema.extend({
  status: z.enum(["ok", "missing", "different", "error"]),
  found: z.array(z.string()),
  error: z.string().nullable(),
});
export const dnsChecklistSchema = z.object({
  domain: z.string(),
  zone: z.string(),
  resolver: z.string(),
  checkedAt: z.iso.datetime(),
  records: z.array(dnsCheckSchema),
});

export const queuedRecipientSchema = z.object({
  address: z.string(),
  status: z.enum(["scheduled", "completed", "temporaryFailure", "permanentFailure"]),
  retryCount: z.number().int().nonnegative(),
  retryDue: z.string().nullable(),
  lastError: z.string().nullable(),
});
export const queuedMessageSchema = z.object({
  id: z.string(),
  from: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string().nullable(),
  nextRetry: z.string().nullable(),
  recipients: z.array(queuedRecipientSchema),
});

export const mailReportSchema = z.object({
  kind: z.enum(["dmarc", "tls"]),
  id: z.string(),
  from: z.string(),
  subject: z.string(),
  receivedAt: z.string().nullable(),
  reporter: z.string(),
  domain: z.string(),
  rangeStart: z.string().nullable(),
  rangeEnd: z.string().nullable(),
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
});

export const spamSettingsSchema = z.object({
  enabled: z.boolean(),
  spamThreshold: z.number().min(0).max(1000),
  rejectThreshold: z.number().min(0).max(1000),
  discardThreshold: z.number().min(0).max(1000),
});
export const updateSpamSettingsInputSchema = spamSettingsSchema.partial();
export const spamListNameSchema = z.enum(["trusted", "blocked"]);
export const spamListEntrySchema = z.object({ id: z.string(), domain: z.string() });
export const spamListEntryInputSchema = z.object({ domain: domainNameSchema });

// Proposal operations name objects by domain or address, so an agent never needs Stalwart's internal ids.
export const mailServerOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("addDomain"), domain: domainNameSchema }).strict(),
  z.object({ type: z.literal("deleteDomain"), domain: domainNameSchema }).strict(),
  z.object({
    type: z.literal("createMailbox"), address: addressSchema, displayName: displayNameSchema.default(""),
    quotaBytes: quotaSchema.default(null), addToPostreeve: z.boolean().default(false),
  }).strict(),
  z.object({ type: z.literal("updateMailbox"), address: addressSchema, displayName: displayNameSchema.optional(), quotaBytes: quotaSchema.optional() }).strict(),
  z.object({ type: z.literal("deleteMailbox"), address: addressSchema }).strict(),
  z.object({ type: z.literal("addAlias"), address: addressSchema, alias: addressSchema }).strict(),
  z.object({ type: z.literal("removeAlias"), address: addressSchema, alias: addressSchema }).strict(),
  z.object({ type: z.literal("setCatchAll"), domain: domainNameSchema, address: addressSchema.nullable() }).strict(),
  z.object({ type: z.literal("createMailingList"), address: addressSchema, description: displayNameSchema.default(""), recipients: z.array(addressSchema).max(1000) }).strict(),
  z.object({ type: z.literal("deleteMailingList"), address: addressSchema }).strict(),
  z.object({ type: z.literal("generateDkim"), domain: domainNameSchema, algorithm: dkimAlgorithmSchema, selector: generateDkimInputSchema.shape.selector }).strict(),
  z.object({ type: z.literal("deleteDkim"), domain: domainNameSchema, selector: z.string().min(1).max(63) }).strict(),
  z.object({ type: z.literal("updateSpamSettings"), settings: updateSpamSettingsInputSchema.strict() }).strict(),
  z.object({ type: z.literal("retryQueuedMessage"), id: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal("cancelQueuedMessage"), id: z.string().min(1).max(64) }).strict(),
  // Applies only the changes selected by default in the domain's DNS plan at approval time.
  z.object({ type: z.literal("applyDnsChanges"), domain: domainNameSchema }).strict(),
]);

export const createMailServerProposalInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  operations: z.array(mailServerOperationSchema).min(1).max(50),
}).strict();

export const mailServerProposalSchema = z.object({
  id: z.uuid(),
  serverId: mailServerIdSchema,
  title: z.string(),
  createdBy: z.string(),
  operations: z.array(mailServerOperationSchema),
  status: z.enum(["pending", "applying", "applied", "failed", "rejected"]),
  results: z.array(z.object({ index: z.number().int(), ok: z.boolean(), message: z.string() })),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});

export const approveMailServerProposalInputSchema = z.object({
  // Passwords for createMailbox operations, keyed by operation index; only the owner sets them.
  passwords: z.record(z.string().regex(/^\d+$/), passwordSchema).default({}),
  // Each deleted domain or mailbox, typed again.
  confirmations: z.array(z.string().trim().toLowerCase()).max(50).default([]),
});

export type MailServerCredential = z.infer<typeof mailServerCredentialSchema>;
export type MailServer = z.infer<typeof mailServerSchema>;
export type MailServerSummary = z.infer<typeof mailServerSummarySchema>;
export type ConnectMailServerInput = z.input<typeof connectMailServerInputSchema>;
export type UpdateMailServerInput = z.input<typeof updateMailServerInputSchema>;
export type MailDomain = z.infer<typeof mailDomainSchema>;
export type Mailbox = z.infer<typeof mailboxSchema>;
export type CreateMailboxInput = z.input<typeof createMailboxInputSchema>;
export type UpdateMailboxInput = z.input<typeof updateMailboxInputSchema>;
export type IdentityRegistration = z.infer<typeof identityRegistrationSchema>;
export type PostreeveAccountLink = z.infer<typeof postreeveAccountLinkSchema>;
export type CreateMailboxResult = z.infer<typeof createMailboxResultSchema>;
export type AliasResult = z.infer<typeof aliasResultSchema>;
export type CatchAllResult = z.infer<typeof catchAllResultSchema>;
export type MailingList = z.infer<typeof mailingListSchema>;
export type CreateMailingListInput = z.input<typeof createMailingListInputSchema>;
export type UpdateMailingListInput = z.input<typeof updateMailingListInputSchema>;
export type DkimAlgorithm = z.infer<typeof dkimAlgorithmSchema>;
export type DkimKey = z.infer<typeof dkimKeySchema>;
export type DnsRecordCategory = z.infer<typeof dnsRecordCategorySchema>;
export type DnsRecord = z.infer<typeof dnsRecordSchema>;
export type DnsCheck = z.infer<typeof dnsCheckSchema>;
export type DnsChecklist = z.infer<typeof dnsChecklistSchema>;
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;
export type QueuedRecipient = z.infer<typeof queuedRecipientSchema>;
export type MailReport = z.infer<typeof mailReportSchema>;
export type SpamSettings = z.infer<typeof spamSettingsSchema>;
export type UpdateSpamSettingsInput = z.infer<typeof updateSpamSettingsInputSchema>;
export type SpamListName = z.infer<typeof spamListNameSchema>;
export type SpamListEntry = z.infer<typeof spamListEntrySchema>;
export type MailServerOperation = z.infer<typeof mailServerOperationSchema>;
export type MailServerOperationInput = z.input<typeof mailServerOperationSchema>;
export type CreateMailServerProposalInput = z.input<typeof createMailServerProposalInputSchema>;
export type MailServerProposal = z.infer<typeof mailServerProposalSchema>;
export type ApproveMailServerProposalInput = z.input<typeof approveMailServerProposalInputSchema>;

/** Operations that remove a domain or mailbox, and the name the owner must type to approve them. */
export function requiredConfirmations(operations: readonly MailServerOperation[]): string[] {
  return operations.flatMap((operation) => operation.type === "deleteDomain" ? [operation.domain]
    : operation.type === "deleteMailbox" ? [operation.address] : []);
}

export function describeOperation(operation: MailServerOperation): string {
  switch (operation.type) {
    case "addDomain": return `Add domain ${operation.domain}`;
    case "deleteDomain": return `Delete domain ${operation.domain}`;
    case "createMailbox": return `Create mailbox ${operation.address}${operation.addToPostreeve ? " and add it to Postreeve" : ""}`;
    case "updateMailbox": return `Change mailbox ${operation.address}${operation.displayName !== undefined ? ` display name to "${operation.displayName}"` : ""}${operation.quotaBytes !== undefined ? ` quota to ${operation.quotaBytes === null ? "unlimited" : `${operation.quotaBytes} bytes`}` : ""}`;
    case "deleteMailbox": return `Delete mailbox ${operation.address}`;
    case "addAlias": return `Add alias ${operation.alias} to ${operation.address}`;
    case "removeAlias": return `Remove alias ${operation.alias} from ${operation.address}`;
    case "setCatchAll": return operation.address ? `Send unknown addresses at ${operation.domain} to ${operation.address}` : `Turn off the catch-all of ${operation.domain}`;
    case "createMailingList": return `Create mailing list ${operation.address} for ${operation.recipients.length} recipients`;
    case "deleteMailingList": return `Delete mailing list ${operation.address}`;
    case "generateDkim": return `Generate ${operation.algorithm === "rsa" ? "RSA-2048" : "Ed25519"} DKIM key ${operation.selector} for ${operation.domain}`;
    case "deleteDkim": return `Delete DKIM key ${operation.selector} of ${operation.domain}`;
    case "updateSpamSettings": return `Change spam settings: ${Object.entries(operation.settings).map(([key, value]) => `${key} ${value}`).join(", ")}`;
    case "retryQueuedMessage": return `Retry queued message ${operation.id} now`;
    case "cancelQueuedMessage": return `Cancel delivery of queued message ${operation.id}`;
    case "applyDnsChanges": return `Publish the DNS records of ${operation.domain} (only changes selected by default: new records and records Postreeve created)`;
  }
}
