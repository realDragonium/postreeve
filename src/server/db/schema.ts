import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  OperationResult,
  ProposalItem,
  ProposalStatus,
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
