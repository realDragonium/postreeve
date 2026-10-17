import { z } from "zod";
import { canonicalMessageSummarySchema, messageAddressSchema } from "./contracts";

export const mailboxSourceSchema = z.object({ accountId: z.string().min(1), mailbox: z.string().min(1).max(1024) }).strict();
export const messageFilterSchema = z.enum(["all", "unread", "flagged"]);
export const messageSortSchema = z.enum(["newest", "oldest", "sender", "subject"]);
/** `sources` searches the listed account/mailbox pairs; `everywhere` searches every indexed folder of every account. */
export const mailboxScopeSchema = z.enum(["sources", "everywhere"]);
export const messageGroupingSchema = z.enum(["none", "conversation"]);
export const mailboxQuerySchema = z.object({
  sources: z.array(mailboxSourceSchema).max(1000).default([]),
  scope: mailboxScopeSchema.default("sources"),
  query: z.string().trim().max(200).default(""),
  limit: z.number().int().min(1).max(100).default(50),
  filter: messageFilterSchema.default("all"),
  sort: messageSortSchema.default("newest"),
  group: messageGroupingSchema.default("none"),
  cursor: z.string().min(1).max(131072).optional(),
}).strict().refine(query => query.scope === "everywhere" || query.sources.length > 0,
  { message: "Specify at least one source or the everywhere scope", path: ["sources"] });
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
/** One conversation row of a grouped page, aligned with the representative message at the same index. */
export const conversationGroupSchema = z.object({
  conversationId: z.string().min(1),
  /** Messages of the conversation in the current view (sources, filter and search). */
  count: z.number().int().positive(),
  unread: z.number().int().nonnegative(),
  participants: z.array(messageAddressSchema),
  latest: z.object({ receivedAt: z.string(), preview: z.string() }),
  /** Up to 100 member summaries, newest first, so actions on the group can address each message. */
  members: z.array(canonicalMessageSummarySchema),
});
export const mailboxPageSchema = z.object({
  messages: z.array(canonicalMessageSummarySchema),
  groups: z.array(conversationGroupSchema).optional(),
  nextCursor: z.string().nullable(),
  coverage: mailboxCoverageSchema,
});
export type MailboxSource = z.infer<typeof mailboxSourceSchema>;
export type MailboxQuery = z.infer<typeof mailboxQuerySchema>;
export type MailboxQueryInput = z.input<typeof mailboxQuerySchema>;
export type MailboxCoverage = z.infer<typeof mailboxCoverageSchema>;
export type ConversationGroup = z.infer<typeof conversationGroupSchema>;
export type MailboxPage = z.infer<typeof mailboxPageSchema>;
export const SEARCH_BODY_LIMIT = 32_768;
export const SEARCH_HEADERS_LIMIT = 32_768;
export const CONVERSATION_GROUP_MEMBER_LIMIT = 100;

/** Fields a text term can be limited to; `any` searches sender, recipients, subject, headers, preview and body. */
export type SearchField = "any" | "from" | "to" | "cc" | "subject";
export interface SearchTerm { readonly field: SearchField; readonly value: string; readonly negated: boolean }
export interface NamedFilter { readonly value: string; readonly negated: boolean }
export interface ParsedMailboxQuery {
  readonly terms: readonly SearchTerm[];
  /** true requires the state, false requires its absence; undefined leaves it open. */
  readonly unread?: boolean;
  readonly flagged?: boolean;
  readonly attachment?: boolean;
  /** ISO timestamps: received at or after `after`, and strictly before `before`. */
  readonly after?: string;
  readonly before?: string;
  readonly folders: readonly NamedFilter[];
  readonly accounts: readonly NamedFilter[];
  /** `in:anywhere` widens the search to every folder of every account. */
  readonly anywhere: boolean;
  /** Operators the parser recognised but could not apply, such as an invalid date. */
  readonly errors: readonly string[];
}

const fieldOperators: Record<string, SearchField> = { from: "from", to: "to", cc: "cc", subject: "subject" };
const datePattern = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;

function day(value: string): string | null {
  const match = datePattern.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCMonth() === Number(match[2]) - 1 ? date.toISOString() : null;
}

/**
 * Splits on whitespace outside double quotes; quotes are dropped. `literal` marks a token whose text (after an
 * optional leading `-`) starts with a quote, so `"from:alex"` stays literal while `subject:"two words"` is an operator.
 */
