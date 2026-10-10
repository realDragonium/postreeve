import { mailboxEventSchema, type MailboxEvent } from "../shared/mailbox-events";

/** Splits complete Server-Sent Events from a text buffer, returning their data and the unfinished remainder. */
export function parseServerSentEvents(buffer: string): { readonly data: readonly string[]; readonly rest: string } {
  const blocks = buffer.replace(/\r\n?/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  const data = blocks.flatMap(block => {
    const lines = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, ""));
    return lines.length ? [lines.join("\n")] : [];
  });
  return { data, rest };
}

export function eventStreamRetryDelayMs(failures: number): number {
  return Math.min(1_000 * 2 ** Math.min(failures, 10), 30_000);
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

interface EventStreamOptions {
  readonly fetch?: Fetcher;
  readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Follows `/api/events` with fetch streaming rather than EventSource, because fetch is the path the desktop
 * protocol proxy supports. Reconnects with backoff until the returned function is called.
 */
export function subscribeToMailboxEvents(onEvent: (event: MailboxEvent) => void, options: EventStreamOptions = {}): () => void {
  const controller = new AbortController();
  void follow(onEvent, options.fetch ?? ((input, init) => fetch(input, init)), options.delay ?? delay, controller.signal);
  return () => controller.abort();
}

async function follow(onEvent: (event: MailboxEvent) => void, fetcher: Fetcher,
  wait: (ms: number, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const response = await fetcher("/api/events", { headers: { Accept: "text/event-stream" }, signal });
      if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status})`);
      failures = 0;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = parseServerSentEvents(buffer + value);
        buffer = parsed.rest;
        for (const data of parsed.data) {
          const event = mailboxEventSchema.safeParse(safeJson(data));
          if (event.success) onEvent(event.data);
        }
      }
    } catch {
      // Reconnect below; the folder poll keeps counts current meanwhile.
    }
    if (signal.aborted) return;
    await wait(eventStreamRetryDelayMs(failures++), signal).catch(() => undefined);
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new Error("stopped")); }, { once: true });
  });
}
