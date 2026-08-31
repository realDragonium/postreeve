import { describe, expect, test } from "bun:test";
import { GmailMailClient, type HttpFetch } from "../src/server/mail/gmail";
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
      if (url.includes("/messages?") && method === "GET") return json({ messages: [{ id: "18fabc123" }] });
      if (url.includes("/messages/18fabc123?format=raw")) return json(message({ raw }));
      if (url.includes("/messages/18fabc123?format=metadata")) return json(message({
        payload: { headers: [
          { name: "Subject", value: "Gmail test" },
          { name: "From", value: "Sender <sender@example.test>" },
          { name: "To", value: "Person <person@example.test>" },
          { name: "Message-ID", value: "<gmail-test@example.test>" },
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
    const summaries = await client.listMessages(account.id, "INBOX", 20);
    expect(summaries[0]?.subject).toBe("Gmail test");
    expect(summaries[0]?.ref.providerId).toBe("18fabc123");
    const details = await client.readMessages(account.id, [summaries[0]!.ref]);
    expect(details[0]?.text.trim()).toBe("Hello from Gmail.");
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
        labelIds,
        snippet: "Hello from Gmail.",
        historyId: String(historyId),
        internalDate: "1787990400000",
        ...extra,
      };
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
