import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import { GmailMailClient, type HttpFetch } from "../src/server/mail/gmail";
import { buildProviderDraftMessage, parseProviderDraftMarkers, parseProviderDraftSource } from "../src/server/mail/provider-draft";
import { MailProviderRegistry } from "../src/server/mail/provider";
import { MailSenderRegistry } from "../src/server/mail/sender";
import { PostreeveService } from "../src/server/core/postreeve";
import { Store } from "../src/server/db/store";
import { CredentialVault } from "../src/server/security/credentials";
import type { Draft } from "../src/shared/contracts";

const gmailAccount = {
  id: "gmail-drafts-account",
  name: "Draft owner",
  email: "owner@example.test",
  kind: "gmail" as const,
};

describe("Gmail provider drafts", () => {
  test("encodes arbitrary editable content as safe MIME without requiring valid recipients", async () => {
    const editable = draft(7, {
      to: "unfinished@, Jöhn <person@example.test>\r\nX-Injected: blocked",
      cc: "pending@",
      subject: "Résumé 🌍\r\nX-Injected: blocked",
      body: "Unicode 🌍 and MIME-looking =? text.\nSecond line with trailing space. ",
      identity: { name: "Jöhn 🌍", address: gmailAccount.email },
      source: {
        canonicalMessageId: "canonical/source",
        conversationId: "conversation/source",
        providerConversationId: "thread/source",
      },
    });

    const raw = await buildProviderDraftMessage(draftScope(editable.accountId), editable);
    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe("Résumé 🌍 X-Injected: blocked");
    expect(parsed.text).toBe(editable.body);
    expect(raw.toString()).toContain("To: <unfinished@>");
    expect(raw.toString()).not.toContain("\r\nX-Injected: blocked\r\n");
    expect(parseProviderDraftMarkers(raw)).toEqual({
      tenantId: "tenant-a", accountId: editable.accountId, postreeveId: editable.id, version: 7,
    });
    expect(parseProviderDraftMarkers([
      `X-Postreeve-Draft-Account-ID: ${Buffer.from(editable.accountId).toString("base64url")}`,
      "X-Postreeve-Draft-ID: c2NvcGVsZXNz",
      "X-Postreeve-Draft-Version: 1",
      "",
      "",
    ].join("\r\n")))
      .toBeNull();
  });

  test("folds maximum Unicode and arbitrary editable headers without changing backend content", async () => {
    const injection = "\r\nX-Injected: blocked";
    const subject = `${"é".repeat(998 - injection.length)}${injection}`;
    const source = {
      canonicalMessageId: `message/${"m".repeat(1_200)}`,
      conversationId: `conversation/${"c".repeat(1_200)}`,
      providerConversationId: `provider/${"p".repeat(1_200)}`,
    };
    const editable = draft(9, {
      accountId: `account/${"a".repeat(1_200)}`,
      id: `draft/${"d".repeat(1_500)}`,
      to: `${"unfinished".repeat(180)}@\r\nBcc: injected@example.test`,
      cc: `Jöhn ${"pending".repeat(150)}@`,
      subject,
      source,
    });
    const original = structuredClone(editable);

    const raw = await buildProviderDraftMessage(draftScope(editable.accountId), editable);
    const headerBlock = raw.toString("utf8").split("\r\n\r\n", 1)[0] ?? "";
    for (const line of headerBlock.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThan(998);
    }
    for (const encodedWord of headerBlock.match(/=\?[^?]+\?[bqBQ]\?[^?]*\?=/g) ?? []) {
      expect(encodedWord.length).toBeLessThanOrEqual(75);
    }
    expect(headerBlock).not.toContain("\r\nX-Injected: blocked");
    expect(parseProviderDraftMarkers(raw)).toEqual({
      tenantId: "tenant-a",
      accountId: editable.accountId,
      postreeveId: editable.id,
      version: editable.version,
    });
    expect(parseProviderDraftSource(raw)).toEqual(source);
    expect((await simpleParser(raw)).subject).toBe(subject.replace(/[\r\n]+/g, " "));
    expect(editable).toEqual(original);
  });

  test("creates, recovers ambiguous responses, paginates, updates without duplicates, and removes idempotently", async () => {
    const containers = new Map<string, string>([["external", Buffer.from("Subject: external\r\n\r\nbody").toString("base64url")]]);
    const requests: string[] = [];
    const draftRequests: Array<{ raw: string; threadId?: string }> = [];
    let nextId = 1;
    let ambiguousCreate = true;
    let ambiguousDelete = true;
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url.pathname}${url.search}`);
      if (url.origin === "https://oauth2.googleapis.com") {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      const draftId = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(url.pathname)?.[1];
      if (url.pathname.endsWith("/drafts") && method === "GET") {
        const ids = [...containers.keys()];
        const offset = Number(url.searchParams.get("pageToken") ?? "0");
        const page = ids.slice(offset, offset + 1);
        return Response.json({ drafts: page.map((id) => ({ id })), ...(offset + 1 < ids.length ? { nextPageToken: String(offset + 1) } : {}) });
      }
      if (url.pathname.endsWith("/drafts") && method === "POST") {
        const body = parseBody(init?.body);
        draftRequests.push(body.message);
        const id = `provider-${nextId++}`;
        containers.set(id, body.message.raw);
        if (ambiguousCreate) {
          ambiguousCreate = false;
          return Response.json({ error: { message: "ambiguous gateway response" } }, { status: 503 });
        }
        return Response.json({ id, message: { id: `message-${id}`, raw: body.message.raw } });
      }
      if (draftId && method === "GET") {
        const raw = containers.get(draftId);
        return raw
          ? Response.json({ id: draftId, message: { id: `message-${draftId}`, raw } })
          : Response.json({ error: { message: "missing" } }, { status: 404 });
      }
      if (draftId && method === "PUT") {
        if (!containers.has(draftId)) return Response.json({ error: { message: "missing" } }, { status: 404 });
        const body = parseBody(init?.body);
        draftRequests.push(body.message);
        containers.set(draftId, body.message.raw);
        return Response.json({ id: draftId, message: { id: `message-${draftId}`, raw: body.message.raw } });
      }
      if (draftId && method === "DELETE") {
        containers.delete(draftId);
        if (ambiguousDelete) {
          ambiguousDelete = false;
          return Response.json({ error: { message: "ambiguous delete response" } }, { status: 503 });
        }
        return Response.json(null);
      }
      return Response.json({ error: { message: "unexpected fixture request" } }, { status: 500 });
    };
    const client = new GmailMailClient({
      account: gmailAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });
    const first = draft(1, {
      to: "unfinished@, Person <person@example.test>",
      body: "First body\nexactly.",
      source: {
        canonicalMessageId: "source-message",
        conversationId: "source-conversation",
        providerConversationId: "unvalidated-thread",
      },
    });

    const createdRef = await client.createDraft(draftScope(), first);
    expect(createdRef).toEqual({ kind: "gmail", draftId: "provider-1" });
    expect((await client.listDrafts(draftScope())).map(({ postreeveId, version }) => ({ postreeveId, version })))
      .toEqual([{ postreeveId: first.id, version: 1 }]);
    const updated = draft(2, {
      to: "unfinished@, Person <person@example.test>",
      subject: "Updated subject",
      body: "Second body",
    });
    const updatedRef = await client.updateDraft(draftScope(), updated, createdRef);
    expect(updatedRef).toEqual(createdRef);
    expect((await client.listDrafts(draftScope())).filter(({ postreeveId }) => postreeveId === first.id)).toHaveLength(1);
    const raw = containers.get("provider-1");
    if (!raw) throw new Error("Expected mirrored Gmail draft");
    const decoded = Buffer.from(raw, "base64url");
    expect(decoded.toString()).toContain("To: <unfinished@>, Person <person@example.test>");
    expect((await simpleParser(decoded)).text).toBe("Second body");
    expect(requests.some((entry) => entry.includes("pageToken=1"))).toBe(true);

    containers.set("duplicate", raw);
    await client.updateDraft(draftScope(), updated, updatedRef);
    expect((await client.listDrafts(draftScope())).filter(({ postreeveId }) => postreeveId === first.id)).toHaveLength(1);
    await expect(client.updateDraft(draftScope("another-account"), updated, updatedRef)).rejects.toThrow("another account");
    await expect(client.removeDraft(draftScope("another-account"), first.id, updatedRef)).rejects.toThrow("another account");

    await client.removeDraft(draftScope(), first.id, updatedRef);
    await client.removeDraft(draftScope(), first.id, updatedRef);
    expect(containers.has("provider-1")).toBe(false);
    expect(containers.has("external")).toBe(true);
    expect(draftRequests.every(({ threadId }) => threadId === undefined)).toBe(true);
    await expect(client.listDrafts(draftScope("another-account"))).rejects.toThrow("another account");
    await expect(client.createDraft(draftScope(), { ...first, accountId: "another-account" }))
      .rejects.toThrow("another account");
  });

  test("keeps same-id drafts isolated between accounts sharing a Gmail mailbox", async () => {
    const otherAccount = { ...gmailAccount, id: "gmail-drafts-other-account" };
    const containers = new Map<string, string>();
    let nextId = 1;
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.origin === "https://oauth2.googleapis.com") {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      const draftId = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(url.pathname)?.[1];
      if (url.pathname.endsWith("/drafts") && method === "GET") {
        return Response.json({ drafts: [...containers.keys()].map((id) => ({ id })) });
      }
      if (url.pathname.endsWith("/drafts") && method === "POST") {
        const body = parseBody(init?.body);
        const id = `shared-provider-${nextId++}`;
        containers.set(id, body.message.raw);
        return Response.json({ id, message: { id: `message-${id}`, raw: body.message.raw } });
      }
      if (draftId && method === "GET") {
        const raw = containers.get(draftId);
        return raw
          ? Response.json({ id: draftId, message: { id: `message-${draftId}`, raw } })
          : Response.json({ error: { message: "missing" } }, { status: 404 });
      }
      if (draftId && method === "PUT") {
        const raw = parseBody(init?.body).message.raw;
        if (!containers.has(draftId)) return Response.json({ error: { message: "missing" } }, { status: 404 });
        containers.set(draftId, raw);
        return Response.json({ id: draftId, message: { id: `message-${draftId}`, raw } });
      }
      if (draftId && method === "DELETE") {
        containers.delete(draftId);
        return Response.json(null);
      }
      return Response.json({ error: { message: "unexpected fixture request" } }, { status: 500 });
    };
    const firstClient = new GmailMailClient({
      account: gmailAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });
    const secondClient = new GmailMailClient({
      account: otherAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });
    const firstDraft = draft(1);
    const secondDraft = draft(1, { accountId: otherAccount.id, identity: { name: otherAccount.name, address: otherAccount.email } });

    const firstRef = await firstClient.createDraft(draftScope(), firstDraft);
    const secondRef = await secondClient.createDraft(draftScope(otherAccount.id), secondDraft);
    expect(await firstClient.listDrafts(draftScope())).toEqual([
      { tenantId: "tenant-a", accountId: gmailAccount.id, postreeveId: firstDraft.id, version: 1, ref: firstRef },
    ]);
    expect(await secondClient.listDrafts(draftScope(otherAccount.id))).toEqual([
      { tenantId: "tenant-a", accountId: otherAccount.id, postreeveId: secondDraft.id, version: 1, ref: secondRef },
    ]);

    const updatedFirst = { ...firstDraft, body: "First account update", version: 2 };
    await firstClient.updateDraft(draftScope(), updatedFirst, secondRef);
    await firstClient.removeDraft(draftScope(), firstDraft.id, secondRef);
    expect(await firstClient.listDrafts(draftScope())).toEqual([]);
    expect(await secondClient.listDrafts(draftScope(otherAccount.id))).toEqual([
      { tenantId: "tenant-a", accountId: otherAccount.id, postreeveId: secondDraft.id, version: 1, ref: secondRef },
    ]);
    expect(containers).toHaveLength(1);
  });

  test("keeps same-account same-id drafts isolated between trusted tenants", async () => {
    const containers = new Map<string, string>();
    let nextId = 1;
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.origin === "https://oauth2.googleapis.com") {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      const id = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(url.pathname)?.[1];
      if (url.pathname.endsWith("/drafts") && method === "GET") {
        return Response.json({ drafts: [...containers.keys()].map((draftId) => ({ id: draftId })) });
      }
      if (url.pathname.endsWith("/drafts") && method === "POST") {
        const raw = parseBody(init?.body).message.raw;
        const draftId = `tenant-provider-${nextId++}`;
        containers.set(draftId, raw);
        return Response.json({ id: draftId, message: { id: `message-${draftId}`, raw } });
      }
      if (id && method === "GET") {
        const raw = containers.get(id);
        return raw
          ? Response.json({ id, message: { id: `message-${id}`, raw } })
          : Response.json({ error: { message: "missing" } }, { status: 404 });
      }
      if (id && method === "PUT") {
        const raw = parseBody(init?.body).message.raw;
        if (!containers.has(id)) return Response.json({ error: { message: "missing" } }, { status: 404 });
        containers.set(id, raw);
        return Response.json({ id, message: { id: `message-${id}`, raw } });
      }
      if (id && method === "DELETE") {
        containers.delete(id);
        return Response.json(null);
      }
      return Response.json({ error: { message: "unexpected fixture request" } }, { status: 500 });
    };
    const client = new GmailMailClient({
      account: gmailAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });
    const firstScope = draftScope(gmailAccount.id, "tenant-a");
    const secondScope = draftScope(gmailAccount.id, "tenant-b");
    const first = draft(1, { body: "Tenant A" });
    const second = draft(1, { body: "Tenant B" });

    const firstRef = await client.createDraft(firstScope, first);
    const secondRef = await client.createDraft(secondScope, second);
    expect(firstRef).not.toEqual(secondRef);
    expect(await client.listDrafts(firstScope)).toEqual([{
      tenantId: "tenant-a", accountId: gmailAccount.id, postreeveId: first.id, version: 1, ref: firstRef,
    }]);
    expect(await client.listDrafts(secondScope)).toEqual([{
      tenantId: "tenant-b", accountId: gmailAccount.id, postreeveId: second.id, version: 1, ref: secondRef,
    }]);

    await client.updateDraft(firstScope, { ...first, version: 2, body: "Tenant A updated" }, secondRef);
    const secondRaw = secondRef.kind === "gmail" ? containers.get(secondRef.draftId) : undefined;
    expect(secondRaw && (await simpleParser(Buffer.from(secondRaw, "base64url"))).text).toBe("Tenant B");
    await client.removeDraft(firstScope, first.id, secondRef);
    expect(await client.listDrafts(firstScope)).toEqual([]);
    expect(await client.listDrafts(secondScope)).toHaveLength(1);
    expect(containers).toHaveLength(1);
  });

  test("resolves an omitted exact Gmail ref before deleting only a fully scoped draft", async () => {
    const owned = draft(1);
    const ownedRaw = (await buildProviderDraftMessage(draftScope(), owned)).toString("base64url");
    const foreignRaw = (await buildProviderDraftMessage(draftScope(gmailAccount.id, "tenant-b"), owned))
      .toString("base64url");
    const containers = new Map<string, string>([
      ["owned", ownedRaw],
      ["malformed", Buffer.from([
        `X-Postreeve-Draft-Account-ID: ${Buffer.from(gmailAccount.id).toString("base64url")}`,
        `X-Postreeve-Draft-ID: ${Buffer.from(owned.id).toString("base64url")}`,
        "X-Postreeve-Draft-Version: 1",
        "",
        "",
      ].join("\r\n")).toString("base64url")],
      ["foreign", foreignRaw],
    ]);
    const deleted: string[] = [];
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.origin === "https://oauth2.googleapis.com") {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      const id = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(url.pathname)?.[1];
      if (url.pathname.endsWith("/drafts") && method === "GET") return Response.json({ drafts: [] });
      if (id === "uncertain" && method === "GET") {
        return Response.json({ error: { message: "lookup unavailable" } }, { status: 503 });
      }
      if (id && method === "GET") {
        const raw = containers.get(id);
        return raw
          ? Response.json({ id, message: { id: `message-${id}`, raw } })
          : Response.json({ error: { message: "missing" } }, { status: 404 });
      }
      if (id && method === "DELETE") {
        deleted.push(id);
        containers.delete(id);
        return Response.json(null);
      }
      return Response.json({ error: { message: "unexpected fixture request" } }, { status: 500 });
    };
    const client = new GmailMailClient({
      account: gmailAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });

    await client.removeDraft(draftScope(), owned.id, { kind: "gmail", draftId: "owned" });
    await client.removeDraft(draftScope(), owned.id, { kind: "gmail", draftId: "missing" });
    await client.removeDraft(draftScope(), owned.id, { kind: "gmail", draftId: "malformed" });
    await client.removeDraft(draftScope(), owned.id, { kind: "gmail", draftId: "foreign" });
    await expect(client.removeDraft(draftScope(), owned.id, { kind: "gmail", draftId: "uncertain" }))
      .rejects.toThrow("lookup unavailable");
    expect(deleted).toEqual(["owned"]);
    expect([...containers.keys()].sort()).toEqual(["foreign", "malformed"]);
  });

  test("rejects missing requested Gmail draft content before mutation", async () => {
    const deleted: string[] = [];
    let includeInDiscovery = true;
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.origin === "https://oauth2.googleapis.com") {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      const id = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(url.pathname)?.[1];
      if (url.pathname.endsWith("/drafts") && method === "GET") {
        return Response.json({ drafts: includeInDiscovery ? [{ id: "incomplete" }] : [] });
      }
      if (id === "incomplete" && method === "GET") {
        return Response.json({ id, message: { id: "message-incomplete" } });
      }
      if (id && method === "DELETE") {
        deleted.push(id);
        return Response.json(null);
      }
      return Response.json({ error: { message: "unexpected fixture request" } }, { status: 500 });
    };
    const client = new GmailMailClient({
      account: gmailAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });

    await expect(client.listDrafts(draftScope()))
      .rejects.toThrow("did not return raw content for draft incomplete");
    includeInDiscovery = false;
    await expect(client.removeDraft(draftScope(), "draft-1", { kind: "gmail", draftId: "incomplete" }))
      .rejects.toThrow("did not return raw content for draft incomplete");
    expect(deleted).toEqual([]);
  });

  test("updates an omitted exact Gmail ref and fails uncertain lookup before creating", async () => {
    const current = draft(1, { body: "Original body" });
    const containers = new Map<string, string>([[
      "exact",
      (await buildProviderDraftMessage(draftScope(), current)).toString("base64url"),
    ]]);
    let posts = 0;
    let puts = 0;
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.origin === "https://oauth2.googleapis.com") {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      const id = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(url.pathname)?.[1];
      if (url.pathname.endsWith("/drafts") && method === "GET") return Response.json({ drafts: [] });
      if (url.pathname.endsWith("/drafts") && method === "POST") {
        posts += 1;
        return Response.json({ error: { message: "must not create" } }, { status: 500 });
      }
      if (id === "uncertain" && method === "GET") {
        return Response.json({ error: { message: "exact lookup unavailable" } }, { status: 503 });
      }
      if (id && method === "GET") {
        const raw = containers.get(id);
        return raw
          ? Response.json({ id, message: { id: `message-${id}`, raw } })
          : Response.json({ error: { message: "missing" } }, { status: 404 });
      }
      if (id && method === "PUT") {
        puts += 1;
        const raw = parseBody(init?.body).message.raw;
        containers.set(id, raw);
        return Response.json({ id, message: { id: `message-${id}`, raw } });
      }
      return Response.json({ error: { message: "unexpected fixture request" } }, { status: 500 });
    };
    const client = new GmailMailClient({
      account: gmailAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });
    const updated = { ...current, version: 2, body: "Updated body" };

    await expect(client.updateDraft(draftScope(), updated, { kind: "gmail", draftId: "exact" }))
      .resolves.toEqual({ kind: "gmail", draftId: "exact" });
    expect(containers).toHaveLength(1);
    expect((await simpleParser(Buffer.from(containers.get("exact")!, "base64url"))).text).toBe("Updated body");
    await expect(client.updateDraft(draftScope(), updated, { kind: "gmail", draftId: "uncertain" }))
      .rejects.toThrow("exact lookup unavailable");
    expect({ posts, puts }).toEqual({ posts: 0, puts: 1 });
  });

  test("retains the backend row when exact Gmail ref lookup is uncertain", async () => {
    let raw: string | undefined;
    let failExactLookup = false;
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.origin === "https://oauth2.googleapis.com") {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      if (url.pathname.endsWith("/drafts") && method === "GET") return Response.json({ drafts: [] });
      if (url.pathname.endsWith("/drafts") && method === "POST") {
        raw = parseBody(init?.body).message.raw;
        return Response.json({ id: "exact", message: { id: "message-exact", raw } });
      }
      if (url.pathname.includes("/drafts/exact") && method === "GET") {
        if (failExactLookup) return Response.json({ error: { message: "lookup unavailable" } }, { status: 503 });
        return raw
          ? Response.json({ id: "exact", message: { id: "message-exact", raw } })
          : Response.json({ error: { message: "missing" } }, { status: 404 });
      }
      return Response.json({ error: { message: "unexpected fixture request" } }, { status: 500 });
    };
    const provider = new GmailMailClient({
      account: gmailAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });
    const providers = new MailProviderRegistry();
    providers.register(gmailAccount.id, provider);
    const store = new Store(":memory:");
    await store.insertAccount({ ...gmailAccount, encryptedCredentials: null });
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
    const created = await service.createDraft({
      accountId: gmailAccount.id,
      mode: "new",
      to: "person@example.test",
      cc: "",
      bcc: "",
      subject: "Retain on uncertainty",
      body: "Backend authority",
      identity: { name: gmailAccount.name, address: gmailAccount.email },
      attachments: [],
    });
    failExactLookup = true;

    await expect(service.removeDraft(gmailAccount.id, created.id, { version: created.version }))
      .rejects.toThrow("lookup unavailable");
    expect(await store.getDraft("tenant-a", gmailAccount.id, created.id)).toMatchObject({
      id: created.id,
      body: "Backend authority",
      mirror: { status: "failed", ref: created.mirror.ref },
    });
    store.close();
  });

  test("cleans an older duplicate after recovering an ambiguous Gmail update", async () => {
    const initial = draft(1);
    const updated = draft(2, { body: "Updated remotely before the response was lost" });
    const initialRaw = (await buildProviderDraftMessage(draftScope(), initial)).toString("base64url");
    const containers = new Map<string, string>([["selected", initialRaw], ["stale", initialRaw]]);
    let ambiguousUpdate = true;
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      if (url.origin === "https://oauth2.googleapis.com") {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      const draftId = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(url.pathname)?.[1];
      if (url.pathname.endsWith("/drafts") && method === "GET") {
        return Response.json({ drafts: [...containers.keys()].map((id) => ({ id })) });
      }
      if (draftId && method === "GET") {
        const raw = containers.get(draftId);
        return raw
          ? Response.json({ id: draftId, message: { id: `message-${draftId}`, raw } })
          : Response.json({ error: { message: "missing" } }, { status: 404 });
      }
      if (draftId === "selected" && method === "PUT") {
        const raw = parseBody(init?.body).message.raw;
        containers.set(draftId, raw);
        if (ambiguousUpdate) {
          ambiguousUpdate = false;
          return Response.json({ error: { message: "lost update response" } }, { status: 503 });
        }
        return Response.json({ id: draftId, message: { id: `message-${draftId}`, raw } });
      }
      if (draftId && method === "DELETE") {
        containers.delete(draftId);
        return Response.json(null);
      }
      return Response.json({ error: { message: "unexpected fixture request" } }, { status: 500 });
    };
    const client = new GmailMailClient({
      account: gmailAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });

    const ref = await client.updateDraft(draftScope(), updated, { kind: "gmail", draftId: "selected" });

    expect(ref).toEqual({ kind: "gmail", draftId: "selected" });
    expect(containers).toHaveLength(1);
    expect(containers.has("selected")).toBe(true);
    expect(await client.listDrafts(draftScope())).toEqual([
      { tenantId: "tenant-a", accountId: gmailAccount.id, postreeveId: updated.id, version: 2, ref },
    ]);
  });

  test("bounds stale-listing PUT-404 recovery and succeeds on a later retry without duplicates", async () => {
    const current = draft(4, { body: "Authoritative body" });
    const staleRaw = (await buildProviderDraftMessage(draftScope(), current)).toString("base64url");
    const containers = new Map<string, string>();
    const requests: string[] = [];
    let staleListed = true;
    let postFails = true;
    const request: HttpFetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url.pathname}${url.search}`);
      if (url.origin === "https://oauth2.googleapis.com") {
        return Response.json({ access_token: "draft-token", expires_in: 3600 });
      }
      if (url.pathname.endsWith("/drafts") && method === "GET") {
        return Response.json({ drafts: [
          ...(staleListed ? [{ id: "stale" }] : []),
          ...[...containers.keys()].map((id) => ({ id })),
        ] });
      }
      if (url.pathname.endsWith("/drafts") && method === "POST") {
        if (postFails) return Response.json({ error: { message: "temporary failure" } }, { status: 503 });
        const body = parseBody(init?.body);
        containers.set("current", body.message.raw);
        return Response.json({ id: "current", message: { id: "message-current", raw: body.message.raw } });
      }
      if (url.pathname.includes("/drafts/stale") && method === "GET") {
        return Response.json({ id: "stale", message: { id: "message-stale", raw: staleRaw } });
      }
      if (url.pathname.includes("/drafts/stale") && method === "PUT") {
        return Response.json({ error: { message: "stale container" } }, { status: 404 });
      }
      if (url.pathname.includes("/drafts/stale") && method === "DELETE") {
        staleListed = false;
        return Response.json(null);
      }
      if (url.pathname.includes("/drafts/current") && method === "GET") {
        const raw = containers.get("current");
        return raw
          ? Response.json({ id: "current", message: { id: "message-current", raw } })
          : Response.json({ error: { message: "missing" } }, { status: 404 });
      }
      return Response.json({ error: { message: "unexpected fixture request" } }, { status: 500 });
    };
    const client = new GmailMailClient({
      account: gmailAccount,
      credentials: { kind: "gmail", refreshToken: "refresh" },
      clientId: "client",
      fetch: request,
    });
    const staleRef = { kind: "gmail", draftId: "stale" } as const;

    await expect(client.updateDraft(draftScope(), current, staleRef)).rejects.toThrow("temporary failure");
    expect(requests.filter((entry) => entry.startsWith("PUT "))).toHaveLength(1);
    expect(requests.filter((entry) => entry.startsWith("POST ") && entry.includes("/drafts"))).toHaveLength(1);
    expect(requests.length).toBeLessThanOrEqual(10);

    postFails = false;
    const recovered = await client.updateDraft(draftScope(), current, staleRef);
    expect(recovered).toEqual({ kind: "gmail", draftId: "current" });
    expect(staleListed).toBe(false);
    expect(containers).toHaveLength(1);
    expect(await client.listDrafts(draftScope())).toEqual([
      { tenantId: "tenant-a", accountId: gmailAccount.id, postreeveId: current.id, version: current.version, ref: recovered },
    ]);
  });
});

function draftScope(accountId = gmailAccount.id, tenantId = "tenant-a") {
  return { tenantId, accountId };
}

function draft(version: number, changes: Partial<Draft> = {}): Draft {
  return {
    id: "postreeve-draft",
    accountId: gmailAccount.id,
    mode: "new",
    to: "person@example.test",
    cc: "",
    bcc: "",
    subject: "Provider draft",
    body: "Body",
    identity: { name: gmailAccount.name, address: gmailAccount.email },
    attachments: [],
    delivery: { status: "editable" },
    mirror: { status: "pending" },
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: `2026-09-06T10:00:0${version}.000Z`,
    version,
    ...changes,
  };
}

function parseBody(body: BodyInit | null | undefined): { message: { raw: string; threadId?: string } } {
  if (typeof body !== "string") throw new Error("Expected JSON request body");
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("message" in parsed)) throw new Error("Missing Gmail message body");
  const message = parsed.message;
  if (typeof message !== "object" || message === null || !("raw" in message) || typeof message.raw !== "string") {
    throw new Error("Missing Gmail raw draft");
  }
  return { message: { raw: message.raw } };
}
