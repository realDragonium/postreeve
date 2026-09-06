import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import { GmailMailClient, type HttpFetch } from "../src/server/mail/gmail";
import type { Draft } from "../src/shared/contracts";

const gmailAccount = {
  id: "gmail-drafts-account",
  name: "Draft owner",
  email: "owner@example.test",
  kind: "gmail" as const,
};

describe("Gmail provider drafts", () => {
  test("creates, recovers ambiguous responses, paginates, updates without duplicates, and removes idempotently", async () => {
    const containers = new Map<string, string>([["external", Buffer.from("Subject: external\r\n\r\nbody").toString("base64url")]]);
    const requests: string[] = [];
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
    const first = draft(1, { to: "unfinished@, Person <person@example.test>", body: "First body\nexactly." });

    const createdRef = await client.createDraft(gmailAccount.id, first);
    expect(createdRef).toEqual({ kind: "gmail", draftId: "provider-1" });
    expect((await client.listDrafts(gmailAccount.id)).map(({ postreeveId, version }) => ({ postreeveId, version })))
      .toEqual([{ postreeveId: first.id, version: 1 }]);
    const updated = draft(2, {
      to: "unfinished@, Person <person@example.test>",
      subject: "Updated subject",
      body: "Second body",
    });
    const updatedRef = await client.updateDraft(gmailAccount.id, updated, createdRef);
    expect(updatedRef).toEqual(createdRef);
    expect((await client.listDrafts(gmailAccount.id)).filter(({ postreeveId }) => postreeveId === first.id)).toHaveLength(1);
    const raw = containers.get("provider-1");
    if (!raw) throw new Error("Expected mirrored Gmail draft");
    const decoded = Buffer.from(raw, "base64url");
    expect(decoded.toString()).toContain("To: unfinished@, Person <person@example.test>");
    expect((await simpleParser(decoded)).text).toBe("Second body");
    expect(requests.some((entry) => entry.includes("pageToken=1"))).toBe(true);

    containers.set("duplicate", raw);
    await client.updateDraft(gmailAccount.id, updated, updatedRef);
    expect((await client.listDrafts(gmailAccount.id)).filter(({ postreeveId }) => postreeveId === first.id)).toHaveLength(1);

    await client.removeDraft(gmailAccount.id, first.id, updatedRef);
    await client.removeDraft(gmailAccount.id, first.id, updatedRef);
    expect(containers.has("provider-1")).toBe(false);
    expect(containers.has("external")).toBe(true);
    await expect(client.listDrafts("another-account")).rejects.toThrow("another account");
    await expect(client.createDraft(gmailAccount.id, { ...first, accountId: "another-account" }))
      .rejects.toThrow("another account");
  });
});

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
    delivery: { status: "editable" },
    mirror: { status: "pending" },
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: `2026-09-06T10:00:0${version}.000Z`,
    version,
    ...changes,
  };
}

function parseBody(body: BodyInit | null | undefined): { message: { raw: string } } {
  if (typeof body !== "string") throw new Error("Expected JSON request body");
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || !("message" in parsed)) throw new Error("Missing Gmail message body");
  const message = parsed.message;
  if (typeof message !== "object" || message === null || !("raw" in message) || typeof message.raw !== "string") {
    throw new Error("Missing Gmail raw draft");
  }
  return { message: { raw: message.raw } };
}
