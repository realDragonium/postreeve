import { foreignKey, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
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
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("messages_tenant_id_id_unique").on(table.tenantId, table.id),
  uniqueIndex("messages_tenant_id_identity_key_unique").on(table.tenantId, table.identityKey),
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
]);
