import { imapSearchUids } from "./imap-search-result";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MailboxObject, MailboxOpenOptions, SearchObject } from "imapflow";
import type { ImapClient } from "./imap";
import type { ProviderMessageSummary } from "./provider";
import { SynchronizationError, type MailSynchronization, type SyncAccount, type SyncPage } from "./synchronization";

// ImapFlow supports these SELECT options at runtime but omits them from its declarations.
export interface ImapSyncOpenOptions extends MailboxOpenOptions {
  changedSince?: bigint;
  uidValidity?: bigint;
}

const MAX_SYNC_PAGE_BYTES = 2 * 1024 * 1024;

const decimal = z.string().regex(/^[1-9]\d{0,19}$/);
const uidBoundary = z.number().int().min(0).max(0xffff_ffff);
const cursorSchema = z.object({
  version: z.literal(1), accountId: z.string(), mailbox: z.string(),
  uidValidity: decimal, modseq: decimal.nullable(), through: uidBoundary,
  scan: z.object({ generation: z.string().uuid(), last: uidBoundary, ceiling: uidBoundary, modseq: decimal.nullable() }).nullable(),
});
type Cursor = z.infer<typeof cursorSchema>;

interface ImapSyncOperations {
  accountId: string;
  withClient<T>(operation: (client: ImapClient) => Promise<T>, signal: AbortSignal): Promise<T>;
  summaries(client: ImapClient, mailbox: MailboxObject, uids: number[]): Promise<ProviderMessageSummary[]>;
}

