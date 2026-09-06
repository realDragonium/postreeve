import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { GmailMailClient, type HttpFetch } from "../src/server/mail/gmail";
import {
  MailProviderRegistry,
  toCanonicalObservation,
  type ProviderMessageObservation,
} from "../src/server/mail/provider";
import { MailSendPreDispatchError, MailSenderRegistry } from "../src/server/mail/sender";
import { Store } from "../src/server/db/store";
import { GoogleOAuth, type OAuthFetch } from "../src/server/google/oauth";
import { PostreeveService } from "../src/server/core/postreeve";
import { CredentialVault } from "../src/server/security/credentials";
import { createApi } from "../src/server/api";
import { canonicalConversationSchema } from "../src/shared/contracts";
import { repeatedIdentification } from "./fixtures/repeated-identification";

const account = {
  id: "gmail-account",
  name: "Gmail",
  email: "person@example.test",
  kind: "gmail" as const,
};

async function createConversationService(request: HttpFetch) {
  const client = new GmailMailClient({
    account,
    credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
    clientId: "desktop-client-id",
    fetch: request,
  });
  const providers = new MailProviderRegistry();
  const senders = new MailSenderRegistry();
  const store = new Store(":memory:");
  await store.insertAccount({ ...account, encryptedCredentials: null });
  providers.register(account.id, client);
  senders.register(account.id, client);
  const unavailable = () => { throw new Error("Factory is not used by this fixture"); };
  const service = new PostreeveService(
    store,
    { tenantId: "tenant-a" },
    providers,
    senders,
    new CredentialVault(Buffer.alloc(32, 7).toString("base64")),
    unavailable,
    unavailable,
  );
  return { store, service };
}

function gmailObservation(
  providerId: string,
  providerConversationId: string,
  mailbox = "INBOX",
): ProviderMessageObservation {
  return {
    tenantId: "tenant-a",
    messageId: "<gmail-conversation-source@example.test>",
    inReplyTo: null,
    references: [],
    providerConversationId,
    receivedAt: "2026-08-29T08:00:00.000Z",
    location: {
      accountId: account.id,
      provider: "gmail",
      mailbox,
      uidValidity: "gmail",
      uid: providerId === "source-a" ? 1 : 2,
      modseq: "1",
      providerId,
      read: true,
      flagged: false,
    },
  };
}

function rawSource(subject: string): string {
  return Buffer.from([
    "From: Sender <sender@example.test>",
    "To: Person <person@example.test>",
    `Subject: ${subject}`,
    "Message-ID: <gmail-conversation-source@example.test>",
    "Date: Sat, 29 Aug 2026 10:00:00 +0200",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Source body.",
  ].join("\r\n"), "utf8").toString("base64url");
}

function rawThreadingSource(input: {
  subject: string;
  messageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
}): string {
  return Buffer.from([
    "From: Sender <sender@example.test>",
    "To: Person <person@example.test>",
    `Subject: ${input.subject}`,
    ...(input.messageId ? [`Message-ID: ${input.messageId}`] : []),
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references?.length ? [`References: ${input.references.join(" ")}`] : []),
    "Date: Sat, 29 Aug 2026 10:00:00 +0200",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "Source body.",
  ].join("\r\n"), "utf8").toString("base64url");
}

