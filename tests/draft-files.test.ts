import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import type { Account, Draft, DraftContent, SendMessageInput } from "../src/shared/contracts";
import { createApi } from "../src/server/api";
import { MailSendPreDispatchError } from "../src/server/mail/sender";
import { composeMime, type OutgoingAttachment } from "../src/server/mail/outgoing-content";
import { buildProviderDraftMessage, parseProviderDraftMarkers } from "../src/server/mail/provider-draft";
import { SmtpMailSender } from "../src/server/mail/smtp";
import { GmailMailClient } from "../src/server/mail/gmail";
import { DraftSaveQueue } from "../src/web/draft-state";
import { createEmptyTestHarness, testAccountInput } from "./support/test-mail";

const binary = Buffer.from([0, 255, 128, 13, 10, 0, 42]);
const file = (): OutgoingAttachment => ({ id: crypto.randomUUID(), name: "résumé.bin", type: "application/octet-stream", content: binary });
function content(account: Account): DraftContent {
  return { mode: "new", to: "recipient@example.test", cc: "", bcc: "", subject: "Files", body: "  authored\nbody  ", identity: { name: account.name, address: account.email }, attachments: [] };
}

async function createDraft(harness: Awaited<ReturnType<typeof createEmptyTestHarness>>) {
  const account = await harness.service.createAccount(testAccountInput());
  return harness.service.createDraft({ accountId: account.id, ...content(account) });
}

