import { sql } from "drizzle-orm";
import { blob, check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  ConversationSendSource,
  DraftComposeMode,
  DraftAttachment,
  DraftRecipientField,
  OperationResult,
  OutboundAddress,
  ProposalItem,
  ProposalStatus,
  SendReceipt,
  ProviderDraftRef,
} from "../../shared/contracts";
import type { AppliedMailAction } from "../mail/provider";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  kind: text("kind", { enum: ["imap", "gmail"] }).notNull(),
  encryptedCredentials: text("encrypted_credentials"),
  createdAt: text("created_at").notNull(),
});

export const drafts = sqliteTable("drafts", {
  id: text("id").notNull(),
  tenantId: text("tenant_id").notNull(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  mode: text("mode").$type<DraftComposeMode>().notNull(),
  recipientsTo: text("recipients_to", { mode: "json" }).$type<DraftRecipientField>().notNull(),
  recipientsCc: text("recipients_cc", { mode: "json" }).$type<DraftRecipientField>().notNull(),
  recipientsBcc: text("recipients_bcc", { mode: "json" }).$type<DraftRecipientField>().notNull(),
  subject: text("subject").notNull(),
  bodyFormat: text("body_format", { enum: ["plain", "html"] }).notNull().default("plain"),
  body: text("body").notNull(),
  identity: text("identity", { mode: "json" }).$type<OutboundAddress>().notNull(),
  source: text("source", { mode: "json" }).$type<ConversationSendSource>(),
  attachments: text("attachments", { mode: "json" }).$type<DraftAttachment[]>().notNull(),
  deliveryStatus: text("delivery_status", {
    enum: ["editable", "sending", "failed", "uncertain", "sent"],
  }).notNull(),
  deliveryReceipt: text("delivery_receipt", { mode: "json" }).$type<SendReceipt>(),
  deliveryError: text("delivery_error"),
  claimedAt: text("claimed_at"),
  claimOwner: text("claim_owner"),
  settledAt: text("settled_at"),
  mirrorStatus: text("mirror_status", { enum: ["pending", "synced", "failed"] }).notNull(),
  mirrorRef: text("mirror_ref", { mode: "json" }).$type<ProviderDraftRef>(),
  mirroredVersion: integer("mirrored_version"),
  mirrorError: text("mirror_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  version: integer("version").notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.id] }),
  index("drafts_tenant_account_updated_idx").on(table.tenantId, table.accountId, table.updatedAt),
  check("drafts_version_check", sql`${table.version} > 0`),
  check("drafts_delivery_state_check", sql`
    (${table.deliveryStatus} = 'editable' AND ${table.deliveryReceipt} IS NULL
      AND ${table.deliveryError} IS NULL AND ${table.claimedAt} IS NULL
      AND ${table.claimOwner} IS NULL AND ${table.settledAt} IS NULL)
    OR (${table.deliveryStatus} = 'sending' AND ${table.deliveryReceipt} IS NULL
      AND ${table.deliveryError} IS NULL AND ${table.claimedAt} IS NOT NULL
      AND ${table.claimOwner} IS NOT NULL AND ${table.settledAt} IS NULL)
    OR (${table.deliveryStatus} = 'failed'
      AND length(trim(${table.deliveryError})) > 0 AND ${table.claimedAt} IS NOT NULL
      AND ${table.claimOwner} IS NOT NULL AND ${table.settledAt} IS NOT NULL)
    OR (${table.deliveryStatus} = 'uncertain' AND ${table.deliveryReceipt} IS NULL
      AND length(trim(${table.deliveryError})) > 0 AND ${table.claimedAt} IS NOT NULL
      AND ${table.claimOwner} IS NOT NULL AND ${table.settledAt} IS NOT NULL)
    OR (${table.deliveryStatus} = 'sent' AND ${table.deliveryReceipt} IS NOT NULL
      AND ${table.deliveryError} IS NULL AND ${table.claimedAt} IS NOT NULL
      AND ${table.claimOwner} IS NOT NULL AND ${table.settledAt} IS NOT NULL)
  `),
]);

export const draftFiles = sqliteTable("draft_files", {
  tenantId: text("tenant_id").notNull(),
  accountId: text("account_id").notNull(),
  draftId: text("draft_id").notNull(),
  id: text("id").notNull(),
  name: text("name").notNull(),
  mediaType: text("media_type").notNull(),
  content: blob("content", { mode: "buffer" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.draftId, table.id] }),
  foreignKey({ columns: [table.tenantId, table.draftId], foreignColumns: [drafts.tenantId, drafts.id] }).onDelete("cascade"),
]);

export const draftTombstones = sqliteTable("draft_tombstones", {
  id: text("id").notNull(),
  tenantId: text("tenant_id").notNull(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  deletedAt: text("deleted_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.accountId, table.id] }),
  index("draft_tombstones_tenant_account_idx").on(table.tenantId, table.accountId),
]);

export const proposals = sqliteTable("proposals", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  title: text("title").notNull(),
  status: text("status").$type<ProposalStatus>().notNull(),
  items: text("items", { mode: "json" }).$type<ProposalItem[]>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  approvedAt: text("approved_at"),
  batchId: text("batch_id"),
});

export interface StoredOperation {
  result: OperationResult;
  applied: AppliedMailAction | null;
}

export const batches = sqliteTable("operation_batches", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull().references(() => proposals.id),
  accountId: text("account_id").notNull().references(() => accounts.id),
  status: text("status", {
    enum: ["applied", "partially_applied", "failed", "undone", "partially_undone"],
  }).notNull(),
  operations: text("operations", { mode: "json" }).$type<StoredOperation[]>().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const migrations = sqliteTable("schema_migrations", {
  version: integer("version").primaryKey(),
  appliedAt: text("applied_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  identityKey: text("identity_key").notNull(),
  messageId: text("message_id"),
  inReplyTo: text("in_reply_to"),
  references: text("references", { mode: "json" }).$type<string[]>().notNull(),
  receivedAt: text("received_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("messages_tenant_id_id_unique").on(table.tenantId, table.id),
  uniqueIndex("messages_tenant_id_identity_key_unique").on(table.tenantId, table.identityKey),
  index("messages_tenant_id_message_id_idx").on(table.tenantId, table.messageId),
]);

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("conversations_tenant_id_id_unique").on(table.tenantId, table.id),
]);

export const conversationMessages = sqliteTable("conversation_messages", {
  tenantId: text("tenant_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  messageId: text("message_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.messageId] }),
  foreignKey({
    columns: [table.tenantId, table.conversationId],
    foreignColumns: [conversations.tenantId, conversations.id],
  }),
  foreignKey({
    columns: [table.tenantId, table.messageId],
    foreignColumns: [messages.tenantId, messages.id],
  }),
  index("conversation_messages_conversation_id_idx").on(table.conversationId),
]);

export const conversationAliases = sqliteTable("conversation_aliases", {
  aliasId: text("alias_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.aliasId] }),
  foreignKey({
    columns: [table.tenantId, table.conversationId],
    foreignColumns: [conversations.tenantId, conversations.id],
  }),
  index("conversation_aliases_conversation_id_idx").on(table.conversationId),
]);

export const messageProviderConversations = sqliteTable("message_provider_conversations", {
  tenantId: text("tenant_id").notNull(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  provider: text("provider", { enum: ["imap", "gmail"] }).notNull(),
  providerConversationId: text("provider_conversation_id").notNull(),
  messageId: text("message_id").notNull(),
}, (table) => [
  primaryKey({ columns: [
    table.tenantId, table.accountId, table.provider, table.providerConversationId, table.messageId,
  ] }),
  foreignKey({
    columns: [table.tenantId, table.messageId],
    foreignColumns: [messages.tenantId, messages.id],
  }),
  index("message_provider_conversations_message_id_idx").on(table.messageId),
]);

export const messageThreadEdges = sqliteTable("message_thread_edges", {
  tenantId: text("tenant_id").notNull(),
  messageId: text("message_id").notNull(),
  referencedMessageId: text("referenced_message_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.messageId, table.referencedMessageId] }),
  foreignKey({
    columns: [table.tenantId, table.messageId],
    foreignColumns: [messages.tenantId, messages.id],
  }),
  index("message_thread_edges_reference_idx").on(table.tenantId, table.referencedMessageId),
]);

export const messageReferenceSequences = sqliteTable("message_reference_sequences", {
  tenantId: text("tenant_id").notNull(),
  messageId: text("message_id").notNull(),
  sequenceKey: text("sequence_key").notNull(),
  position: integer("position").notNull(),
  referencedMessageId: text("referenced_message_id").notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.messageId, table.sequenceKey, table.position] }),
  foreignKey({
    columns: [table.tenantId, table.messageId],
    foreignColumns: [messages.tenantId, messages.id],
  }),
]);

export const messageAliases = sqliteTable("message_aliases", {
  aliasId: text("alias_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  messageId: text("message_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.aliasId] }),
  foreignKey({
    columns: [table.tenantId, table.messageId],
    foreignColumns: [messages.tenantId, messages.id],
  }),
  index("message_aliases_message_id_idx").on(table.messageId),
]);