describe("Gmail compatibility", () => {
  test("classifies token acquisition failure as proven pre-dispatch", async () => {
    const requests: string[] = [];
    const { store, service } = await createConversationService(async (input) => {
      requests.push(String(input));
      return Response.json({ error: "invalid_grant", error_description: "" }, { status: 401 });
    });
    const healthy = await service.createDraft({
      accountId: account.id,
      mode: "new",
      to: [],
      cc: [],
      bcc: [],
      subject: "Healthy sibling",
      body: "",
      identity: { name: account.name, address: account.email },
    });
    const failedDraft = await service.createDraft({
      accountId: account.id,
      mode: "new",
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Pre-dispatch",
      body: "No provider submission should occur.",
      identity: { name: account.name, address: account.email },
    });

    const error = await service.sendDraft(account.id, failedDraft.id, { version: failedDraft.version })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MailSendPreDispatchError);
    expect(error).toHaveProperty("message", "invalid_grant");
    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(requests.every((url) => url === "https://oauth2.googleapis.com/token")).toBe(true);
    const failed = await service.getDraft(account.id, failedDraft.id);
    expect(failed.delivery).toMatchObject({ status: "failed", error: "invalid_grant" });
    expect((await service.listDrafts(account.id)).map(({ id }) => id).sort())
      .toEqual([healthy.id, failed.id].sort());
    store.close();
  });

  test("refreshes OAuth, lists Gmail labels and messages, reads source, applies actions, and sends", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    let historyId = 10;
    let labelIds = ["INBOX", "UNREAD"];
    const raw = Buffer.from([
      "From: Sender <sender@example.test>",
      "Reply-To: Planning replies <planning-replies@example.test>",
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
          { name: "Reply-To", value: "Planning replies <planning-replies@example.test>" },
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
    expect(summaries[0]?.replyTo).toEqual([{ name: "Planning replies", address: "planning-replies@example.test" }]);
    expect(summaries[0]?.ref.providerId).toBe("18fabc123");
    expect(summaries[0]?.providerConversationId).toBe("thread-1");
    expect(summaries[0]?.inReplyTo).toBe("Your messages <parent-a@example.test> and <parent-b@example.test>");
    expect(summaries[0]?.references).toEqual(["<root@example.test>", "<parent@example.test>"]);
    expect(toCanonicalObservation("tenant-a", "gmail", summaries[0]!).inReplyTo)
      .toBe("<parent-a@example.test> <parent-b@example.test>");
    const details = await client.readMessages(account.id, [summaries[0]!.ref]);
    expect(details[0]?.text.trim()).toBe("Hello from Gmail.");
    expect(details[0]?.replyTo).toEqual([{ name: "Planning replies", address: "planning-replies@example.test" }]);
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
      subject: "Re: Sent through Gmail",
      text: "Test body",
      intent: {
        type: "reply",
        source: { canonicalMessageId: "canonical-source", conversationId: "canonical-thread" },
      },
    }, {
      type: "reply",
      sourceMessageId: "canonical-source",
      conversationId: "canonical-thread",
      sourceSubject: "Sent through Gmail",
      inReplyTo: "<gmail-test@example.test>",
      references: ["<root@example.test>", "<gmail-test@example.test>"],
      providerConversationId: "thread-1",
    });
    expect(receipt.id).toBe("sent-1");
    expect(receipt.providerConversationId).toBe("thread-1");
    expect(requests.filter(({ url }) => url === "https://oauth2.googleapis.com/token")).toHaveLength(1);
    const sendBody = requests.find(({ url }) => url.endsWith("/messages/send"))?.body ?? "";
    expect(sendBody).not.toContain("Test body");
    const sendRequest = JSON.parse(sendBody) as { raw: string; threadId?: string };
    const sentRaw = Buffer.from(sendRequest.raw, "base64url").toString("utf8");
    expect(sendRequest.threadId).toBe("thread-1");
    expect(sentRaw).toContain("In-Reply-To: <gmail-test@example.test>\r\n");
    expect(sentRaw).toContain("References: <root@example.test> <gmail-test@example.test>\r\n");

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

  test("returns Gmail's authoritative thread when it differs from the requested thread", async () => {
    const request: HttpFetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      if (url.endsWith("/messages/send")) {
        return json({ id: "sent-divergent", threadId: "returned-thread" });
      }
      return new Response(null, { status: 404 });
    };
    const client = new GmailMailClient({
      account,
      credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
      clientId: "desktop-client-id",
      fetch: request,
    });

    const receipt = await client.send({
      accountId: account.id,
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Re: Original subject",
      text: "Reply body.",
      intent: { type: "reply", source: { canonicalMessageId: "source", conversationId: "conversation" } },
    }, {
      type: "reply",
      sourceMessageId: "source",
      conversationId: "conversation",
      sourceSubject: "Original subject",
      inReplyTo: "<source@example.test>",
      references: ["<source@example.test>"],
      providerConversationId: "requested-thread",
    });

    expect(receipt.providerConversationId).toBe("returned-thread");
  });

  test("folds long Unicode and References headers while retaining Bcc delivery", async () => {
    let requestBody = "";
    const request: HttpFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      if (url.endsWith("/messages/send")) {
        requestBody = typeof init?.body === "string" ? init.body : "";
        return json({ id: "sent-long", threadId: "thread-long" });
      }
      return new Response(null, { status: 404 });
    };
    const client = new GmailMailClient({
      account,
      credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
      clientId: "desktop-client-id",
      fetch: request,
    });
    const subject = `Re: Résumé ${"世界".repeat(80)}`;
    const references = Array.from({ length: 100 }, (_, index) => `<ancestor-${index}@example.test>`);

    await client.send({
      accountId: account.id,
      to: [{ name: "名".repeat(80), address: "recipient@example.test" }],
      cc: [],
      bcc: [{ name: "Hidden", address: "hidden@example.test" }],
      subject,
      text: "Long-header body.",
      intent: { type: "reply", source: { canonicalMessageId: "source", conversationId: "conversation" } },
    }, {
      type: "reply",
      sourceMessageId: "source",
      conversationId: "conversation",
      sourceSubject: subject,
      inReplyTo: "<source@example.test>",
      references,
      providerConversationId: "thread-long",
    });

    const sent = JSON.parse(requestBody) as { raw: string; threadId?: string };
    const raw = Buffer.from(sent.raw, "base64url").toString("utf8");
    expect(Math.max(...raw.split("\r\n").map((line) => Buffer.byteLength(line)))).toBeLessThanOrEqual(998);
    expect([...raw.matchAll(/=\?UTF-8\?[BQ]\?[^?]+\?=/gi)].every(([word]) => word.length <= 75)).toBe(true);
    expect(raw).toContain("Bcc: Hidden <hidden@example.test>");
    expect((await simpleParser(raw)).subject).toBe(subject);
    expect(sent.threadId).toBe("thread-long");
  });

  test("omits RFC reply headers and Gmail threadId for a fallback source", async () => {
    let requestBody = "";
    const request: HttpFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      if (url.endsWith("/messages/send")) {
        requestBody = typeof init?.body === "string" ? init.body : "";
        return json({ id: "sent-fallback", threadId: "new-thread" });
      }
      return new Response(null, { status: 404 });
    };
    const client = new GmailMailClient({
      account,
      credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
      clientId: "desktop-client-id",
      fetch: request,
    });

    await client.send({
      accountId: account.id,
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "Re: Fallback source",
      text: "Fallback reply body.",
      intent: { type: "reply", source: { canonicalMessageId: "fallback", conversationId: "conversation" } },
    }, {
      type: "reply",
      sourceMessageId: "fallback",
      conversationId: "conversation",
      sourceSubject: "Fallback source",
      references: [],
      providerConversationId: "source-thread",
    });

    const sent = JSON.parse(requestBody) as { raw: string; threadId?: string };
    const raw = Buffer.from(sent.raw, "base64url").toString("utf8");
    expect(sent).not.toHaveProperty("threadId");
    expect(raw).not.toContain("In-Reply-To:");
    expect(raw).not.toContain("References:");
  });

  test("keeps reply headers but omits Gmail threadId when the reply subject is edited", async () => {
    let requestBody = "";
    const request: HttpFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      if (url.endsWith("/messages/send")) {
        requestBody = typeof init?.body === "string" ? init.body : "";
        return json({ id: "sent-edited", threadId: "new-thread" });
      }
      return new Response(null, { status: 404 });
    };
    const client = new GmailMailClient({
      account,
      credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
      clientId: "desktop-client-id",
      fetch: request,
    });

    await client.send({
      accountId: account.id,
      to: [{ name: "Recipient", address: "recipient@example.test" }],
      cc: [],
      bcc: [],
      subject: "A deliberate new subject",
      text: "Reply body.",
      intent: { type: "reply", source: { canonicalMessageId: "source", conversationId: "conversation" } },
    }, {
      type: "reply",
      sourceMessageId: "source",
      conversationId: "conversation",
      sourceSubject: "Original subject",
      inReplyTo: "<source@example.test>",
      references: ["<root@example.test>", "<source@example.test>"],
      providerConversationId: "source-thread",
    });

    const sent = JSON.parse(requestBody) as { raw: string; threadId?: string };
    const raw = Buffer.from(sent.raw, "base64url").toString("utf8");
    expect(sent).not.toHaveProperty("threadId");
    expect(raw).toContain("Subject: A deliberate new subject\r\n");
    expect(raw).toContain("In-Reply-To: <source@example.test>\r\n");
    expect(raw).toContain("References: <root@example.test> <source@example.test>\r\n");
  });

  test("sends a Gmail reply without a forced thread when every source read fails", async () => {
    let requestBody = "";
    let sourceReads = 0;
    const request: HttpFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      if (url.includes("/messages/unreadable?format=raw")) {
        sourceReads += 1;
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/messages/send")) {
        requestBody = typeof init?.body === "string" ? init.body : "";
        return json({ id: "sent-without-source-read", threadId: "gmail-selected-thread" });
      }
      return new Response(null, { status: 404 });
    };
    const { store, service } = await createConversationService(request);
    try {
      const [source] = await store.reconcileMailbox({
        tenantId: "tenant-a",
        accountId: account.id,
        provider: "gmail",
        mailbox: "INBOX",
        observations: [gmailObservation("unreadable", "stale-source-thread")],
        authoritative: true,
      });
      if (!source) throw new Error("Expected a canonical Gmail source");

      const receipt = await service.sendMessage({
        accountId: account.id,
        to: [{ name: "Sender", address: "sender@example.test" }],
        cc: [],
        bcc: [],
        subject: "Re: Gmail source",
        text: "Reply despite stale Gmail source locations.",
        intent: {
          type: "reply",
          source: { canonicalMessageId: source.id, conversationId: source.conversationId },
        },
      });

      const sent = JSON.parse(requestBody) as { raw: string; threadId?: string };
      const raw = Buffer.from(sent.raw, "base64url").toString("utf8");
      expect(sourceReads).toBe(1);
      expect(sent).not.toHaveProperty("threadId");
      expect(raw).toContain("In-Reply-To: <gmail-conversation-source@example.test>\r\n");
      expect(raw).toContain("References: <gmail-conversation-source@example.test>\r\n");
      expect(receipt).toMatchObject({ id: "sent-without-source-read", providerConversationId: "gmail-selected-thread" });
    } finally {
      store.close();
    }
  });

  test("validates a Gmail reply subject against the selected provider thread", async () => {
    const sourceReads: string[] = [];
    let requestBody = "";
    const request: HttpFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      const sourceId = /\/messages\/(source-[ab])\?format=raw/.exec(url)?.[1];
      if (sourceId) {
        sourceReads.push(sourceId);
        const selected = sourceId === "source-b";
        return json({
          id: sourceId,
          threadId: selected ? "thread-b" : "thread-a",
          labelIds: [selected ? "INBOX" : "ARCHIVE"],
          historyId: "1",
          internalDate: "1787990400000",
          raw: rawSource(selected ? "Selected subject" : "Other subject"),
        });
      }
      if (url.endsWith("/messages/send")) {
        requestBody = typeof init?.body === "string" ? init.body : "";
        return json({ id: "sent-selected-thread", threadId: "thread-b" });
      }
      return new Response(null, { status: 404 });
    };
    const { store, service } = await createConversationService(request);
    try {
      const [archiveSource] = await store.reconcileMailbox({
        tenantId: "tenant-a",
        accountId: account.id,
        provider: "gmail",
        mailbox: "Archive",
        observations: [gmailObservation("source-a", "thread-a", "Archive")],
        authoritative: true,
      });
      const [source] = await store.reconcileMailbox({
        tenantId: "tenant-a",
        accountId: account.id,
        provider: "gmail",
        mailbox: "INBOX",
        observations: [gmailObservation("source-b", "thread-b")],
        authoritative: true,
      });
      if (!archiveSource || !source) throw new Error("Expected canonical Gmail sources");
      expect(source.id).toBe(archiveSource.id);

      await service.sendMessage({
        accountId: account.id,
        to: [{ name: "Sender", address: "sender@example.test" }],
        cc: [],
        bcc: [],
        subject: "Re: Selected subject",
        text: "Reply in the explicitly selected Gmail thread.",
        intent: {
          type: "reply",
          source: {
            canonicalMessageId: source.id,
            conversationId: source.conversationId,
            providerConversationId: "thread-b",
          },
        },
      });

      const sent = JSON.parse(requestBody) as { raw: string; threadId?: string };
      expect(sourceReads).toEqual(["source-a", "source-b"]);
      expect(sent.threadId).toBe("thread-b");
    } finally {
      store.close();
    }
  });

  test("uses explicit selected-copy References while retaining canonical ancestry when fields are omitted", async () => {
    const canonicalReferences = ["<a@example.test>", "<b@example.test>"];
    const sourceMessageId = "<selected-ancestry@example.test>";
    const scenarios = [
      {
        name: "explicit References",
        selectedMessageId: sourceMessageId,
        selectedReferences: ["<b@example.test>", "<a@example.test>"],
        expectedReferences: ["<b@example.test>", "<a@example.test>", sourceMessageId],
      },
      {
        name: "omitted References",
        selectedMessageId: sourceMessageId,
        selectedReferences: [],
        expectedReferences: [...canonicalReferences, sourceMessageId],
      },
      {
        name: "omitted Message-ID and References",
        selectedMessageId: undefined,
        selectedReferences: [],
        expectedReferences: [...canonicalReferences, sourceMessageId],
      },
    ] as const;

    for (const scenario of scenarios) {
      let requestBody = "";
      const request: HttpFetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://oauth2.googleapis.com/token") {
          return json({ access_token: "short-lived-access-token", expires_in: 3600 });
        }
        const sourceId = /\/messages\/(copy-[ab])\?format=raw/.exec(url)?.[1];
        if (sourceId) {
          const selected = sourceId === "copy-b";
          const references = selected ? scenario.selectedReferences : canonicalReferences;
          return json({
            id: sourceId,
            threadId: selected ? "thread-b" : "thread-a",
            labelIds: [selected ? "INBOX" : "ARCHIVE"],
            raw: rawThreadingSource({
              subject: "Selected ancestry",
              ...(selected
                ? scenario.selectedMessageId ? { messageId: scenario.selectedMessageId } : {}
                : { messageId: sourceMessageId }),
              ...(references.length > 0
                ? { references, inReplyTo: references[references.length - 1] }
                : {}),
            }),
          });
        }
        if (url.endsWith("/messages/send")) {
          requestBody = typeof init?.body === "string" ? init.body : "";
          return json({ id: `sent-${scenario.name}`, threadId: "thread-b" });
        }
        return new Response(null, { status: 404 });
      };
      const { store, service } = await createConversationService(request);
      try {
        const observation = (
          providerId: string,
          providerConversationId: string,
          mailbox: string,
          references: readonly string[],
        ): ProviderMessageObservation => ({
          ...gmailObservation(providerId, providerConversationId, mailbox),
          messageId: sourceMessageId,
          inReplyTo: references[references.length - 1] ?? null,
          references: [...references],
        });
        await store.reconcileMailbox({
          tenantId: "tenant-a",
          accountId: account.id,
          provider: "gmail",
          mailbox: "Archive",
          observations: [observation("copy-a", "thread-a", "Archive", canonicalReferences)],
          authoritative: true,
        });
        const [source] = await store.reconcileMailbox({
          tenantId: "tenant-a",
          accountId: account.id,
          provider: "gmail",
          mailbox: "INBOX",
          observations: [observation("copy-b", "thread-b", "INBOX", scenario.selectedReferences)],
          authoritative: true,
        });
        if (!source) throw new Error(`Expected a source for ${scenario.name}`);

        await service.sendMessage({
          accountId: account.id,
          to: [{ name: "Sender", address: "sender@example.test" }],
          cc: [],
          bcc: [],
          subject: "Re: Selected ancestry",
          text: `Reply with ${scenario.name}.`,
          intent: {
            type: "reply",
            source: {
              canonicalMessageId: source.id,
              conversationId: source.conversationId,
              providerConversationId: "thread-b",
            },
          },
        });

        const sent = z.object({ raw: z.string(), threadId: z.string().optional() }).parse(JSON.parse(requestBody));
        const parsed = await simpleParser(Buffer.from(sent.raw, "base64url"));
        expect(sent.threadId).toBe("thread-b");
        expect(parsed.inReplyTo).toBe(sourceMessageId);
        expect(parsed.references).toEqual([...scenario.expectedReferences]);
        expect((await store.getMessage("tenant-a", source.id))?.references).toEqual(canonicalReferences);
      } finally {
        store.close();
      }
    }
  });

  test("does not force a selected Gmail thread or adopt its ancestry when its Message-ID conflicts", async () => {
    let requestBody = "";
    const canonicalReferences = ["<root-a@example.test>", "<root-b@example.test>"];
    const request: HttpFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      if (url.includes("/messages/conflicting-copy?format=raw")) {
        return json({
          id: "conflicting-copy",
          threadId: "selected-thread",
          labelIds: ["INBOX"],
          raw: rawThreadingSource({
            subject: "Canonical source",
            messageId: "<different@example.test>",
            inReplyTo: "<different-root@example.test>",
            references: ["<different-root@example.test>"],
          }),
        });
      }
      if (url.endsWith("/messages/send")) {
        requestBody = typeof init?.body === "string" ? init.body : "";
        return json({ id: "sent-conflict", threadId: "returned-thread" });
      }
      return new Response(null, { status: 404 });
    };
    const { store, service } = await createConversationService(request);
    try {
      const [source] = await store.reconcileMailbox({
        tenantId: "tenant-a",
        accountId: account.id,
        provider: "gmail",
        mailbox: "INBOX",
        observations: [{
          ...gmailObservation("conflicting-copy", "selected-thread"),
          messageId: "<canonical-source@example.test>",
          inReplyTo: canonicalReferences[canonicalReferences.length - 1] ?? null,
          references: canonicalReferences,
        }],
        authoritative: true,
      });
      if (!source) throw new Error("Expected a canonical conflict source");

      await service.sendMessage({
        accountId: account.id,
        to: [{ name: "Sender", address: "sender@example.test" }],
        cc: [],
        bcc: [],
        subject: "Re: Canonical source",
        text: "Reply without forcing the conflicting provider thread.",
        intent: {
          type: "reply",
          source: {
            canonicalMessageId: source.id,
            conversationId: source.conversationId,
            providerConversationId: "selected-thread",
          },
        },
      });

      const sent = z.object({ raw: z.string(), threadId: z.string().optional() }).parse(JSON.parse(requestBody));
      const parsed = await simpleParser(Buffer.from(sent.raw, "base64url"));
      expect(sent).not.toHaveProperty("threadId");
      expect(parsed.inReplyTo).toBe("<canonical-source@example.test>");
      expect(parsed.references).toEqual([...canonicalReferences, "<canonical-source@example.test>"]);
      expect((await store.getMessage("tenant-a", source.id))?.references).toEqual(canonicalReferences);
    } finally {
      store.close();
    }
  });

  test("uses a valid selected-copy Message-ID when canonical identity has none", async () => {
    let requestBody = "";
    const request: HttpFetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        return json({ access_token: "short-lived-access-token", expires_in: 3600 });
      }
      if (url.includes("/messages/fallback-copy?format=raw")) {
        return json({
          id: "fallback-copy",
          threadId: "selected-thread",
          labelIds: ["INBOX"],
          raw: rawThreadingSource({
            subject: "Fallback source",
            messageId: "<read-source@example.test>",
            inReplyTo: "<read-root@example.test>",
          }),
        });
      }
      if (url.endsWith("/messages/send")) {
        requestBody = typeof init?.body === "string" ? init.body : "";
        return json({ id: "sent-fallback-copy", threadId: "selected-thread" });
      }
      return new Response(null, { status: 404 });
    };
    const { store, service } = await createConversationService(request);
    try {
      const [source] = await store.reconcileMailbox({
        tenantId: "tenant-a",
        accountId: account.id,
        provider: "gmail",
        mailbox: "INBOX",
        observations: [{
          ...gmailObservation("fallback-copy", "selected-thread"),
          messageId: null,
          inReplyTo: null,
          references: [],
        }],
        authoritative: true,
      });
      if (!source) throw new Error("Expected a fallback source");

      await service.sendMessage({
        accountId: account.id,
        to: [{ name: "Sender", address: "sender@example.test" }],
        cc: [],
        bcc: [],
        subject: "Re: Fallback source",
        text: "Reply using the selected source identity.",
        intent: {
          type: "reply",
          source: {
            canonicalMessageId: source.id,
            conversationId: source.conversationId,
            providerConversationId: "selected-thread",
          },
        },
      });

      const sent = z.object({ raw: z.string(), threadId: z.string().optional() }).parse(JSON.parse(requestBody));
      const parsed = await simpleParser(Buffer.from(sent.raw, "base64url"));
      expect(sent.threadId).toBe("selected-thread");
      expect(parsed.inReplyTo).toBe("<read-source@example.test>");
      expect(parsed.references).toEqual(["<read-root@example.test>", "<read-source@example.test>"]);
      expect((await store.getMessage("tenant-a", source.id))?.messageId).toBeNull();
    } finally {
      store.close();
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

  test("keeps repeated identification fields stable from metadata through raw read and the conversation API", async () => {
    const metadataHeaders = [
      { name: "Subject", value: "Repeated identification fields" },
      { name: "From", value: "Sender <sender@example.test>" },
      { name: "To", value: "Person <person@example.test>" },
      { name: "Message-ID", value: repeatedIdentification.messageId },
      ...repeatedIdentification.inReplyTo.map((value) => ({ name: "In-Reply-To", value })),
      ...repeatedIdentification.references.map((value) => ({ name: "References", value })),
      { name: "Date", value: "Sat, 29 Aug 2026 10:00:00 +0200" },
    ];
    const request: HttpFetch = async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "access", expires_in: 3600 });
      if (url.includes("/messages?") && !url.includes("/messages/repeated")) {
        return json({ messages: [{ id: "repeated" }] });
      }
      if (url.includes("/messages/repeated?format=metadata")) {
        return json({
          id: "repeated", threadId: "thread-repeated", labelIds: ["INBOX"], snippet: "Repeated body.",
          historyId: "1", internalDate: "1787990400000", payload: { headers: metadataHeaders },
        });
      }
      if (url.includes("/messages/repeated?format=raw")) {
        return json({
          id: "repeated", threadId: "thread-repeated", labelIds: ["INBOX"], historyId: "1",
          internalDate: "1787990400000", raw: Buffer.from(repeatedIdentification.raw).toString("base64url"),
        });
      }
      return new Response(null, { status: 404 });
    };
    const provider = new GmailMailClient({
      account,
      credentials: { kind: "gmail", refreshToken: "stored-refresh-token" },
      clientId: "desktop-client-id",
      fetch: request,
    });
    const [summary] = await provider.listMessages(account.id, "INBOX", 1);
    if (!summary) throw new Error("Expected Gmail metadata summary");
    const [detail] = await provider.readMessages(account.id, [summary.ref]);
    if (!detail) throw new Error("Expected Gmail raw detail");
    const listedObservation = toCanonicalObservation("tenant-a", "gmail", summary);
    const readObservation = toCanonicalObservation("tenant-a", "gmail", detail);
    expect(summary.referenceSequences).toEqual([
      ["<branch-a@example.test>", "<root@example.test>"],
      ["<branch-b@example.test>", "<root@example.test>"],
    ]);
    expect(detail.referenceSequences).toEqual(summary.referenceSequences);
    expect(listedObservation).toMatchObject({
      messageId: repeatedIdentification.normalizedMessageId,
      inReplyTo: repeatedIdentification.normalizedInReplyTo,
      references: repeatedIdentification.normalizedReferences,
      referenceSequences: [
        ["<branch-a@example.test>", "<root@example.test>"],
        ["<branch-b@example.test>", "<root@example.test>"],
      ],
    });
    expect(readObservation).toMatchObject({
      messageId: listedObservation.messageId,
      inReplyTo: listedObservation.inReplyTo,
      references: listedObservation.references,
    });

    const providers = new MailProviderRegistry();
    providers.register(account.id, provider);
    const store = new Store(":memory:");
    try {
      await store.insertAccount({ ...account, encryptedCredentials: null });
      const unavailable = () => { throw new Error("Factory is not used by this fixture"); };
      const service = new PostreeveService(
        store,
        { tenantId: "tenant-a" },
        providers,
        new MailSenderRegistry(),
        new CredentialVault(Buffer.alloc(32, 7).toString("base64")),
        unavailable,
        unavailable,
      );
      const [listed] = await service.listMessages({ accountId: account.id, mailbox: "INBOX", limit: 1 });
      if (!listed) throw new Error("Expected canonical Gmail summary");
      const [read] = await service.readMessages([listed.ref]);
      if (!read) throw new Error("Expected canonical Gmail detail");
      expect("referenceSequences" in listed).toBe(false);
      expect("referenceSequences" in read).toBe(false);
      const api = createApi(service);
      const listResponse = await api.request(`/api/accounts/${account.id}/messages?mailbox=INBOX&limit=1`);
      const publicSummaries: unknown = await listResponse.json();
      expect(Array.isArray(publicSummaries) && publicSummaries.every((message) =>
        typeof message === "object" && message !== null && !("referenceSequences" in message))).toBe(true);
      const readResponse = await api.request("/api/messages/read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ references: [listed.ref] }),
      });
      const publicDetails: unknown = await readResponse.json();
      expect(Array.isArray(publicDetails) && publicDetails.every((message) =>
        typeof message === "object" && message !== null && !("referenceSequences" in message))).toBe(true);
      await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: account.id, provider: "gmail", mailbox: "INBOX", authoritative: false,
        observations: ["branch-a", "branch-b", "root"].map((name, index) => ({
          tenantId: "tenant-a", messageId: `<${name}@example.test>`, inReplyTo: null, references: [],
          receivedAt: `2026-09-0${3 - index}T00:00:00.000Z`,
          location: { accountId: account.id, provider: "gmail" as const, mailbox: "INBOX", uidValidity: "gmail",
            uid: 20 + index, modseq: null, providerId: `parent-${name}`, read: false, flagged: false },
        })),
      });
      const response = await api.request(`/api/conversations/${listed.conversationId}`);
      const conversation = canonicalConversationSchema.parse(await response.json());

      expect(read).toMatchObject({
        canonicalId: listed.canonicalId,
        conversationId: listed.conversationId,
        providerConversationId: "thread-repeated",
      });
      expect(conversation.messages).toContainEqual(expect.objectContaining({
        id: listed.canonicalId,
        messageId: repeatedIdentification.normalizedMessageId,
        inReplyTo: repeatedIdentification.normalizedInReplyTo,
        references: ["<branch-a@example.test>", "<branch-b@example.test>", "<root@example.test>"],
      }));
      const messageIds = conversation.messages.map(({ messageId }) => messageId);
      expect(messageIds.indexOf("<branch-a@example.test>")).toBeLessThan(messageIds.indexOf("<root@example.test>"));
      expect(messageIds.indexOf("<branch-b@example.test>")).toBeLessThan(messageIds.indexOf("<root@example.test>"));
      expect(messageIds.indexOf("<root@example.test>")).toBeLessThan(
        messageIds.indexOf(repeatedIdentification.normalizedMessageId));
    } finally {
      store.close();
    }
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
    expect(messages.map(({ messageId }) => messageId)).toEqual(["", "", ""]);
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
