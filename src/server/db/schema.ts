import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
  kind: text("kind", { enum: ["imap"] }).notNull(),
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