export const messageProviderAssociations = sqliteTable("message_provider_associations", {
  tenantId: text("tenant_id").notNull(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  provider: text("provider", { enum: ["imap", "gmail"] }).notNull(),
  providerId: text("provider_id"),
  mailbox: text("mailbox"),
  uidValidity: text("uid_validity"),
  uid: integer("uid"),
  messageId: text("message_id").notNull(),
}, (table) => [
  foreignKey({
    columns: [table.tenantId, table.messageId],
    foreignColumns: [messages.tenantId, messages.id],
    name: "message_provider_associations_tenant_message_fk",
  }),
  uniqueIndex("message_provider_associations_provider_id_unique")
    .on(table.tenantId, table.accountId, table.provider, table.providerId)
    .where(sql`${table.providerId} IS NOT NULL`),
  uniqueIndex("message_provider_associations_location_unique")
    .on(table.tenantId, table.accountId, table.provider, table.mailbox, table.uidValidity, table.uid)
    .where(sql`${table.providerId} IS NULL`),
  index("message_provider_associations_message_id_idx").on(table.messageId),
  check("message_provider_associations_identity_check", sql`
    (${table.providerId} IS NOT NULL AND ${table.providerId} <> ''
      AND ${table.mailbox} IS NULL AND ${table.uidValidity} IS NULL AND ${table.uid} IS NULL)
    OR (${table.providerId} IS NULL AND ${table.mailbox} IS NOT NULL AND ${table.uidValidity} IS NOT NULL AND ${table.uid} IS NOT NULL)
  `),
]);

export const messageLocations = sqliteTable("message_locations", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  accountId: text("account_id").notNull().references(() => accounts.id),
  provider: text("provider", { enum: ["imap", "gmail"] }).notNull(),
  mailbox: text("mailbox").notNull(),
  locationKey: text("location_key").notNull(),
  uidValidity: text("uid_validity").notNull(),
  uid: integer("uid").notNull(),
  modseq: text("modseq"),
  providerId: text("provider_id"),
  read: integer("read", { mode: "boolean" }).notNull(),
  flagged: integer("flagged", { mode: "boolean" }).notNull(),
  observedAt: text("observed_at").notNull(),
}, (table) => [
  foreignKey({
    columns: [table.tenantId, table.messageId],
    foreignColumns: [messages.tenantId, messages.id],
    name: "message_locations_tenant_message_fk",
  }),
  uniqueIndex("message_locations_tenant_account_provider_mailbox_location_key_unique")
    .on(table.tenantId, table.accountId, table.provider, table.mailbox, table.locationKey),
]);

