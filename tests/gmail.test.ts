import { describe, expect, test } from "bun:test";
import { GmailMailClient, type HttpFetch } from "../src/server/mail/gmail";
import { toCanonicalObservation } from "../src/server/mail/provider";
import { Store } from "../src/server/db/store";
import { GoogleOAuth, type OAuthFetch } from "../src/server/google/oauth";

const account = {
  id: "gmail-account",
  name: "Gmail",
  email: "person@example.test",
  kind: "gmail" as const,
};

describe("Gmail compatibility", () => {
  test("refreshes OAuth, lists Gmail labels and messages, reads source, applies actions, and sends", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    let historyId = 10;
    let labelIds = ["INBOX", "UNREAD"];
    const raw = Buffer.from([
      "From: Sender <sender@example.test>",
      "To: Person <person@example.test>",
      "Subject: Gmail test",
      "Message-ID: <gmail-test@example.test>",
      "Date: Sat, 29 Aug 2026 10:00:00 +0200",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="related"',
      "",
      "--related",
      'Content-Type: multipart/alternative; boundary="alternative"',
      "",
      "--alternative",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Hello from Gmail.",
      "--alternative",
      "Content-Type: text/html; charset=UTF-8",
      "",
      '<p>Hello from Gmail.</p><img src="cid:logo@example.test">',
      "--alternative--",
      "--related",
      'Content-Type: image/png; name="logo.png"',
      'Content-Disposition: inline; filename="logo.png"',
      "Content-ID: <logo@example.test>",
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgo=",
      "--related--",
      "",
    ].join("\r\n"), "utf8").toString("base64url");
    const request: HttpFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : init?.body?.toString() ?? "";
      requests.push({ url, method, body });
      if (url === "https://oauth2.googleapis.com/token") {
        expect(body).toContain("refresh_token=stored-refresh-token");
        expect(body).toContain("client_secret=desktop-client-secret");
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      if (url.endsWith("/profile")) return json({ emailAddress: account.email });
      if (url.endsWith("/labels")) return json({ labels: [
        { id: "INBOX", name: "INBOX", type: "system" },
        { id: "SENT", name: "SENT", type: "system" },
        { id: "Label_1", name: "Projects", type: "user" },
      ] });
      if (url.endsWith("/labels/INBOX")) return json({ id: "INBOX", name: "INBOX", type: "system", messagesTotal: 1, messagesUnread: 1 });
      if (url.endsWith("/labels/SENT")) return json({ id: "SENT", name: "SENT", type: "system", messagesTotal: 2, messagesUnread: 0 });
      if (url.endsWith("/labels/Label_1")) return json({ id: "Label_1", name: "Projects", type: "user", messagesTotal: 1, messagesUnread: 0 });
      if (url.includes("/messages?") && method === "GET") {
        return json({ messages: [{ id: "18fabc123" }], nextPageToken: "more-results" });
      }
      if (url.includes("/messages/18fabc123?format=raw")) return json(message({ raw }));
      if (url.includes("/messages/18fabc123?format=metadata")) return json(message({
        payload: { headers: [
          { name: "Subject", value: "Gmail test" },
          { name: "From", value: "Sender <sender@example.test>" },
          { name: "To", value: "Person <person@example.test>" },
          { name: "Message-ID", value: "<gmail-test@example.test>" },
          { name: "In-Reply-To", value: "Your messages <parent-a@example.test> and <parent-b@example.test>" },
          { name: "References", value: "First <root@example.test> then <parent@example.test>" },
          { name: "Date", value: "Sat, 29 Aug 2026 10:00:00 +0200" },
        ] },
      }));
      if (url.includes("/messages/18fabc123?format=minimal")) return json(message());
      if (url.endsWith("/messages/18fabc123/modify")) {
        const parsed = JSON.parse(body) as { addLabelIds: string[]; removeLabelIds: string[] };
        labelIds = [...new Set([...labelIds.filter((label) => !parsed.removeLabelIds.includes(label)), ...parsed.addLabelIds])];
        historyId += 1;
        return json(message());
      }
      if (url.endsWith("/messages/send")) return json({ id: "sent-1", threadId: "thread-1" });
      return new Response(null, { status: 404 });
    };
    const client = new GmailMailClient({
      account,
      credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
      clientId: "desktop-client-id",
      clientSecret: "desktop-client-secret",
      fetch: request,
    });

    await client.verifyConnection();
    const folders = await client.listFolders(account.id);
    expect(folders.map(({ name }) => name)).toEqual(["Inbox", "Archive", "Sent", "Projects"]);
    const page = await client.listMessagePage(account.id, "INBOX", 20);
    const summaries = page.messages;
    expect(page.complete).toBe(false);
    expect(summaries[0]?.subject).toBe("Gmail test");
    expect(summaries[0]?.ref.providerId).toBe("18fabc123");
    expect(summaries[0]?.providerConversationId).toBe("thread-1");
    expect(summaries[0]?.inReplyTo).toBe("Your messages <parent-a@example.test> and <parent-b@example.test>");
    expect(summaries[0]?.references).toEqual(["<root@example.test>", "<parent@example.test>"]);
    expect(toCanonicalObservation("tenant-a", "gmail", summaries[0]!).inReplyTo)
      .toBe("<parent-a@example.test> <parent-b@example.test>");
    const details = await client.readMessages(account.id, [summaries[0]!.ref]);
    expect(details[0]?.text.trim()).toBe("Hello from Gmail.");
    expect(details[0]?.providerConversationId).toBe("thread-1");
    expect(details[0]?.html).toContain("data:image/png;base64,");
    const applied = await client.apply(summaries[0]!.ref, { type: "mark_read" });
    expect(applied.previousRead).toBe(false);
    expect(labelIds).not.toContain("UNREAD");
    await client.undo(applied);
    expect(labelIds).toContain("UNREAD");
    const receipt = await client.send({
      accountId: account.id,
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Sent through Gmail",
      text: "Test body",
    });
    expect(receipt.id).toBe("sent-1");
    expect(requests.filter(({ url }) => url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
    expect(requests.find(({ url }) => url.endsWith("/messages/send"))?.body).not.toContain("Test body");

    function message(extra: Record<string, unknown> = {}) {
      return {
        id: "18fabc123",
        threadId: "thread-1",
        labelIds,
        snippet: "Hello from Gmail.",
        historyId: String(historyId),
        internalDate: "1787990400000",
        ...extra,
      };
    }
  });

  test("retains ordered References from a raw Gmail message", async () => {
    const raw = Buffer.from([
      "From: Sender <sender@example.test>",
      "To: Person <person@example.test>",
      "Subject: Threaded Gmail message",
      "Message-ID: <threaded@example.test>",
      "In-Reply-To: Your messages of Friday <parent-a@example.test> and Saturday <parent-b@example.test>",
      'References: "quoted <fake@example.test>" <root@example.test> then <"a>b<c"@Example.Test> <root@example.test>',
      "Date: Sat, 29 Aug 2026 10:00:00 +0200",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Threaded body.",
    ].join("\r\n"), "utf8").toString("base64url");
    const request: HttpFetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      if (url.includes("/messages/threaded?format=raw")) {
        return json({
          id: "threaded",
          labelIds: ["INBOX"],
          historyId: "1",
          internalDate: "1787990400000",
          raw,
        });
      }
      return new Response(null, { status: 404 });
    };
    const client = new GmailMailClient({
      account,
      credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
      clientId: "desktop-client-id",
      fetch: request,
    });

    const [detail] = await client.readMessages(account.id, [{
      accountId: account.id,
      mailbox: "INBOX",
      uidValidity: "gmail",
      uid: 1,
      modseq: "1",
      providerId: "threaded",
    }]);

    if (!detail) throw new Error("Expected a Gmail message detail");
    expect(toCanonicalObservation("tenant-a", "gmail", detail).inReplyTo)
      .toBe("<parent-a@example.test> <parent-b@example.test>");
    expect(detail?.references).toEqual(["<root@example.test>", '<"a>b<c"@example.test>']);
    expect(detail?.providerConversationId).toBeUndefined();
  });

  test("keeps missing and malformed Gmail dates out of canonical ordering", async () => {
    const request: HttpFetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "access", expires_in: 3600 });
      }
      if (url.includes("/messages?")) return json({ messages: [{ id: "missing" }, { id: "malformed" }, { id: "epoch" }] });
      const id = /\/messages\/([^?]+)/.exec(url)?.[1];
      if (id) return json({
        id,
        labelIds: ["INBOX"],
        snippet: id,
        ...(id === "malformed" ? { internalDate: "not-a-time", payload: { headers: [{ name: "Date", value: "not-a-date" }] } } : {}),
        ...(id === "epoch" ? { internalDate: "0" } : {}),
      });
      return new Response(null, { status: 404 });
    };
    const client = new GmailMailClient({
      account,
      credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
      clientId: "desktop-client-id",
      fetch: request,
    });

    const messages = await client.listMessages(account.id, "INBOX", 3);
    const canonicalTimes = messages.map((message) =>
      toCanonicalObservation("tenant-a", "gmail", message).receivedAt);
    expect(messages.map(({ receivedAt }) => receivedAt)).toEqual([
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
    ]);
    expect(canonicalTimes).toEqual([null, null, "1970-01-01T00:00:00.000Z"]);

    const store = new Store(":memory:");
    try {
      await store.insertAccount({ ...account, encryptedCredentials: null });
      const stored = await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: account.id, provider: "gmail", mailbox: "INBOX", authoritative: false,
        observations: messages.map((message) => toCanonicalObservation("tenant-a", "gmail", message)),
      });
      expect(stored.map(({ receivedAt }) => receivedAt)).toEqual([null, null, "1970-01-01T00:00:00.000Z"]);
    } finally {
      store.close();
    }
  });

  test("uses a state-bound PKCE desktop authorization flow", async () => {
    const request: OAuthFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        const body = init?.body?.toString() ?? "";
        expect(body).toContain("code_verifier=");
        expect(body).toContain("client_secret=desktop-client-secret");
        return json({ access_token: "access", refresh_token: "refresh" });
      }
      return json({ emailAddress: "person@example.test" });
    };
    const oauth = new GoogleOAuth(
      "desktop-client-id",
      "http://127.0.0.1:3000/api/oauth/google/callback",
      request,
      "desktop-client-secret",
    );
    const authorizationUrl = new URL(oauth.start());
    expect(authorizationUrl.searchParams.get("scope")).toContain("gmail.modify");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorizationUrl.searchParams.get("state");
    const result = await oauth.complete(`http://127.0.0.1:3000/api/oauth/google/callback?code=test-code&state=${state}`);
    expect(result).toEqual({ email: "person@example.test", refreshToken: "refresh" });
    expect(oauth.complete(`http://127.0.0.1:3000/api/oauth/google/callback?code=replay&state=${state}`))
      .rejects.toThrow("missing or expired");
  });

  test("creates, renames, and deletes user labels while protecting Gmail system labels", async () => {
    const requests: Array<{ path: string; method: string; body: string }> = [];
    let userLabel = { id: "Label_1", name: "Projects", type: "user" as const };
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.href === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      requests.push({ path: url.pathname, method, body });
      if (url.pathname.endsWith("/labels") && method === "POST") {
        const inputBody = JSON.parse(body) as { name: string };
        userLabel = { id: "Label_2", name: inputBody.name, type: "user" };
        return json(userLabel);
      }
      if (url.pathname.endsWith(`/labels/${userLabel.id}`) && method === "GET") return json(userLabel);
      if (url.pathname.endsWith(`/labels/${userLabel.id}`) && method === "PATCH") {
        const inputBody = JSON.parse(body) as { name: string };
        userLabel = { ...userLabel, name: inputBody.name };
        return json(userLabel);
      }
      if (url.pathname.endsWith(`/labels/${userLabel.id}`) && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/labels/INBOX")) {
        return json({ id: "INBOX", name: "INBOX", type: "system" });
      }
      return new Response(null, { status: 404 });
    };
    const client = new GmailMailClient({
      account,
      credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
      clientId: "desktop-client-id",
      fetch: request,
    });

    await client.createFolder(account.id, "Receipts");
    await client.renameFolder(account.id, "Label_2", "Keep");
    await expect(client.deleteFolder(account.id, "INBOX"))
      .rejects.toThrow("System Gmail labels cannot be changed");
    await client.deleteFolder(account.id, "Label_2");

    expect(requests.filter(({ method }) => method === "POST")[0]?.body).toContain('"name":"Receipts"');
    expect(requests.some(({ method, body }) => method === "PATCH" && body.includes('"name":"Keep"'))).toBe(true);
    expect(requests.some(({ method }) => method === "DELETE")).toBe(true);
  });
});

function json(value: unknown): Response {
  return Response.json(value);
}
