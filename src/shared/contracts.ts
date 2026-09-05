import { z } from "zod";

export const accountIdSchema = z.string().min(1);
export const proposalIdSchema = z.string().min(1);
export const batchIdSchema = z.string().min(1);

const accountBaseSchema = z.object({
  id: accountIdSchema,
  name: z.string().min(1),
  email: z.email(),
});
export const accountSchema = z.discriminatedUnion("kind", [
  accountBaseSchema.extend({ kind: z.literal("imap") }),
  accountBaseSchema.extend({ kind: z.literal("gmail") }),
]);

export const outboundAddressSchema = z.object({
  name: z.string().max(120).default(""),
  address: z.email(),
});

export const folderSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  specialUse: z.enum(["inbox", "sent", "drafts", "trash", "junk", "archive"]).nullable(),
  unread: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

const folderNameSchema = z.string().trim().min(1).max(200);
const folderPathSchema = z.string().min(1).max(1_000);

export const createFolderInputSchema = z.object({
  accountId: accountIdSchema,
  name: folderNameSchema,
});

export const renameFolderInputSchema = z.object({
  accountId: accountIdSchema,
  path: folderPathSchema,
  name: folderNameSchema,
});

export const deleteFolderInputSchema = z.object({
  accountId: accountIdSchema,
  path: folderPathSchema,
});

export const messageRefSchema = z.object({
  accountId: accountIdSchema,
  mailbox: z.string().min(1),
  uidValidity: z.string().min(1),
  uid: z.number().int().positive(),
  modseq: z.string().min(1).nullable(),
  providerId: z.string().min(1).optional(),
});

export const messageAddressSchema = z.object({
  name: z.string(),
  address: z.string(),
});

export const messageSummarySchema = z.object({
  canonicalId: z.string().min(1).optional(),
  canonicalAliases: z.array(z.string().min(1)).optional(),
  ref: messageRefSchema,
  messageId: z.string(),
  inReplyTo: z.string().nullable().optional(),
  references: z.array(z.string()).optional(),
  subject: z.string(),
  from: z.array(messageAddressSchema),
  replyTo: z.array(messageAddressSchema).optional(),
  to: z.array(messageAddressSchema),
  cc: z.array(messageAddressSchema).optional(),
  deliveredTo: z.array(z.email()).optional(),
  receivedAt: z.iso.datetime(),
  preview: z.string(),
  read: z.boolean(),
  flagged: z.boolean(),
});

export const canonicalMessageSummarySchema = messageSummarySchema.required({ canonicalId: true }).extend({
  canonicalAliases: z.array(z.string().min(1)).default([]),
  conversationId: z.string().min(1),
});

export const mailProviderKindSchema = z.enum(["imap", "gmail"]);

export const canonicalMessageObservationSchema = z.object({
  tenantId: z.string().min(1),
  receivedAt: z.iso.datetime().nullable().default(null),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  location: z.object({
    accountId: accountIdSchema,
    provider: mailProviderKindSchema,
    mailbox: z.string().min(1),
    uidValidity: z.string().min(1),
    uid: z.number().int().positive(),
    modseq: z.string().min(1).nullable(),
    providerId: z.string().min(1).nullable(),
    read: z.boolean(),
    flagged: z.boolean(),
  }),
});

export const canonicalMessageSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  conversationId: z.string().min(1),
  tenantId: z.string().min(1),
  messageId: z.string().nullable(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  receivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const messageDetailSchema = messageSummarySchema.extend({
  text: z.string(),
  html: z.string().nullable(),
});

export const canonicalMessageDetailSchema = messageDetailSchema.required({ canonicalId: true }).extend({
  canonicalAliases: z.array(z.string().min(1)).default([]),
  conversationId: z.string().min(1),
  providerConversationId: z.string().min(1).optional(),
});

export const canonicalConversationSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  tenantId: z.string().min(1),
  messages: z.array(canonicalMessageSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const triageActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("leave") }),
  z.object({ type: z.literal("move"), destination: z.string().min(1) }),
  z.object({ type: z.literal("trash") }),
  z.object({ type: z.literal("mark_read") }),
  z.object({ type: z.literal("mark_unread") }),
]);

export const proposalItemSchema = z.object({
  id: z.string().min(1),
  message: messageRefSchema,
  subject: z.string(),
  action: triageActionSchema,
  reason: z.string().max(500),
});

export const proposalStatusSchema = z.enum([
  "draft",
  "review",
  "approved",
  "applying",
  "applied",
  "partially_applied",
  "failed",
  "undone",
  "partially_undone",
]);

