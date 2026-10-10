import { describe, expect, test } from "bun:test";
import { eventStreamRetryDelayMs, parseServerSentEvents, subscribeToMailboxEvents } from "../src/web/mailbox-events";
import type { MailboxEvent } from "../src/shared/mailbox-events";

describe("server-sent event parsing", () => {
  test("returns complete events, ignores comments and keeps the unfinished tail", () => {
    expect(parseServerSentEvents(": connected\n\ndata: {\"a\":1}\r\n\r\ndata: one\ndata: two\n\ndata: par")).toEqual({
      data: ['{"a":1}', "one\ntwo"], rest: "data: par" });
  });

  test("retry delay grows and is capped", () => {
    expect([0, 1, 2, 10].map(eventStreamRetryDelayMs)).toEqual([1_000, 2_000, 4_000, 30_000]);
  });
});

describe("mailbox event subscription", () => {
  test("delivers valid events split across chunks and reconnects after the stream ends", async () => {
    const encoder = new TextEncoder();
    const chunks = ['data: {"type":"mailbox-changed",', '"accountId":"a"}\n\ndata: {"type":"unknown"}\n\n'];
    let connections = 0;
    const delays: number[] = [];
    const received: MailboxEvent[] = [];
    const reconnected = Promise.withResolvers<void>();
    const stop = subscribeToMailboxEvents(event => received.push(event), {
      fetch: async () => {
        connections++;
        if (connections === 2) reconnected.resolve();
        return new Response(new ReadableStream({ start(controller) {
          if (connections === 1) for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        } }));
      },
      delay: async ms => { delays.push(ms); },
    });
    await reconnected.promise;
    stop();
    expect(received).toEqual([{ type: "mailbox-changed", accountId: "a" }]);
    expect(delays[0]).toBe(1_000);
  });
});