function tokens(text: string): Array<{ raw: string; literal: boolean }> {
  const result: Array<{ raw: string; literal: boolean }> = [];
  let current = "";
  let literal = false;
  let inQuotes = false;
  let started = false;
  const flush = () => { if (started) result.push({ raw: current, literal }); current = ""; literal = false; started = false; };
  for (const character of text) {
    if (character === "\"") {
      if (!started || current === "-") literal = true;
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (!inQuotes && /\s/.test(character)) { flush(); continue; }
    current += character;
    started = true;
  }
  flush();
  return result;
}

/**
 * Parses search text into literal terms and operators. Matching is case-insensitive, so values are lowercased.
 * Unknown `name:value` words stay literal text, which keeps searches such as `re:` or URLs working.
 */
export function parseMailboxQuery(text: string): ParsedMailboxQuery {
  const terms: SearchTerm[] = [];
  const folders: NamedFilter[] = [];
  const accounts: NamedFilter[] = [];
  const errors: string[] = [];
  let unread: boolean | undefined;
  let flagged: boolean | undefined;
  let attachment: boolean | undefined;
  let after: string | undefined;
  let before: string | undefined;
  let anywhere = false;
  for (const token of tokens(text.toLowerCase())) {
    let raw = token.raw;
    let negated = false;
    if (raw.startsWith("-") && raw.length > 1) { negated = true; raw = raw.slice(1); }
    const colon = token.literal ? -1 : raw.indexOf(":");
    const name = colon > 0 ? raw.slice(0, colon) : "";
    const value = colon > 0 ? raw.slice(colon + 1) : raw;
    if (!value) { if (raw) terms.push({ field: "any", value: raw, negated }); continue; }
    if (name in fieldOperators) { terms.push({ field: fieldOperators[name]!, value, negated }); continue; }
    if (name === "is" && (value === "unread" || value === "read")) { unread = (value === "unread") !== negated; continue; }
    if (name === "is" && (value === "flagged" || value === "starred")) { flagged = !negated; continue; }
    if (name === "has" && (value === "attachment" || value === "attachments")) { attachment = !negated; continue; }
    if (name === "before" || name === "after") {
      const parsed = day(value);
      if (!parsed) { errors.push(`${name}: needs a date such as 2026-01-31`); continue; }
      if ((name === "before") !== negated) before = parsed;
      else after = parsed;
      continue;
    }
    if (name === "in" && value === "anywhere") { if (!negated) anywhere = true; continue; }
    if (name === "in") { folders.push({ value, negated }); continue; }
    if (name === "account") { accounts.push({ value, negated }); continue; }
    terms.push({ field: "any", value: raw, negated });
  }
  return { terms, folders, accounts, anywhere, errors,
    ...(unread === undefined ? {} : { unread }), ...(flagged === undefined ? {} : { flagged }),
    ...(attachment === undefined ? {} : { attachment }), ...(after === undefined ? {} : { after }),
    ...(before === undefined ? {} : { before }) };
}

/** The free-text part of a query, which providers can search without understanding Postreeve operators. */
export function plainSearchText(parsed: ParsedMailboxQuery): string {
  return parsed.terms.filter(term => term.field === "any" && !term.negated).map(term => term.value).join(" ");
}

const folderAliases: Record<string, readonly string[]> = {
  inbox: ["inbox"],
  sent: ["sent", "sent mail", "sent items", "sent messages", "[gmail]/sent mail"],
  drafts: ["drafts", "draft", "[gmail]/drafts"],
  archive: ["archive", "archives", "all mail", "[gmail]/all mail", "__archive__"],
  spam: ["spam", "junk", "junk e-mail", "junk email", "bulk mail", "[gmail]/spam"],
  junk: ["spam", "junk", "junk e-mail", "junk email", "bulk mail", "[gmail]/spam"],
  trash: ["trash", "deleted items", "deleted messages", "bin", "[gmail]/trash", "[gmail]/bin"],
  starred: ["starred", "[gmail]/starred"],
};

/**
 * Whether an `in:` value names a mailbox: its full path, its last path segment, or a well-known special-use name
 * (`in:sent` matches Gmail's SENT label, "Sent Items" and "INBOX.Sent").
 */
export function folderMatches(value: string, mailbox: string): boolean {
  const path = mailbox.toLowerCase();
  const leaf = path.split(/[/.]/).at(-1) ?? path;
  const names = folderAliases[value] ?? [value];
  return names.some(name => name === path || name === leaf);
}

/** Whether an `account:` value names an account by address, by name, or by part of either. */
export function accountMatches(value: string, account: { readonly id: string; readonly email: string; readonly name: string }): boolean {
  return account.id === value || account.email.toLowerCase().includes(value) || account.name.toLowerCase().includes(value);
}
