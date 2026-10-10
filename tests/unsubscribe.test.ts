import { describe, expect, test } from "bun:test";
import {
  mailtoUnsubscribe,
  postOneClickUnsubscribe,
  unsubscribeOptions,
  type UnsubscribeFetch,
} from "../src/server/mail/unsubscribe";
import { createApi } from "../src/server/api";
import { createTestHarness } from "./support/test-mail";

const lines = (...headers: string[]) => headers.map((line) => ({ key: line.slice(0, line.indexOf(":")).toLowerCase(), line }));

describe("unsubscribeOptions", () => {
  test("reads one-click, https and mailto targets from folded headers", () => {
    expect(unsubscribeOptions(lines(
      "List-Unsubscribe: <mailto:leave@example.test?subject=stop>,\r\n <https://example.test/u/1>",
      "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
    ))).toEqual({ https: "https://example.test/u/1", mailto: "mailto:leave@example.test?subject=stop", oneClick: true });
  });

  test("is not one-click without the post header", () => {
    expect(unsubscribeOptions(lines("List-Unsubscribe: <https://example.test/u>"))?.oneClick).toBe(false);
  });

  test("ignores http and other schemes", () => {
    expect(unsubscribeOptions(lines("List-Unsubscribe: <http://example.test/u>, <javascript:alert(1)>"))).toBeUndefined();
    expect(unsubscribeOptions(lines("Subject: hello"))).toBeUndefined();
  });
});

describe("postOneClickUnsubscribe", () => {
  function recording(status: number) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: UnsubscribeFetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status, headers: status === 302 ? { Location: "https://elsewhere.test/" } : {} });
    };
    return { calls, fetcher };
  }

  test("posts the RFC 8058 body without credentials or redirects", async () => {
    const { calls, fetcher } = recording(200);
    await postOneClickUnsubscribe(fetcher, "https://list.example.test/u?id=1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://list.example.test/u?id=1");
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      body: "List-Unsubscribe=One-Click",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  });

  test("refuses private, local and non-default-port targets without a request", async () => {
    const { calls, fetcher } = recording(200);
    for (const uri of [
      "https://127.0.0.1/u",
      "https://[::1]/u",
      "https://intranet/u",
      "https://mail.localhost/u",
      "https://example.test:8443/u",
      "https://user:pass@example.test/u",
      "http://example.test/u",
    ]) {
      await expect(postOneClickUnsubscribe(fetcher, uri)).rejects.toThrow("not a public HTTPS address");
    }
    expect(calls).toHaveLength(0);
  });

  test("treats a redirect or error status as failure", async () => {
    const redirect = recording(302);
    await expect(postOneClickUnsubscribe(redirect.fetcher, "https://example.test/u")).rejects.toThrow("HTTP 302");
    expect(redirect.calls).toHaveLength(1);
    await expect(postOneClickUnsubscribe(recording(500).fetcher, "https://example.test/u")).rejects.toThrow("HTTP 500");
  });
});

describe("mailtoUnsubscribe", () => {
  test("decodes subject and body", () => {
    expect(mailtoUnsubscribe("mailto:leave@example.test?subject=Remove%20me&body=bye+now"))
      .toEqual({ address: "leave@example.test", subject: "Remove me", body: "bye+now" });
  });

  test("defaults subject and body", () => {
    expect(mailtoUnsubscribe("mailto:leave@example.test")).toEqual({ address: "leave@example.test", subject: "unsubscribe", body: "unsubscribe" });
  });

  test("refuses a subject or body too long to confirm", () => {
    expect(() => mailtoUnsubscribe(`mailto:leave@example.test?body=${"x".repeat(501)}`)).toThrow("too long");
  });

  test("refuses several addresses", () => {
    expect(() => mailtoUnsubscribe("mailto:a@example.test,b@example.test")).toThrow("single valid address");
  });
});

describe("unsubscribe through the service", () => {
  const options = { https: "https://list.example.test/u", mailto: "mailto:leave@example.test?subject=stop", oneClick: false };

  test("refuses a method the message does not offer without contacting anything", async () => {
    const posts: string[] = [];
    const { service, store, messages, sent } = await createTestHarness({
      readOverrides: { unsubscribe: options },
      unsubscribeFetch: async (url) => { posts.push(url); return new Response(null, { status: 200 }); },
    });
    try {
      const response = await createApi(service).request("/api/messages/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: messages[0]!.ref, method: "one_click" }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "This message does not offer one-click unsubscribe" });
      expect(posts).toEqual([]);
      expect(sent).toEqual([]);
    } finally { store.close(); }
  });

  test("posts one-click to the message's own target", async () => {
    const posts: string[] = [];
    const { service, store, messages } = await createTestHarness({
      readOverrides: { unsubscribe: { ...options, oneClick: true } },
      unsubscribeFetch: async (url) => { posts.push(url); return new Response(null, { status: 204 }); },
    });
    try {
      expect(await service.unsubscribe({ message: messages[0]!.ref, method: "one_click" }))
        .toEqual({ method: "one_click", target: "https://list.example.test/u" });
      expect(posts).toEqual(["https://list.example.test/u"]);
    } finally { store.close(); }
  });

  test("sends a mailto unsubscribe from the identity the message was delivered to", async () => {
    const { service, store, account, messages, sent } = await createTestHarness({
      readOverrides: { unsubscribe: options, deliveredTo: ["lists@example.test"] },
    });
    try {
      await service.addIdentity(account.id, { name: "Lists", address: "lists@example.test" });
      const result = await service.unsubscribe({ message: messages[0]!.ref, method: "mailto" });
      expect(result).toMatchObject({ method: "mailto", target: "leave@example.test" });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        from: { name: "Lists", address: "lists@example.test" },
        to: [{ address: "leave@example.test" }],
        subject: "stop",
        text: "unsubscribe",
      });
    } finally { store.close(); }
  });
});
