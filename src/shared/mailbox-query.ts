import { z } from "zod";
import { canonicalMessageSummarySchema } from "./contracts";

export const mailboxSourceSchema = z.object({ accountId: z.string().min(1), mailbox: z.string().min(1).max(1024) }).strict();
export const messageFilterSchema = z.enum(["all", "unread", "flagged"]);
export const messageSortSchema = z.enum(["newest", "oldest", "sender", "subject"]);
export const mailboxQuerySchema = z.object({
  sources: z.array(mailboxSourceSchema).min(1).max(1000),
  query: z.string().trim().max(200).default(""),
  limit: z.number().int().min(1).max(100).default(50),
  filter: messageFilterSchema.default("all"),
  sort: messageSortSchema.default("newest"),
  cursor: z.string().min(1).max(131072).optional(),
}).strict();
export const mailboxCoverageSchema = z.object({
  sources: z.array(mailboxSourceSchema.extend({
    synchronized: z.boolean(),
    indexedMessages: z.number().int().nonnegative(),
    bodiesAvailable: z.number().int().nonnegative(),
    fallback: z.enum(["not-needed", "limited", "failed", "not-requested"]),
  })),
  complete: z.boolean(),
  bodyTextLimit: z.number().int().positive(),
});
export const mailboxPageSchema = z.object({
  messages: z.array(canonicalMessageSummarySchema),
  nextCursor: z.string().nullable(),
  coverage: mailboxCoverageSchema,
});
export type MailboxSource = z.infer<typeof mailboxSourceSchema>;
export type MailboxQuery = z.infer<typeof mailboxQuerySchema>;
export type MailboxQueryInput = z.input<typeof mailboxQuerySchema>;
export type MailboxCoverage = z.infer<typeof mailboxCoverageSchema>;
export type MailboxPage = z.infer<typeof mailboxPageSchema>;
export const SEARCH_BODY_LIMIT = 32_768;
export const SEARCH_HEADERS_LIMIT = 32_768;