describe("durable uploaded draft files", () => {
  test("survives reopen, scopes bytes and references, and atomically cleans removed files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "postreeve-files-"));
    const path = join(dir, "test.sqlite");
    let harness = await createEmptyTestHarness({ storePath: path });
    try {
      const draft = await createDraft(harness);
      const attachment = file();
      const stored = await harness.service.uploadDraftFile(draft.accountId, draft.id, draft.version, attachment);
      expect(stored.version).toBe(2);
      expect(stored.attachments).toEqual([{ id: attachment.id, name: attachment.name, type: attachment.type, size: binary.length }]);
      expect(JSON.stringify(stored)).not.toContain(binary.toString("base64"));
      const retried = await harness.service.uploadDraftFile(draft.accountId, draft.id, draft.version, attachment);
      expect(retried.version).toBe(2);
      harness.store.close();
      harness = await createEmptyTestHarness({ storePath: path });
      const reopened = await harness.service.getDraft(draft.accountId, draft.id);
      expect((await harness.service.downloadDraftFile(draft.accountId, draft.id, attachment.id)).content).toEqual(binary);
      expect(reopened.attachments).toEqual(stored.attachments);
      await expect(harness.store.draftFiles("foreign-tenant", draft.accountId, reopened)).rejects.toThrow();
      const sibling = await harness.service.createDraft({ accountId: draft.accountId, ...content({ id: draft.accountId, kind: "imap", name: "Work", email: "person@example.test" }) });
      await expect(harness.service.updateDraft(draft.accountId, sibling.id, { ...sibling, attachments: stored.attachments })).rejects.toThrow("another draft");
      await expect(harness.service.uploadDraftFile(draft.accountId, draft.id, 1, file())).rejects.toThrow("version conflict");
      const removed = await harness.service.updateDraft(draft.accountId, draft.id, { ...reopened, attachments: [] });
      expect(removed.attachments).toEqual([]);
      await expect(harness.store.draftFiles("test-tenant", draft.accountId, reopened)).rejects.toThrow("another draft");
      expect((await harness.service.getDraft(draft.accountId, draft.id)).version).toBe(3);
    } finally {
      harness.store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves failed/uncertain files and gives a recovery copy independent ownership", async () => {
    let failure: Error | undefined = new MailSendPreDispatchError("Offline before delivery");
    const harness = await createEmptyTestHarness({ sendFailure: () => failure });
    try {
      let draft = await createDraft(harness);
      const attachment = file();
      draft = await harness.service.uploadDraftFile(draft.accountId, draft.id, draft.version, attachment);
      await expect(harness.service.sendDraft(draft.accountId, draft.id, { version: draft.version })).rejects.toThrow("Offline");
      draft = await harness.service.getDraft(draft.accountId, draft.id);
      expect(draft.delivery.status).toBe("failed");
      expect((await harness.service.downloadDraftFile(draft.accountId, draft.id, attachment.id)).content).toEqual(binary);
      failure = new Error("Response lost");
      await expect(harness.service.sendDraft(draft.accountId, draft.id, { version: draft.version })).rejects.toThrow("Response lost");
      draft = await harness.service.getDraft(draft.accountId, draft.id);
      expect(draft.delivery.status).toBe("uncertain");
      const copy = await harness.service.copyDraftForRecovery(draft.accountId, draft.id, { version: draft.version });
      const original = await harness.service.getDraft(draft.accountId, draft.id);
      await harness.service.removeDraft(draft.accountId, draft.id, { version: original.version });
      expect((await harness.service.downloadDraftFile(copy.accountId, copy.id, attachment.id)).content).toEqual(binary);
      failure = undefined;
      await harness.service.sendDraft(copy.accountId, copy.id, { version: copy.version });
      expect((await harness.service.getDraft(copy.accountId, copy.id)).delivery.status).toBe("sent");
      expect(harness.sendAttempts).toHaveLength(3);
      expect(harness.sendContents.map((content) => content?.files?.[0]?.content)).toEqual([binary, binary, binary]);
    } finally { harness.store.close(); }
  });

  test("bounds actual upload bytes and encoded aggregate without changing the winning draft", async () => {
    const harness = await createEmptyTestHarness({ maxUploadBytes: 800, maxMessageBytes: 2300 });
    try {
      let draft = await createDraft(harness);
      await expect(harness.service.uploadDraftFile(draft.accountId, draft.id, draft.version, { ...file(), content: Buffer.alloc(801) })).rejects.toThrow("upload limit");
      draft = await harness.service.uploadDraftFile(draft.accountId, draft.id, draft.version, { ...file(), content: Buffer.alloc(700) });
      await expect(harness.service.uploadDraftFile(draft.accountId, draft.id, draft.version, { ...file(), content: Buffer.alloc(700) })).rejects.toThrow("message limit");
      expect((await harness.service.getDraft(draft.accountId, draft.id)).attachments).toHaveLength(1);
      const app = createApi(harness.service);
      const response = await app.request(`/api/accounts/${draft.accountId}/drafts/${draft.id}/files`, {
        method: "POST", headers: { "X-Postreeve-File": encodeURIComponent(JSON.stringify({ id: crypto.randomUUID(), version: draft.version, name: "bad.bin", type: "" })) }, body: Buffer.alloc(801),
      });
      expect(response.status).toBe(413);
    } finally { harness.store.close(); }
  });

  test("serializes upload versions and recovers a lost upload response without another file", async () => {
    const harness = await createEmptyTestHarness();
    try {
      const draft = await createDraft(harness);
      const queue = new DraftSaveQueue(draft.accountId, draft, (input) => harness.service.createDraft(input), (accountId, id, input) => harness.service.updateDraft(accountId, id, input));
      const attachment = file();
      const selected = new File([binary], attachment.name, { type: attachment.type });
      let loseResponse = true;
      const upload = async (accountId: string, draftId: string, version: number, id: string, incoming: File): Promise<Draft> => {
        const stored = await harness.service.uploadDraftFile(accountId, draftId, version, { id, name: incoming.name, type: incoming.type, content: new Uint8Array(await incoming.arrayBuffer()) });
        if (loseResponse) { loseResponse = false; throw new Error("Response lost"); }
        return stored;
      };
      await expect(queue.uploadFile(draft, attachment.id, selected, upload)).rejects.toThrow("Response lost");
      const stored = await queue.uploadFile(draft, attachment.id, selected, upload);
      expect(stored.version).toBe(2);
      expect(stored.attachments).toHaveLength(1);
      expect(queue.isDirty({ ...stored, attachments: [{ ...stored.attachments[0]!, id: crypto.randomUUID() }] })).toBe(true);
    } finally { harness.store.close(); }
  });
});

const input: SendMessageInput = { accountId: "a", to: [{ name: "", address: "to@example.test" }], cc: [], bcc: [{ name: "", address: "hidden@example.test" }], subject: "File delivery", text: "Exact body\n" };
const account: Account = { id: "a", kind: "gmail", email: "from@example.test", name: "Sender" };
const smtpConfig = { accountId: "a", fromName: "Sender", fromAddress: account.email, host: "smtp.example.test", port: 465, secure: true, username: "fake", password: "fake" };