// Agent access (remote MCP). Every secret column holds a SHA-256 hash, never the secret.
export const agentClients = sqliteTable("agent_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
  authMethod: text("auth_method", { enum: ["none", "client_secret_post", "client_secret_basic"] }).notNull(),
  secretHash: text("secret_hash"),
  createdAt: text("created_at").notNull(),
});

export const agentGrants = sqliteTable("agent_grants", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["oauth", "token"] }).notNull(),
  clientId: text("client_id").references(() => agentClients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  redirectHost: text("redirect_host"),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  accountIds: text("account_ids", { mode: "json" }).$type<string[] | null>(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
});

export const agentCodes = sqliteTable("agent_codes", {
  hash: text("hash").primaryKey(),
  grantId: text("grant_id").notNull().references(() => agentGrants.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource"),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
});

export const agentTokens = sqliteTable("agent_tokens", {
  hash: text("hash").primaryKey(),
  grantId: text("grant_id").notNull().references(() => agentGrants.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["access", "refresh", "personal"] }).notNull(),
  resource: text("resource"),
  scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
}, (table) => [index("agent_tokens_grant_idx").on(table.grantId)]);

/** Audit of remote agent tool calls; kept after revocation so history stays readable. */
export const agentEvents = sqliteTable("agent_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  grantId: text("grant_id").notNull(),
  agentName: text("agent_name").notNull(),
  tool: text("tool").notNull(),
  accountId: text("account_id"),
  outcome: text("outcome", { enum: ["ok", "error"] }).notNull(),
  summary: text("summary").notNull(),
  error: text("error"),
  targetKind: text("target_kind", { enum: ["batch", "proposal"] }),
  targetId: text("target_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("agent_events_created_idx").on(table.createdAt)]);