export const proposalSchema = z.object({
  id: proposalIdSchema,
  accountId: accountIdSchema,
  title: z.string().min(1).max(120),
  status: proposalStatusSchema,
  items: z.array(proposalItemSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  approvedAt: z.iso.datetime().nullable(),
  batchId: batchIdSchema.nullable(),
});

export const operationResultSchema = z.object({
  itemId: z.string(),
  message: messageRefSchema,
  action: triageActionSchema,
  status: z.enum(["applied", "failed", "undone", "undo_failed", "not_undoable"]),
  error: z.string().nullable(),
});

export const operationBatchSchema = z.object({
  id: batchIdSchema,
  proposalId: proposalIdSchema,
  accountId: accountIdSchema,
  status: z.enum(["applied", "partially_applied", "failed", "undone", "partially_undone"]),
  operations: z.array(operationResultSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createAccountInputSchema = z.object({
  kind: z.literal("imap"),
  name: z.string().min(1),
  email: z.email(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().min(1),
  password: z.string().min(1),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  smtpUsername: z.string().min(1),
  smtpPassword: z.string().min(1),
});

export const accountSettingsSchema = z.object({
  id: accountIdSchema,
  name: z.string().min(1),
  email: z.email(),
  kind: z.literal("imap"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().min(1),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  smtpUsername: z.string().min(1),
});

export const updateAccountInputSchema = accountSettingsSchema.omit({ id: true, kind: true }).extend({
  password: z.string().min(1).optional(),
  smtpPassword: z.string().min(1).optional(),
});

export const connectionTestResultSchema = z.object({ ok: z.literal(true) });

export const conversationSendSourceSchema = z.object({
  canonicalMessageId: z.string().min(1),
  conversationId: z.string().min(1),
  providerConversationId: z.string().min(1).optional(),
});

export const sendMessageIntentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("new") }),
  z.object({ type: z.literal("reply"), source: conversationSendSourceSchema }),
  z.object({ type: z.literal("reply_all"), source: conversationSendSourceSchema }),
  z.object({ type: z.literal("forward"), source: conversationSendSourceSchema }),
]);

export const sendMessageInputSchema = z.object({
  accountId: accountIdSchema,
  to: z.array(outboundAddressSchema).min(1).max(100),
  cc: z.array(outboundAddressSchema).max(100).default([]),
  bcc: z.array(outboundAddressSchema).max(100).default([]),
  subject: z.string().max(998),
  text: z.string().min(1).max(2_000_000),
  intent: sendMessageIntentSchema.optional(),
});

export const sendReceiptSchema = z.object({
  id: z.string().min(1),
  accountId: accountIdSchema,
  messageId: z.string(),
  accepted: z.array(z.string()),
  rejected: z.array(z.string()),
  submittedAt: z.iso.datetime(),
  warning: z.string().min(1).optional(),
});

export const directActionInputSchema = z.object({
  accountId: accountIdSchema,
  items: z.array(z.object({
    message: messageRefSchema,
    subject: z.string(),
    action: triageActionSchema,
  })).min(1).max(100),
});

export const listMessagesInputSchema = z.object({
  accountId: accountIdSchema,
  mailbox: z.string().min(1),
  query: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export const createProposalInputSchema = z.object({
  accountId: accountIdSchema,
  title: z.string().min(1).max(120),
  items: z.array(proposalItemSchema).min(1).max(100),
});

export const updateProposalInputSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  status: z.literal("review").optional(),
  items: z.array(proposalItemSchema).min(1).max(100).optional(),
});

export type Account = z.infer<typeof accountSchema>;
export type Folder = z.infer<typeof folderSchema>;
export type CreateFolderInput = z.infer<typeof createFolderInputSchema>;
export type RenameFolderInput = z.infer<typeof renameFolderInputSchema>;
export type DeleteFolderInput = z.infer<typeof deleteFolderInputSchema>;
export type MessageRef = z.infer<typeof messageRefSchema>;
export type MessageSummary = z.infer<typeof messageSummarySchema>;
export type CanonicalMessageSummary = z.infer<typeof canonicalMessageSummarySchema>;
export type MessageDetail = z.infer<typeof messageDetailSchema>;
export type CanonicalMessageDetail = z.infer<typeof canonicalMessageDetailSchema>;
export type MailProviderKind = z.infer<typeof mailProviderKindSchema>;
export type CanonicalMessageObservation = z.input<typeof canonicalMessageObservationSchema>;
export type CanonicalMessage = z.infer<typeof canonicalMessageSchema>;
export type CanonicalConversation = z.infer<typeof canonicalConversationSchema>;
export type TriageAction = z.infer<typeof triageActionSchema>;
export type ProposalItem = z.infer<typeof proposalItemSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;
export type OperationResult = z.infer<typeof operationResultSchema>;
export type OperationBatch = z.infer<typeof operationBatchSchema>;
export type CreateAccountInput = z.infer<typeof createAccountInputSchema>;
export type AccountSettings = z.infer<typeof accountSettingsSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountInputSchema>;
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
export type OutboundAddress = z.infer<typeof outboundAddressSchema>;
export type ConversationSendSource = z.infer<typeof conversationSendSourceSchema>;
export type SendMessageIntent = z.infer<typeof sendMessageIntentSchema>;
export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;
export type SendReceipt = z.infer<typeof sendReceiptSchema>;
export type DirectActionInput = z.infer<typeof directActionInputSchema>;
export type ListMessagesInput = z.infer<typeof listMessagesInputSchema>;
export type CreateProposalInput = z.infer<typeof createProposalInputSchema>;
export type UpdateProposalInput = z.infer<typeof updateProposalInputSchema>;
