import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ImapFlowOptions } from "imapflow";
import { idleReconnectDelayMs, watchImapInbox, type IdleClient } from "../src/server/mail/imap-idle";

class FakeIdleClient extends EventEmitter implements IdleClient {
  readonly opened: string[] = [];
  loggedOut = false;
  closed = false;
  constructor(readonly capabilities: Map<string, boolean | number>, readonly failConnect = false) { super(); }
  async connect(): Promise<void> {
    if (this.failConnect) throw Object.assign(new Error("auth"), { authenticationFailed: true });
  }
  async mailboxOpen(path: string): Promise<unknown> { this.opened.push(path); return {}; }
  async logout(): Promise<void> { this.loggedOut = true; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

const connection = { host: "imap.example.test", port: 993, secure: true, auth: { user: "u", pass: "p" } };
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function harness(script: Array<() => FakeIdleClient>) {
  const clients: FakeIdleClient[] = [];
  const options: ImapFlowOptions[] = [];
  const delays: number[] = [];
  const changes: string[] = [];
  let now = 0;
  let release: (() => void) | undefined;
  const watch = watchImapInbox({
    connection,
    createClient: value => {
      options.push(value);
      const client = (script.shift() ?? (() => new FakeIdleClient(new Map([["IDLE", true]]))))();
      clients.push(client);
      return client;
    },
    onChange: mailbox => changes.push(mailbox),
    now: () => now,
    delay: async (ms, signal) => {
      delays.push(ms);
      await new Promise<void>((resolve, reject) => {
        release = resolve;
        signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      });
    },
  });
  return { watch, clients, options, delays, changes, clock: (value: number) => { now = value; }, next: () => release?.() };
}

describe("IMAP Inbox IDLE watch", () => {
  test("opens INBOX read-only, catches up on connect and forwards changes", async () => {
    const h = harness([]);
    await settle();
    const [client] = h.clients;
    expect(client!.opened).toEqual(["INBOX"]);
    expect(h.options[0]).toMatchObject({ maxIdleTime: 25 * 60_000, logger: false, host: "imap.example.test" });
    expect(h.changes).toEqual(["INBOX"]);
    client!.emit("exists");
    client!.emit("expunge");
    client!.emit("flags");
    expect(h.changes).toHaveLength(4);
    h.watch.stop();
    await settle();
    expect(client!.closed).toBe(true);
    expect(h.clients).toHaveLength(1);
  });

  test("falls back to polling without IDLE", async () => {
    const h = harness([() => new FakeIdleClient(new Map())]);
    await settle();
    expect(h.clients[0]!.loggedOut).toBe(true);
    expect(h.changes).toEqual([]);
    expect(h.delays).toEqual([]);
  });

  test("reconnects with growing capped backoff that resets after a stable connection", async () => {
    const failing = () => new FakeIdleClient(new Map([["IDLE", true]]), true);
    const h = harness([failing, failing]);
    await settle();
    expect(h.delays).toEqual([5_000]);
    h.next();
    await settle();
    expect(h.delays).toEqual([5_000, 10_000]);
    h.next();
    await settle();
    h.clock(60_000);
    h.clients[2]!.close();
    await settle();
    expect(h.delays).toEqual([5_000, 10_000, 5_000]);
    h.watch.stop();
    expect(idleReconnectDelayMs(30)).toBe(15 * 60_000);
  });
});