export function imapSynchronization(operations: ImapSyncOperations): MailSynchronization {
  const assertAccount = (account: SyncAccount) => {
    if (account.accountId !== operations.accountId || account.provider !== "imap") throw new Error("IMAP synchronization account mismatch");
  };
  return {
    async discoverScopes(account, signal) {
      assertAccount(account);
      return operations.withClient(async client => {
        const folders = await client.list();
        signal.throwIfAborted();
        return folders.filter(folder => ![...folder.flags].some(flag => flag.toLowerCase() === "\\noselect"))
          .map(folder => ({ kind: "mailbox" as const, mailbox: folder.path }));
      }, signal);
    },
    async fetchPage({ account, scope, cursor: serialized, limit, signal }) {
      assertAccount(account);
      if (scope.kind !== "mailbox") throw new Error("IMAP synchronization requires a mailbox");
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid IMAP synchronization page limit");
      return operations.withClient(async client => {
        let prior = parseCursor(serialized, account.accountId, scope.mailbox);
        const options: ImapSyncOpenOptions = { readOnly: true };
        if (client.enabled?.has("QRESYNC") && prior?.modseq) {
          options.changedSince = BigInt(prior.modseq);
          options.uidValidity = BigInt(prior.uidValidity);
        }
        const mailbox = await client.mailboxOpen(scope.mailbox, options);
        signal.throwIfAborted();
        if (mailbox.path !== scope.mailbox || mailbox.uidValidity <= 0n
          || !Number.isInteger(mailbox.uidNext) || mailbox.uidNext < 1 || mailbox.uidNext > 0x1_0000_0000) {
          throw new Error("IMAP returned invalid mailbox identity");
        }
        const modseq = client.enabled?.has("CONDSTORE") && !mailbox.noModseq && mailbox.highestModseq !== undefined
          && mailbox.highestModseq > 0n ? mailbox.highestModseq.toString() : null;
        if (prior?.uidValidity !== mailbox.uidValidity.toString()
          || (prior.modseq !== null && modseq !== null && BigInt(modseq) < BigInt(prior.modseq))
          || (prior.scan !== null && prior.scan.ceiling >= mailbox.uidNext)) prior = null;
        const checkpoint: Cursor = prior ?? {
          version: 1, accountId: account.accountId, mailbox: scope.mailbox,
          uidValidity: mailbox.uidValidity.toString(), modseq: null, through: 0, scan: null,
        };
        const starting = checkpoint.scan === null;
        const scan = checkpoint.scan ?? { generation: randomUUID(), last: 0, ceiling: mailbox.uidNext - 1, modseq };
        const selected = scan.last < scan.ceiling
          ? await searchPage(client, { uid: `${scan.last + 1}:${scan.ceiling}` }, limit + 1, scan.last + 1, scan.ceiling)
          : [];
        const uids = selected.slice(0, limit);
        let changed = uids;
        if (uids.length > 0 && modseq !== null && checkpoint.modseq !== null) {
          const modifications = await searchPage(client,
            { uid: `${uids[0]}:${uids.at(-1)}`, modseq: BigInt(checkpoint.modseq) + 1n },
            uids.length + 1, uids[0]!, uids.at(-1)!);
          const known = new Set(uids);
          if (modifications.some(uid => !known.has(uid))) throw new Error("IMAP changed UID search disagrees with mailbox coverage");
          const modified = new Set(modifications);
          changed = uids.filter(uid => uid > checkpoint.through || modified.has(uid));
        }
        const messages = changed.length ? await operations.summaries(client, mailbox, changed) : [];
        const expected = new Set(changed);
        for (const message of messages) {
          if (message.ref.accountId !== account.accountId || message.ref.mailbox !== scope.mailbox
            || message.ref.uidValidity !== checkpoint.uidValidity || !expected.delete(message.ref.uid)) {
            throw new Error("IMAP FETCH returned unexpected or duplicate UID");
          }
        }
        if (expected.size) throw new Error("IMAP FETCH did not cover every requested UID");
        signal.throwIfAborted();
        const pageForPrefix = (length: number): SyncPage => {
          const emitted = uids.slice(0, length);
          const last = emitted.at(-1) ?? scan.last;
          const hasMore = selected.length > length;
          const next: Cursor = hasMore
            ? { ...checkpoint, scan: { ...scan, last } }
            : { ...checkpoint, through: scan.ceiling, modseq: modseq === null ? null : scan.modseq, scan: null };
          return {
            messages: messages.filter(message => message.ref.uid <= last),
            removed: [], cursor: JSON.stringify(next), hasMore,
            coverage: hasMore ? "catching-up" : "complete",
            snapshots: [{ scope, generation: scan.generation,
              phase: starting ? (hasMore ? "start" : "start-and-complete") : (hasMore ? "continue" : "complete"),
              seen: emitted.map(uid => ({ accountId: account.accountId, mailbox: scope.mailbox,
                uidValidity: checkpoint.uidValidity, uid, modseq: null })),
            }],
          };
        };
        const full = pageForPrefix(uids.length);
        if (pageFits(full)) return full;
        let fitting: SyncPage | undefined;
        let low = 1;
        let high = uids.length - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const candidate = pageForPrefix(middle);
          if (pageFits(candidate)) { fitting = candidate; low = middle + 1; }
          else high = middle - 1;
        }
        // Skipping or trimming an unrepresentable message would lose identity or falsely advance coverage.
        if (!fitting) throw new SynchronizationError("invalid-data");
        return fitting;
      }, signal);
    },
  };
}

function parseCursor(serialized: string | null, accountId: string, mailbox: string): Cursor | null {
  if (!serialized) return null;
  try {
    const result = cursorSchema.safeParse(JSON.parse(serialized));
    if (!result.success || result.data.accountId !== accountId || result.data.mailbox !== mailbox) return null;
    const cursor = result.data;
    if (cursor.scan && (cursor.scan.last >= cursor.scan.ceiling || cursor.scan.ceiling < cursor.through)) return null;
    return cursor;
  } catch { return null; }
}

function pageFits(page: SyncPage): boolean {
  return Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_SYNC_PAGE_BYTES;
}

async function searchPage(client: ImapClient, query: SearchObject, limit: number, minimum: number, maximum: number): Promise<number[]> {
  const result = await client.search(query, { uid: true, returnOptions: ["ALL", "COUNT"] });
  if (result === false) throw new Error("IMAP UID search failed");
  return imapSearchUids(result, { limit, minimum, maximum });
}
