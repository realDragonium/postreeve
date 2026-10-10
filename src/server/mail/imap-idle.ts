import { ImapFlow, type ImapFlowOptions, type MailboxOpenOptions } from "imapflow";
import type { ProviderWatch } from "./provider";

export interface IdleClient {
  readonly capabilities: Map<string, boolean | number>;
  connect(): Promise<void>;
  mailboxOpen(path: string, options?: MailboxOpenOptions): Promise<unknown>;
  logout(): Promise<void>;
  close(): void;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exists", listener: () => void): unknown;
  on(event: "expunge", listener: () => void): unknown;
  on(event: "flags", listener: () => void): unknown;
}
export type IdleClientFactory = (options: ImapFlowOptions) => IdleClient;
export const defaultIdleClientFactory: IdleClientFactory = (options) => new ImapFlow(options);

export interface ImapInboxWatchOptions {
  readonly connection: Pick<ImapFlowOptions, "host" | "port" | "secure" | "auth">;
  readonly createClient: IdleClientFactory;
  readonly onChange: (mailbox: string) => void;
  readonly now?: () => number;
  readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// RFC 2177 servers may drop IDLE after 30 minutes; restart it well before that.
const REIDLE_MS = 25 * 60_000;
// A connection that dies sooner than this keeps growing the backoff, so a server that accepts and drops is not hammered.
const STABLE_CONNECTION_MS = 60_000;
const INBOX = "INBOX";

export function idleReconnectDelayMs(failures: number): number {
  return Math.min(5_000 * 2 ** Math.min(failures, 20), 15 * 60_000);
}

export function watchImapInbox(options: ImapInboxWatchOptions): ProviderWatch {
  const controller = new AbortController();
  void runWatch(options, controller.signal);
  return { stop: () => controller.abort() };
}

async function runWatch(options: ImapInboxWatchOptions, signal: AbortSignal): Promise<void> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? abortableDelay;
  let failures = 0;
  while (!signal.aborted) {
    const client = options.createClient({ ...options.connection, logger: false, maxIdleTime: REIDLE_MS, autoIdleDelay: 1_000 });
    const abort = () => client.close();
    signal.addEventListener("abort", abort, { once: true });
    let connectedAt: number | null = null;
    let unsupported = false;
    try {
      const closed = new Promise<void>(resolve => {
        client.on("close", resolve);
        client.on("error", () => resolve());
      });
      await client.connect();
      if (!client.capabilities.has("IDLE")) {
        unsupported = true;
        await client.logout();
      } else {
        const changed = () => options.onChange(INBOX);
        client.on("exists", changed);
        client.on("expunge", changed);
        client.on("flags", changed);
        await client.mailboxOpen(INBOX, { readOnly: true });
        connectedAt = now();
        changed();
        await closed;
      }
    } catch {
      // Any failure, including rejected credentials, reconnects with backoff; synchronization classifies the account.
    } finally {
      signal.removeEventListener("abort", abort);
      client.close();
    }
    if (unsupported || signal.aborted) return;
    if (connectedAt !== null && now() - connectedAt >= STABLE_CONNECTION_MS) failures = 0;
    await delay(idleReconnectDelayMs(failures++), signal).catch(() => undefined);
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
    timer.unref();
    const stop = () => { clearTimeout(timer); reject(new Error("IDLE watch stopped")); };
    signal.addEventListener("abort", stop, { once: true });
  });
}