describe("outgoing MIME attachment contract", () => {
  test("Gmail and SMTP preserve equivalent files and threading while SMTP keeps Bcc in its envelope", async () => {
    const files = [file(), { ...file(), name: "empty.txt", type: "text/plain", content: Buffer.alloc(0) }];
    let gmailRaw: Buffer | undefined;
    const gmail = new GmailMailClient({ account, credentials: { kind: "gmail", refreshToken: "fake" }, clientId: "fake", clientSecret: "fake", fetch: async (url, init) => {
      if (String(url).includes("oauth2")) return Response.json({ access_token: "fake", expires_in: 3600 });
      const payload: unknown = JSON.parse(String(init?.body));
      if (typeof payload !== "object" || payload === null || !("raw" in payload) || typeof payload.raw !== "string") throw new Error("Expected Gmail raw MIME");
      gmailRaw = Buffer.from(payload.raw, "base64url");
      return Response.json({ id: "sent", threadId: "thread" });
    } });
    let smtpRaw: Buffer | undefined;
    const smtp = new SmtpMailSender(smtpConfig, () => ({ verify: async () => true, sendMail: async (options) => {
      if (!Buffer.isBuffer(options.raw)) throw new Error("Expected SMTP raw MIME");
      smtpRaw = options.raw;
      expect(options.envelope).toEqual({ from: account.email, to: ["to@example.test", "hidden@example.test"] });
      return { messageId: "sent", accepted: ["to@example.test", "hidden@example.test"], rejected: [] };
    } }));
    const context = { type: "reply" as const, sourceMessageId: "parent", conversationId: "conversation", inReplyTo: "<parent@example.test>", references: ["<parent@example.test>"] };
    await gmail.send(input, context, { files });
    await smtp.send(input, context, { files });
    if (!gmailRaw || !smtpRaw) throw new Error("Expected both transports to receive MIME");
    for (const raw of [gmailRaw, smtpRaw]) {
      const parsed = await simpleParser(raw);
      expect(parsed.inReplyTo).toBe("<parent@example.test>");
      expect(parsed.attachments.map(({ filename, contentType, content }) => ({ name: filename, type: contentType, bytes: [...content] }))).toEqual(files.map((file) => ({ name: file.name, type: file.type, bytes: [...file.content] })));
      expect(raw.toString()).toContain(Buffer.from(input.text).toString("base64"));
    }
    expect((await simpleParser(smtpRaw)).bcc).toBeUndefined();
    expect((await simpleParser(gmailRaw)).bcc).toBeDefined();
    await expect(smtp.send(input, undefined, { files, maxMessageBytes: 50 })).rejects.toBeInstanceOf(MailSendPreDispatchError);
    await expect(gmail.send(input, undefined, { files, maxMessageBytes: 50 })).rejects.toBeInstanceOf(MailSendPreDispatchError);
  });

  test("draft MIME preserves exact text, owned markers and files for zero/one attachments", async () => {
    for (const body of ["", "   ASCII\n\nend  \r\n", "Héllo 🌍\n"]) for (const files of [[], [file()]]) {
      const draft: Draft = { ...content(account), id: "draft", accountId: account.id, body, version: 3, createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z", mirror: { status: "pending" }, delivery: { status: "editable" } };
      const raw = await buildProviderDraftMessage({ tenantId: "tenant", accountId: account.id }, { ...draft, files });
      expect(parseProviderDraftMarkers(raw)).toEqual({ tenantId: "tenant", accountId: "a", postreeveId: "draft", version: 3 });
      const parsed = await simpleParser(raw);
      expect(parsed.from?.value[0]?.address).toBe(account.email);
      expect(raw.toString()).toContain(Buffer.from(body).toString("base64"));
      expect(parsed.attachments).toHaveLength(files.length);
      if (files.length) expect(parsed.attachments[0]?.content).toEqual(binary);
    }
    const raw = await composeMime({ from: account.email, to: "to@example.test" }, input.text);
    expect(raw.byteLength).toBeGreaterThan(Buffer.byteLength(input.text));
  });
});
