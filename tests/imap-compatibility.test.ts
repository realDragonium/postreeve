import { describe, expect, test } from "bun:test";
import { simpleParser } from "mailparser";
import type {
  AppendResponseObject,
  CopyResponseObject,
  ESearchResult,
  FetchMessageObject,
  FetchOptions,
  FetchQueryObject,
  ImapFlowOptions,
  ListOptions,
  ListResponse,
  MailboxObject,
  MailboxOpenOptions,
  SearchObject,
  StatusObject,
  StoreOptions,
} from "imapflow";

import {
  ImapMailProvider,
  type ImapClient,
  type ImapClientFactory,
} from "../src/server/mail/imap";
import { MailProviderRegistry, toCanonicalObservation } from "../src/server/mail/provider";
import { MailSenderRegistry } from "../src/server/mail/sender";
import { Store } from "../src/server/db/store";
import { canonicalConversationSchema, type Draft, type MessageRef } from "../src/shared/contracts";
import { PostreeveService } from "../src/server/core/postreeve";
import { CredentialVault } from "../src/server/security/credentials";
import { createApi } from "../src/server/api";
import { repeatedIdentification } from "./fixtures/repeated-identification";
import { buildProviderDraftMessage } from "../src/server/mail/provider-draft";

interface StoredMailbox {
  path: string;
  name: string;
  uidValidity: bigint;
  readonly specialUse?: string;
  readonly flags?: Set<string>;
  nextUid: number;
  readonly messages: Map<number, FetchMessageObject>;
}

interface FakeState {
  readonly mailboxes: Map<string, StoredMailbox>;
  readonly options: ImapFlowOptions[];
  readonly storeOptions: StoreOptions[];
  readonly flagAdds: Array<{ uid: number; flags: string[]; options: StoreOptions }>;
  readonly messageDeletes: Array<{ uids: number[]; options: { uid?: boolean } }>;
  readonly searches: SearchObject[];
  readonly searchOptions: Array<{ uid?: boolean; returnOptions: Array<"MIN" | "MAX" | "COUNT" | "ALL" | { partial: string }> }>;
  readonly fetchQueries: FetchQueryObject[];
  eSearchAll?: string;
  lists: number;
  mailboxOpens: number;
  onMailboxOpen?: (mailbox: StoredMailbox, count: number) => void;
  ambiguousAppendFailures: number;
  readonly messageDeleteFalse: Map<number, "present" | "absent">;
  readonly messageDeleteSuccessWithoutRemoval: Set<number>;
  readonly omittedDraftSearchUids: Set<number>;
  readonly omittedFetchUids: Set<number>;
  readonly fetchWithoutFlags: Set<number>;
  readonly fetchWithoutHeaders: Set<number>;
  readonly fetchOneFailures: Map<number, Error>;
  readonly fetchOneFalse: Set<number>;
  readonly exactUidSearchFailures: Set<number>;
  broadSearchFailures: number;
  readonly messageFlagAddFalseWithUnreadableUid: Set<number>;
}

const config = {
  accountId: "account-a",
  host: "imap.example.test",
  port: 993,
  secure: true,
  username: "human@example.test",
  password: "not-logged",
};
const draftScope = { tenantId: "tenant-a", accountId: config.accountId };

describe("Bun IMAP compatibility", () => {
  test("verifies authentication with a folder list and no mailbox mutation", async () => {
    const state = fakeState();
    await new ImapMailProvider(config, fakeFactory(state)).verifyConnection();
    expect(state.lists).toBe(1);
    expect(state.searches).toEqual([]);
  });

  test("imports ImapFlow and MailParser and parses messages through the adapter", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));

    const page = await provider.listMessagePage(config.accountId, "INBOX", 2);
    const summaries = page.messages;
    expect(page.complete).toBe(false);
    expect((await provider.listMessagePage(config.accountId, "INBOX", 3)).complete).toBe(true);
    expect(summaries.map((message) => message.ref.uid)).toEqual([3, 2]);
    expect(summaries[0]?.preview).toBe("Newest plain text body");
    expect(summaries[0]?.replyTo).toEqual([{ name: "Replies", address: "replies@example.test" }]);
    expect(summaries[0]?.inReplyTo).toBe("<parent@example.test>");
    expect(summaries[0]?.references).toEqual(["<root@example.test>", "<parent@example.test>"]);
    expect(summaries[0]?.ref).toEqual({
      accountId: config.accountId,
      mailbox: "INBOX",
      uidValidity: "101",
      uid: 3,
      modseq: "13",
    });

    const reference = summaries[0]?.ref;
    if (!reference) throw new Error("Expected a message reference");
    const details = await provider.readMessages(config.accountId, [reference]);
    expect(details[0]?.subject).toBe("Newest message");
    expect(details[0]?.replyTo).toEqual([{ name: "Replies", address: "replies@example.test" }]);
    expect(details[0]?.text.trim()).toBe("Newest plain text body");
    expect(details[0]?.html).toContain("https://tracker.example.test/pixel.png");
    expect(details[0]?.html).toContain("data:image/png;base64,");

    const plainTextReference = summaries.find((message) => message.ref.uid === 2)?.ref;
    if (!plainTextReference) throw new Error("Expected a plain-text message reference");
    const plainTextDetails = await provider.readMessages(config.accountId, [plainTextReference]);
    expect(plainTextDetails[0]?.html).toBeNull();

    expect(state.options[0]).toMatchObject({
      host: config.host,
      port: config.port,
      secure: true,
      auth: { user: config.username, pass: config.password },
      logger: false,
      qresync: true,
    });
  });

  test("retains multiple In-Reply-To parents from envelopes and parsed-header fallback", async () => {
    const state = fakeState();
    const inbox = state.mailboxes.get("INBOX");
    if (!inbox) throw new Error("Expected test inbox");
    const raw = (uid: number) => Buffer.from([
      "From: Sender <sender@example.test>",
      "To: Human <human@example.test>",
      `Message-ID: <message-${uid}@example.test>`,
      "In-Reply-To: (ignore <fake@example.test>) <parent-a@example.test> <parent-b@example.test>",
      `Subject: Message ${uid}`,
      "Date: Fri, 29 Aug 2025 12:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body",
    ].join("\r\n"));
    const envelopeMessage = fakeMessage(1, 1n, "Envelope", "Body", new Set());
    const fallbackMessage = fakeMessage(2, 2n, "Fallback", "Body", new Set());
    inbox.messages.clear();
    inbox.messages.set(1, { ...envelopeMessage, envelope: {
      ...envelopeMessage.envelope,
      inReplyTo: "<parent-a@example.test> <parent-b@example.test>",
    }, source: raw(1) });
    const { inReplyTo: _inReplyTo, ...fallbackEnvelope } = fallbackMessage.envelope!;
    inbox.messages.set(2, { ...fallbackMessage, envelope: fallbackEnvelope, source: raw(2) });

    const provider = new ImapMailProvider(config, fakeFactory(state));
    const summaries = await provider.listMessages(config.accountId, "INBOX", 2);
    expect(summaries.map(({ inReplyTo }) => inReplyTo))
      .toEqual([
        "(ignore <fake@example.test>) <parent-a@example.test> <parent-b@example.test>",
        "(ignore <fake@example.test>) <parent-a@example.test> <parent-b@example.test>",
      ]);
    expect(summaries.map((message) => toCanonicalObservation("tenant-a", "imap", message).inReplyTo))
      .toEqual([
        "<parent-a@example.test> <parent-b@example.test>",
        "<parent-a@example.test> <parent-b@example.test>",
      ]);
    const details = await provider.readMessages(config.accountId, summaries.map(({ ref }) => ref));
    expect(details.map(({ inReplyTo }) => inReplyTo))
      .toEqual([
        "(ignore <fake@example.test>) <parent-a@example.test> <parent-b@example.test>",
        "(ignore <fake@example.test>) <parent-a@example.test> <parent-b@example.test>",
      ]);
  });

  test("fetches complete threading headers while keeping IMAP summary source bounded", async () => {
    const state = fakeState();
    const inbox = state.mailboxes.get("INBOX");
    if (!inbox) throw new Error("Expected test inbox");
    const message = fakeMessage(1, 1n, "Oversized headers", "Body", new Set());
    const paddingHeader = [
      `X-Padding: ${"x".repeat(980)}`,
      ...Array.from({ length: 73 }, () => ` ${"x".repeat(980)}`),
    ];
    inbox.messages.clear();
    inbox.messages.set(1, { ...message, source: Buffer.from([
      "From: Sender <sender@example.test>",
      "To: Human <human@example.test>",
      "Message-ID: <oversized@example.test>",
      ...paddingHeader,
      'References: (ignore <fake@example.test>) <root@example.test> <"a>b<c"@Example.Test> <root@example.test>',
      "Subject: Oversized headers",
      "Date: Fri, 29 Aug 2025 12:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body",
    ].join("\r\n")) });

    const provider = new ImapMailProvider(config, fakeFactory(state));
    const [listed] = await provider.listMessages(config.accountId, "INBOX", 1);
    const [searched] = await provider.searchMessages(config.accountId, "INBOX", "oversized", 1);

    expect(listed?.references).toEqual(["<root@example.test>", '<"a>b<c"@example.test>']);
    expect(searched?.references).toEqual(listed?.references);
    expect(listed?.preview.length).toBeLessThanOrEqual(240);
    expect(state.fetchQueries.filter(({ headers }) => Array.isArray(headers)).map(({ headers }) => headers))
      .toEqual([
        ["Message-ID", "In-Reply-To", "References"],
        ["Message-ID", "In-Reply-To", "References"],
      ]);
    expect(state.fetchQueries.filter(({ source }) => typeof source === "object")
      .every(({ source }) => typeof source === "object" && source.maxLength === 64 * 1024)).toBe(true);
  });

  test("keeps repeated raw IMAP fields stable through reread and the public conversation API", async () => {
    const state = fakeState();
    const inbox = state.mailboxes.get("INBOX");
    if (!inbox) throw new Error("Expected test inbox");
    inbox.messages.clear();
    for (const uid of [1, 2, 3]) {
      const message = fakeMessage(uid, BigInt(uid), "Thread", "Body", new Set());
      const parentId = uid === 1 ? "parent-a" : "parent-b";
      const { inReplyTo: _existing, ...envelope } = message.envelope!;
      inbox.messages.set(uid, {
        ...message,
        envelope,
        source: Buffer.from(uid === 3 ? repeatedIdentification.raw : [
          "From: Sender <sender@example.test>",
          "To: Human <human@example.test>",
          `Message-ID: <${parentId}@example.test>`,
          "Subject: Thread",
          "Date: Fri, 29 Aug 2025 12:00:00 +0000",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "Body",
        ].join("\r\n")),
      });
    }
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const providerSummaries = await provider.listMessages(config.accountId, "INBOX", 50);
    const childSummary = providerSummaries.find(({ ref }) => ref.uid === 3);
    if (!childSummary) throw new Error("Expected IMAP child summary");
    const [childDetail] = await provider.readMessages(config.accountId, [childSummary.ref]);
    if (!childDetail) throw new Error("Expected IMAP child detail");
    expect(toCanonicalObservation("tenant-a", "imap", childSummary)).toMatchObject({
      messageId: repeatedIdentification.normalizedMessageId,
      inReplyTo: repeatedIdentification.normalizedInReplyTo,
      references: repeatedIdentification.normalizedReferences,
      referenceSequences: [
        ["<branch-a@example.test>", "<root@example.test>"],
        ["<branch-b@example.test>", "<root@example.test>"],
      ],
    });
    expect(toCanonicalObservation("tenant-a", "imap", childDetail)).toMatchObject({
      messageId: repeatedIdentification.normalizedMessageId,
      inReplyTo: repeatedIdentification.normalizedInReplyTo,
      references: repeatedIdentification.normalizedReferences,
    });
    const providers = new MailProviderRegistry();
    providers.register(config.accountId, provider);
    const store = new Store(":memory:");
    try {
      await store.insertAccount({
        id: config.accountId, name: "IMAP", email: config.username, kind: "imap", encryptedCredentials: null,
      });
      const unavailable = () => {
        throw new Error("Factory is not used by this fixture");
      };
      const service = new PostreeveService(
        store,
        { tenantId: "tenant-a" },
        providers,
        new MailSenderRegistry(),
        new CredentialVault(Buffer.alloc(32, 7).toString("base64")),
        unavailable,
        unavailable,
      );
      const listed = await service.listMessages({ accountId: config.accountId, mailbox: "INBOX", limit: 50 });
      await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: config.accountId, provider: "imap", mailbox: "INBOX", authoritative: false,
        observations: ["branch-a", "branch-b", "root"].map((name, index) => ({
          tenantId: "tenant-a", messageId: `<${name}@example.test>`, inReplyTo: null, references: [],
          receivedAt: `2026-09-0${3 - index}T00:00:00.000Z`,
          location: { accountId: config.accountId, provider: "imap" as const, mailbox: "INBOX", uidValidity: "1",
            uid: 20 + index, modseq: null, providerId: null, read: false, flagged: false },
        })),
      });
      const response = await createApi(service).request(`/api/conversations/${listed[0]!.conversationId}`);
      const conversation = canonicalConversationSchema.parse(await response.json());

      expect(response.status).toBe(200);
      const messageIds = conversation.messages.map(({ messageId }) => messageId);
      expect(messageIds.indexOf("<branch-a@example.test>")).toBeLessThan(messageIds.indexOf("<root@example.test>"));
      expect(messageIds.indexOf("<branch-b@example.test>")).toBeLessThan(messageIds.indexOf("<root@example.test>"));
      expect(messageIds.indexOf("<root@example.test>")).toBeLessThan(
        messageIds.indexOf(repeatedIdentification.normalizedMessageId));
      expect(conversation.messages.find(({ messageId }) => messageId === repeatedIdentification.normalizedMessageId))
        .toMatchObject({
        inReplyTo: repeatedIdentification.normalizedInReplyTo,
        references: ["<branch-a@example.test>", "<branch-b@example.test>", "<root@example.test>"],
      });
    } finally {
      store.close();
    }
  });

  test("keeps missing and malformed IMAP dates out of canonical ordering", async () => {
    const state = fakeState();
    const inbox = state.mailboxes.get("INBOX");
    if (!inbox) throw new Error("Expected test inbox");
    const undatedSource = (uid: number, date?: string) => Buffer.from([
      "From: Sender <sender@example.test>",
      "To: Human <human@example.test>",
      `Message-ID: <undated-${uid}@example.test>`,
      `Subject: Undated ${uid}`,
      ...(date ? [`Date: ${date}`] : []),
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Body",
    ].join("\r\n"));
    const missing = fakeMessage(1, 1n, "Missing", "Body", new Set());
    const malformed = fakeMessage(2, 2n, "Malformed", "Body", new Set());
    const epoch = fakeMessage(3, 3n, "Epoch", "Body", new Set());
    const { internalDate: _missingInternalDate, ...missingWithoutInternalDate } = missing;
    inbox.messages.clear();
    inbox.messages.set(1, { ...missingWithoutInternalDate, source: undatedSource(1) });
    inbox.messages.set(2, {
      ...malformed,
      internalDate: "not-a-time",
      envelope: { ...malformed.envelope, date: new Date("not-a-time") },
      source: undatedSource(2, "not-a-date"),
    });
    inbox.messages.set(3, { ...epoch, internalDate: new Date(0), source: undatedSource(3) });

    const messages = await new ImapMailProvider(config, fakeFactory(state)).listMessages(config.accountId, "INBOX", 3);
    const byUid = new Map(messages.map((message) => [message.ref.uid, message]));
    expect(toCanonicalObservation("tenant-a", "imap", byUid.get(1)!).receivedAt).toBeNull();
    expect(toCanonicalObservation("tenant-a", "imap", byUid.get(2)!).receivedAt).toBeNull();
    expect(toCanonicalObservation("tenant-a", "imap", byUid.get(3)!).receivedAt)
      .toBe("1970-01-01T00:00:00.000Z");
    expect(messages.every(({ receivedAt }) => receivedAt === "1970-01-01T00:00:00.000Z")).toBe(true);

    const store = new Store(":memory:");
    try {
      await store.insertAccount({
        id: config.accountId, name: "IMAP", email: config.username, kind: "imap", encryptedCredentials: null,
      });
      const stored = await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: config.accountId, provider: "imap", mailbox: "INBOX", authoritative: false,
        observations: messages.map((message) => toCanonicalObservation("tenant-a", "imap", message)),
      });
      expect(new Map(stored.map(({ messageId, receivedAt }) => [messageId, receivedAt]))).toEqual(new Map([
        ["<undated-1@example.test>", null],
        ["<undated-2@example.test>", null],
        ["<undated-3@example.test>", "1970-01-01T00:00:00.000Z"],
      ]));
    } finally {
      store.close();
    }
  });

  test("discovers selectable special-use folders and keeps accounts isolated", async () => {
    const provider = new ImapMailProvider(config, fakeFactory(fakeState()));
    const folders = await provider.listFolders(config.accountId);

    expect(folders).toEqual([
      { path: "INBOX", name: "Inbox", specialUse: "inbox", unread: 2, total: 3 },
      { path: "Archive", name: "Archive", specialUse: "archive", unread: 0, total: 0 },
      { path: "Bin", name: "Bin", specialUse: "trash", unread: 0, total: 0 },
      { path: "Drafts", name: "Drafts", specialUse: "drafts", unread: 0, total: 0 },
    ]);
    expect(provider.listFolders("account-b")).rejects.toThrow("cannot access account account-b");
  });

  test("creates, updates, lists, and safely removes marked drafts in the special-use mailbox", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const first = providerDraft(1, { to: "unfinished@, Person <person@example.test>", body: "First body" });
    state.ambiguousAppendFailures = 3;

    const firstRef = await provider.createDraft(draftScope, first);
    expect(firstRef).toMatchObject({ kind: "imap", mailbox: "Drafts", uidValidity: "505" });
    const updated = providerDraft(2, {
      to: "unfinished@, Person <person@example.test>",
      subject: "Updated",
      body: "Second body",
    });
    const updatedRef = await provider.updateDraft(draftScope, updated, firstRef);
    await provider.updateDraft(draftScope, updated, updatedRef);
    const listed = await provider.listDrafts(draftScope);
    expect(listed).toEqual([{
      tenantId: "tenant-a", accountId: config.accountId, postreeveId: updated.id, version: 2,
      ref: expect.objectContaining({ kind: "imap", mailbox: "Drafts" }),
    }]);
    const draftsMailbox = state.mailboxes.get("Drafts");
    if (!draftsMailbox) throw new Error("Expected special-use Drafts mailbox");
    expect(draftsMailbox.messages.size).toBe(1);
    const mirrored = [...draftsMailbox.messages.values()][0];
    expect(mirrored?.flags).toContain("\\Draft");
    expect(mirrored?.source?.toString()).toContain("To: <unfinished@>, Person <person@example.test>");
    if (!mirrored?.source) throw new Error("Expected mirrored draft source");
    expect((await simpleParser(mirrored.source)).text).toBe("Second body");
    await expect(provider.updateDraft({ ...draftScope, accountId: "account-b" }, updated, updatedRef))
      .rejects.toThrow("cannot access account account-b");
    await expect(provider.removeDraft({ ...draftScope, accountId: "account-b" }, updated.id, updatedRef))
      .rejects.toThrow("cannot access account account-b");

    const unrelated = fakeMessage(900, 1n, "Unrelated deleted message", "Keep", new Set(["\\Deleted"]));
    draftsMailbox.messages.set(900, unrelated);
    await provider.removeDraft(draftScope, updated.id, updatedRef);
    await provider.removeDraft(draftScope, updated.id, updatedRef);
    expect(draftsMailbox.messages.has(900)).toBe(true);
    expect(await provider.listDrafts(draftScope)).toEqual([]);
    await expect(provider.createDraft({ ...draftScope, accountId: "account-b" }, first))
      .rejects.toThrow("cannot access account account-b");
    await expect(provider.createDraft(draftScope, { ...first, accountId: "account-b" }))
      .rejects.toThrow("cannot access account account-b");
  });

  test("keeps same-id drafts isolated between accounts sharing an IMAP mailbox", async () => {
    const state = fakeState();
    const draftsMailbox = state.mailboxes.get("Drafts");
    if (!draftsMailbox) throw new Error("Expected special-use Drafts mailbox");
    const unscopedSource = Buffer.from(
      `X-Postreeve-Draft-ID: ${Buffer.from("imap-postreeve-draft").toString("base64url")}\r\nX-Postreeve-Draft-Version: 1\r\n\r\n`,
    );
    draftsMailbox.messages.set(900, {
      ...fakeMessage(900, 1n, "Legacy unscoped draft", "Keep", new Set(["\\Draft"])),
      source: unscopedSource,
      headers: unscopedSource,
    });
    const otherConfig = { ...config, accountId: "account-b" };
    const firstProvider = new ImapMailProvider(config, fakeFactory(state));
    const secondProvider = new ImapMailProvider(otherConfig, fakeFactory(state));
    const firstDraft = providerDraft(1);
    const secondDraft = providerDraft(1, {
      accountId: otherConfig.accountId,
      identity: { name: "Human", address: otherConfig.username },
    });

    const firstRef = await firstProvider.createDraft(draftScope, firstDraft);
    const secondScope = { tenantId: "tenant-a", accountId: otherConfig.accountId };
    const secondRef = await secondProvider.createDraft(secondScope, secondDraft);
    expect(await firstProvider.listDrafts(draftScope)).toEqual([
      { tenantId: "tenant-a", accountId: config.accountId, postreeveId: firstDraft.id, version: 1, ref: firstRef },
    ]);
    expect(await secondProvider.listDrafts(secondScope)).toEqual([
      { tenantId: "tenant-a", accountId: otherConfig.accountId, postreeveId: secondDraft.id, version: 1, ref: secondRef },
    ]);

    const updatedFirst = providerDraft(2, { body: "First account update" });
    const updatedRef = await firstProvider.updateDraft(draftScope, updatedFirst, secondRef);
    await firstProvider.removeDraft(draftScope, firstDraft.id, secondRef);

    expect(await firstProvider.listDrafts(draftScope)).toEqual([]);
    expect(await secondProvider.listDrafts(secondScope)).toEqual([
      { tenantId: "tenant-a", accountId: otherConfig.accountId, postreeveId: secondDraft.id, version: 1, ref: secondRef },
    ]);
    expect(draftsMailbox.messages.has(900)).toBe(true);
    expect(state.messageDeletes.flatMap(({ uids }) => uids).includes(secondRef.kind === "imap" ? secondRef.uid : 0)).toBe(false);
    expect(state.messageDeletes.flatMap(({ uids }) => uids).includes(updatedRef.kind === "imap" ? updatedRef.uid : 0)).toBe(true);
  });

  test("keeps same-account same-id drafts isolated between trusted tenants", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const secondScope = { tenantId: "tenant-b", accountId: config.accountId };
    const first = providerDraft(1, { body: "Tenant A" });
    const second = providerDraft(1, { body: "Tenant B" });

    const firstRef = await provider.createDraft(draftScope, first);
    const secondRef = await provider.createDraft(secondScope, second);
    expect(firstRef).not.toEqual(secondRef);
    expect(await provider.listDrafts(draftScope)).toEqual([{
      tenantId: "tenant-a", accountId: config.accountId, postreeveId: first.id, version: 1, ref: firstRef,
    }]);
    expect(await provider.listDrafts(secondScope)).toEqual([{
      tenantId: "tenant-b", accountId: config.accountId, postreeveId: second.id, version: 1, ref: secondRef,
    }]);

    await provider.updateDraft(draftScope, { ...first, version: 2, body: "Tenant A updated" }, secondRef);
    expect(await provider.listDrafts(secondScope)).toEqual([{
      tenantId: "tenant-b", accountId: config.accountId, postreeveId: second.id, version: 1, ref: secondRef,
    }]);
    await provider.removeDraft(draftScope, first.id, secondRef);
    expect(await provider.listDrafts(draftScope)).toEqual([]);
    expect(await provider.listDrafts(secondScope)).toHaveLength(1);
  });

  test("resolves an omitted exact IMAP ref and rejects uncertain lookup without touching foreign drafts", async () => {
    const state = fakeState();
    const drafts = state.mailboxes.get("Drafts");
    if (!drafts) throw new Error("Expected special-use Drafts mailbox");
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const owned = providerDraft(1);
    const ownedRef = await provider.createDraft(draftScope, owned);
    if (ownedRef.kind !== "imap") throw new Error("Expected IMAP ref");
    state.omittedDraftSearchUids.add(ownedRef.uid);

    const sources = new Map<number, Buffer>([
      [2, await buildProviderDraftMessage(draftScope, { ...owned, id: "different-draft" })],
      [3, Buffer.from([
        `X-Postreeve-Draft-Account-ID: ${Buffer.from(config.accountId).toString("base64url")}`,
        `X-Postreeve-Draft-ID: ${Buffer.from(owned.id).toString("base64url")}`,
        "X-Postreeve-Draft-Version: 1",
        "",
        "",
      ].join("\r\n"))],
      [4, await buildProviderDraftMessage({ tenantId: "tenant-b", accountId: config.accountId }, owned)],
      [5, await buildProviderDraftMessage(draftScope, owned)],
      [6, await buildProviderDraftMessage(draftScope, owned)],
    ]);
    for (const [uid, source] of sources) {
      drafts.messages.set(uid, {
        ...fakeMessage(uid, BigInt(uid), "Provider draft", "Body", new Set(["\\Draft", ...(uid === 6 ? ["\\Deleted"] : [])])),
        source,
      });
      state.omittedDraftSearchUids.add(uid);
    }
    drafts.nextUid = 7;
    state.fetchOneFailures.set(5, new Error("exact fetch unavailable"));

    await provider.removeDraft(draftScope, owned.id, ownedRef);
    await provider.removeDraft(draftScope, owned.id, { ...ownedRef, uid: 999 });
    await provider.removeDraft(draftScope, owned.id, { ...ownedRef, uid: 2 });
    await provider.removeDraft(draftScope, owned.id, { ...ownedRef, uid: 3 });
    await provider.removeDraft(draftScope, owned.id, { ...ownedRef, uid: 4 });
    await provider.removeDraft(draftScope, owned.id, { ...ownedRef, uid: 6 });
    await expect(provider.removeDraft(draftScope, owned.id, { ...ownedRef, uid: 5 }))
      .rejects.toThrow("exact fetch unavailable");
    expect([...drafts.messages.keys()].sort((left, right) => left - right)).toEqual([2, 3, 4, 5]);
    expect(state.messageDeletes.map(({ uids }) => uids)).toEqual([[ownedRef.uid], [6]]);
  });

  test("replaces an omitted exact IMAP ref and fails uncertain lookup before appending", async () => {
    const state = fakeState();
    const drafts = state.mailboxes.get("Drafts");
    if (!drafts) throw new Error("Expected special-use Drafts mailbox");
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const original = providerDraft(1, { body: "Original body" });
    const originalRef = await provider.createDraft(draftScope, original);
    if (originalRef.kind !== "imap") throw new Error("Expected IMAP ref");
    state.omittedDraftSearchUids.add(originalRef.uid);

    const updated = providerDraft(2, { body: "Updated body" });
    const updatedRef = await provider.updateDraft(draftScope, updated, originalRef);
    if (updatedRef.kind !== "imap") throw new Error("Expected IMAP ref");
    expect(updatedRef.uid).not.toBe(originalRef.uid);
    expect([...drafts.messages.values()].filter((message) =>
      message.flags?.has("\\Draft") && !message.flags.has("\\Deleted"))).toHaveLength(1);
    expect(drafts.messages.has(originalRef.uid)).toBe(false);

    state.omittedDraftSearchUids.add(updatedRef.uid);
    state.fetchOneFailures.set(updatedRef.uid, new Error("exact fetch unavailable"));
    const nextUid = drafts.nextUid;
    await expect(provider.updateDraft(draftScope, providerDraft(3), updatedRef))
      .rejects.toThrow("exact fetch unavailable");
    expect(drafts.nextUid).toBe(nextUid);
    expect(drafts.messages.has(updatedRef.uid)).toBe(true);

    state.fetchOneFailures.delete(updatedRef.uid);
    state.fetchOneFalse.add(updatedRef.uid);
    state.exactUidSearchFailures.add(updatedRef.uid);
    await expect(provider.updateDraft(draftScope, providerDraft(3), updatedRef))
      .rejects.toThrow(`could not confirm whether draft UID ${updatedRef.uid} exists`);
    expect(drafts.nextUid).toBe(nextUid);
  });

  test("never carries replacement UIDs into a new Drafts UIDVALIDITY generation", async () => {
    for (const uidplus of [true, false]) {
      const state = fakeState();
      const drafts = state.mailboxes.get("Drafts");
      if (!drafts) throw new Error("Expected special-use Drafts mailbox");
      const factory: ImapClientFactory = (options) => {
        state.options.push(options);
        const client = new FakeImapClient(state);
        if (!uidplus) client.capabilities.delete("UIDPLUS");
        return client;
      };
      const provider = new ImapMailProvider(config, factory);
      const original = providerDraft(1, { body: "Original generation" });
      const originalRef = await provider.createDraft(draftScope, original);
      if (originalRef.kind !== "imap") throw new Error("Expected IMAP ref");
      const foreignSource = await buildProviderDraftMessage(
        { tenantId: "tenant-b", accountId: config.accountId },
        { ...original, body: "Foreign generation" },
      );
      state.onMailboxOpen = (mailbox, count) => {
        if (count !== 3) return;
        mailbox.uidValidity = 506n;
        mailbox.messages.set(originalRef.uid, {
          ...fakeMessage(originalRef.uid, 9n, "Foreign draft", "Keep", new Set(["\\Draft"])),
          source: foreignSource,
        });
      };

      const updatedRef = await provider.updateDraft(
        draftScope,
        providerDraft(2, { body: "Current generation" }),
        originalRef,
      );

      expect(updatedRef).toMatchObject({ kind: "imap", uidValidity: "506", uid: 2 });
      expect(drafts.messages.get(originalRef.uid)?.flags).toEqual(new Set(["\\Draft"]));
      expect(state.messageDeletes.flatMap(({ uids }) => uids)).not.toContain(originalRef.uid);
      expect(state.flagAdds.map(({ uid }) => uid)).not.toContain(originalRef.uid);
    }
  });

  test("marks only an omitted exact owned UID deleted without UIDPLUS", async () => {
    const state = fakeState();
    const drafts = state.mailboxes.get("Drafts");
    if (!drafts) throw new Error("Expected special-use Drafts mailbox");
    const factory: ImapClientFactory = (options) => {
      state.options.push(options);
      const client = new FakeImapClient(state);
      client.capabilities.delete("UIDPLUS");
      return client;
    };
    const provider = new ImapMailProvider(config, factory);
    const draft = providerDraft(1);
    const ref = await provider.createDraft(draftScope, draft);
    if (ref.kind !== "imap") throw new Error("Expected IMAP ref");
    state.omittedDraftSearchUids.add(ref.uid);

    await provider.removeDraft(draftScope, draft.id, ref);
    await provider.removeDraft(draftScope, draft.id, ref);

    expect(state.flagAdds).toEqual([{ uid: ref.uid, flags: ["\\Deleted"], options: { uid: true } }]);
    expect(state.messageDeletes).toEqual([]);
    expect(drafts.messages.get(ref.uid)?.flags).toContain("\\Deleted");
  });

  test("rejects failed broad draft discovery without acknowledging provider removal", async () => {
    const state = fakeState();
    const drafts = state.mailboxes.get("Drafts");
    if (!drafts) throw new Error("Expected special-use Drafts mailbox");
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const draft = providerDraft(1);
    const ref = await provider.createDraft(draftScope, draft);
    state.broadSearchFailures = 1;

    await expect(provider.removeDraft(draftScope, draft.id, ref))
      .rejects.toThrow("could not complete the UID search");
    expect(drafts.messages.size).toBe(1);
    expect(state.messageDeletes).toEqual([]);
    expect(state.flagAdds).toEqual([]);
  });

  test("rejects incomplete draft discovery without acknowledging provider removal", async () => {
    const state = fakeState();
    const drafts = state.mailboxes.get("Drafts");
    if (!drafts) throw new Error("Expected special-use Drafts mailbox");
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const draft = providerDraft(1);
    const ref = await provider.createDraft(draftScope, draft);
    if (ref.kind !== "imap") throw new Error("Expected IMAP ref");
    state.omittedFetchUids.add(ref.uid);

    await expect(provider.removeDraft(draftScope, draft.id, ref))
      .rejects.toThrow("did not return every selected provider draft");
    expect(drafts.messages.has(ref.uid)).toBe(true);
    expect(state.messageDeletes).toEqual([]);
    expect(state.flagAdds).toEqual([]);
  });

  test("rejects incomplete exact draft data before mutation", async () => {
    for (const missing of ["flags", "headers"] as const) {
      const state = fakeState();
      const drafts = state.mailboxes.get("Drafts");
      if (!drafts) throw new Error("Expected special-use Drafts mailbox");
      const provider = new ImapMailProvider(config, fakeFactory(state));
      const draft = providerDraft(1);
      const ref = await provider.createDraft(draftScope, draft);
      if (ref.kind !== "imap") throw new Error("Expected IMAP ref");
      state.omittedDraftSearchUids.add(ref.uid);
      state[missing === "flags" ? "fetchWithoutFlags" : "fetchWithoutHeaders"].add(ref.uid);

      await expect(provider.removeDraft(draftScope, draft.id, ref))
        .rejects.toThrow(`incomplete data while resolving draft UID ${ref.uid}`);
      expect(drafts.messages.has(ref.uid)).toBe(true);
      expect(state.messageDeletes).toEqual([]);
      expect(state.flagAdds).toEqual([]);
    }
  });

  test("accepts an explicit empty header result for an unmarked provider draft", async () => {
    const state = fakeState();
    const drafts = state.mailboxes.get("Drafts");
    if (!drafts) throw new Error("Expected special-use Drafts mailbox");
    const unmarked = fakeMessage(50, 50n, "Unmarked draft", "Body", new Set(["\\Draft"]));
    delete unmarked.source;
    unmarked.headers = Buffer.alloc(0);
    drafts.messages.set(unmarked.uid, unmarked);
    const provider = new ImapMailProvider(config, fakeFactory(state));

    expect(await provider.listDrafts(draftScope)).toEqual([]);
  });

  test("rejects an unreadable non-UIDPLUS flag failure while the exact UID still exists", async () => {
    const state = fakeState();
    const drafts = state.mailboxes.get("Drafts");
    if (!drafts) throw new Error("Expected special-use Drafts mailbox");
    const factory: ImapClientFactory = (options) => {
      state.options.push(options);
      const client = new FakeImapClient(state);
      client.capabilities.delete("UIDPLUS");
      return client;
    };
    const provider = new ImapMailProvider(config, factory);
    const draft = providerDraft(1);
    const ref = await provider.createDraft(draftScope, draft);
    if (ref.kind !== "imap") throw new Error("Expected IMAP ref");
    state.messageFlagAddFalseWithUnreadableUid.add(ref.uid);

    await expect(provider.removeDraft(draftScope, draft.id, ref))
      .rejects.toThrow(`did not confirm marking draft UID ${ref.uid} deleted`);
    expect(drafts.messages.has(ref.uid)).toBe(true);
    expect(drafts.messages.get(ref.uid)?.flags).not.toContain("\\Deleted");
    expect(state.messageDeletes).toEqual([]);
  });

  test("reconciles drafts without UIDPLUS by marking only managed UIDs deleted", async () => {
    const state = fakeState();
    const draftsMailbox = state.mailboxes.get("Drafts");
    if (!draftsMailbox) throw new Error("Expected special-use Drafts mailbox");
    const unrelated = fakeMessage(900, 7n, "Unrelated deleted message", "Keep", new Set(["\\Deleted"]));
    draftsMailbox.messages.set(900, unrelated);
    const factory: ImapClientFactory = (options) => {
      state.options.push(options);
      const client = new FakeImapClient(state);
      client.capabilities.delete("UIDPLUS");
      return client;
    };
    const provider = new ImapMailProvider(config, factory);
    state.ambiguousAppendFailures = 3;

    const first = providerDraft(1, { body: "First body" });
    const firstRef = await provider.createDraft(draftScope, first);
    const current = providerDraft(2, { body: "Current body" });
    const currentRef = await provider.updateDraft(draftScope, current, firstRef);
    const retriedRef = await provider.updateDraft(draftScope, current, currentRef);

    expect(await provider.listDrafts(draftScope)).toEqual([{
      tenantId: "tenant-a",
      accountId: config.accountId,
      postreeveId: current.id,
      version: 2,
      ref: retriedRef,
    }]);
    const activeManagedUids = [...draftsMailbox.messages.values()]
      .filter((message) => message.flags?.has("\\Draft") && !message.flags.has("\\Deleted"))
      .map(({ uid }) => uid);
    expect(activeManagedUids).toEqual([3]);
    expect(state.flagAdds).toEqual([
      { uid: 1, flags: ["\\Deleted"], options: { uid: true } },
      { uid: 2, flags: ["\\Deleted"], options: { uid: true } },
    ]);
    expect(state.messageDeletes).toEqual([]);
    expect(draftsMailbox.messages.get(900)).toMatchObject({ modseq: 7n, flags: new Set(["\\Deleted"]) });

    await provider.removeDraft(draftScope, current.id, retriedRef);
    await provider.removeDraft(draftScope, current.id, retriedRef);
    expect(await provider.listDrafts(draftScope)).toEqual([]);
    expect(state.flagAdds.slice(2)).toEqual([
      { uid: 3, flags: ["\\Deleted"], options: { uid: true } },
    ]);
    expect([...draftsMailbox.messages.keys()]).toEqual([900, 1, 2, 3]);
    expect(state.messageDeletes).toEqual([]);
    expect(draftsMailbox.messages.get(900)).toMatchObject({ modseq: 7n, flags: new Set(["\\Deleted"]) });
  });

  test("reports an unconfirmed UIDPLUS purge and selectively retires owned stale UIDs on retry", async () => {
    const state = fakeState();
    const draftsMailbox = state.mailboxes.get("Drafts");
    if (!draftsMailbox) throw new Error("Expected special-use Drafts mailbox");
    draftsMailbox.messages.set(900, fakeMessage(900, 7n, "Unrelated deleted", "Keep", new Set(["\\Deleted"])));
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const first = providerDraft(1);
    const firstRef = await provider.createDraft(draftScope, first);
    state.messageDeleteFalse.set(1, "present");

    const current = providerDraft(2, { body: "Current body" });
    await expect(provider.updateDraft(draftScope, current, firstRef))
      .rejects.toThrow("did not confirm selective removal of draft UID 1");
    expect(await provider.listDrafts(draftScope)).toEqual([
      { tenantId: "tenant-a", accountId: config.accountId, postreeveId: current.id, version: 2, ref: expect.objectContaining({ kind: "imap", uid: 2 }) },
    ]);
    expect(draftsMailbox.messages.get(1)?.flags).toContain("\\Deleted");
    expect(draftsMailbox.messages.has(900)).toBe(true);

    state.messageDeleteFalse.delete(1);
    const retried = await provider.updateDraft(draftScope, current, firstRef);
    expect(retried).toMatchObject({ kind: "imap", uid: 3 });
    expect(await provider.listDrafts(draftScope)).toEqual([
      { tenantId: "tenant-a", accountId: config.accountId, postreeveId: current.id, version: 2, ref: retried },
    ]);
    expect([...draftsMailbox.messages.keys()]).toEqual([900, 3]);
    expect(state.messageDeletes.flatMap(({ uids }) => uids)).toEqual([1, 2, 1]);
    expect(draftsMailbox.messages.get(900)).toMatchObject({ modseq: 7n, flags: new Set(["\\Deleted"]) });
  });

  test("rejects a truthy UIDPLUS result while the exact stale draft still exists", async () => {
    const state = fakeState();
    const drafts = state.mailboxes.get("Drafts");
    if (!drafts) throw new Error("Expected special-use Drafts mailbox");
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const first = providerDraft(1);
    const firstRef = await provider.createDraft(draftScope, first);
    if (firstRef.kind !== "imap") throw new Error("Expected IMAP ref");
    state.omittedDraftSearchUids.add(firstRef.uid);
    state.messageDeleteSuccessWithoutRemoval.add(firstRef.uid);

    await expect(provider.updateDraft(draftScope, providerDraft(2), firstRef))
      .rejects.toThrow(`did not confirm selective removal of draft UID ${firstRef.uid}`);
    expect([...drafts.messages.values()].filter((message) =>
      message.flags?.has("\\Draft") && !message.flags.has("\\Deleted"))).toHaveLength(2);
  });

  test("accepts a false UIDPLUS result when the exact owned UID is already absent", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const first = providerDraft(1);
    const firstRef = await provider.createDraft(draftScope, first);
    state.messageDeleteFalse.set(1, "absent");

    const current = providerDraft(2);
    await expect(provider.updateDraft(draftScope, current, firstRef)).resolves.toMatchObject({ kind: "imap", uid: 2 });
    expect(await provider.listDrafts(draftScope)).toEqual([
      { tenantId: "tenant-a", accountId: config.accountId, postreeveId: current.id, version: 2, ref: expect.objectContaining({ kind: "imap", uid: 2 }) },
    ]);
  });

  test("retains the backend IMAP reference after an unconfirmed purge and repairs it on read", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const providers = new MailProviderRegistry();
    providers.register(config.accountId, provider);
    const store = new Store(":memory:");
    await store.insertAccount({
      id: config.accountId,
      name: "Human",
      email: config.username,
      kind: "imap",
      encryptedCredentials: null,
    });
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
      accountId: config.accountId,
      mode: "new",
      to: "unfinished@",
      cc: "",
      bcc: "",
      subject: "Provider cleanup",
      body: "Version one",
      identity: { name: "Human", address: config.username },
      attachments: [],
    });
    if (created.mirror.status !== "synced" || created.mirror.ref.kind !== "imap") {
      throw new Error("Expected initial IMAP mirror");
    }
    state.messageDeleteFalse.set(created.mirror.ref.uid, "present");

    const failed = await service.updateDraft(config.accountId, created.id, {
      mode: created.mode,
      to: created.to,
      cc: created.cc,
      bcc: created.bcc,
      subject: created.subject,
      body: "Authoritative version two",
      identity: created.identity,
      attachments: created.attachments,
      version: created.version,
    });
    expect(failed).toMatchObject({
      version: 2,
      body: "Authoritative version two",
      mirror: { status: "failed", mirroredVersion: 1, ref: created.mirror.ref },
    });
    expect(await store.getDraft("tenant-a", config.accountId, created.id)).toEqual(failed);

    state.messageDeleteFalse.clear();
    const repaired = await service.getDraft(config.accountId, created.id);
    if (repaired.mirror.status !== "synced") throw new Error("Expected repaired IMAP mirror");
    expect(repaired).toMatchObject({ version: 2, body: "Authoritative version two", mirror: { status: "synced", mirroredVersion: 2 } });
    expect(await provider.listDrafts(draftScope)).toEqual([
      { tenantId: "tenant-a", accountId: config.accountId, postreeveId: repaired.id, version: 2, ref: repaired.mirror.ref },
    ]);
    store.close();
  });

  test("retains backend authority when UIDPLUS reports success but the exact draft survives", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const providers = new MailProviderRegistry();
    providers.register(config.accountId, provider);
    const store = new Store(":memory:");
    await store.insertAccount({
      id: config.accountId,
      name: "Human",
      email: config.username,
      kind: "imap",
      encryptedCredentials: null,
    });
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
      accountId: config.accountId,
      mode: "new",
      to: "unfinished@",
      cc: "",
      bcc: "",
      subject: "Provider cleanup",
      body: "Keep backend authority",
      identity: { name: "Human", address: config.username },
      attachments: [],
    });
    if (created.mirror.status !== "synced" || created.mirror.ref.kind !== "imap") {
      throw new Error("Expected initial IMAP mirror");
    }
    state.omittedDraftSearchUids.add(created.mirror.ref.uid);
    state.messageDeleteSuccessWithoutRemoval.add(created.mirror.ref.uid);

    await expect(service.removeDraft(config.accountId, created.id, { version: created.version }))
      .rejects.toThrow(`did not confirm selective removal of draft UID ${created.mirror.ref.uid}`);
    expect(await store.getDraft("tenant-a", config.accountId, created.id)).toMatchObject({
      id: created.id,
      body: "Keep backend authority",
      mirror: { status: "failed", ref: created.mirror.ref },
    });
    expect((await provider.listDrafts(draftScope))).toEqual([]);
    expect(state.mailboxes.get("Drafts")?.messages.has(created.mirror.ref.uid)).toBe(true);
    store.close();
  });

  test("manages custom folders without changing special-use mailboxes", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));

    await provider.createFolder(config.accountId, "Projects/Active");
    await provider.renameFolder(config.accountId, "Projects/Active", "Current");
    expect(state.mailboxes.has("Projects/Active")).toBe(false);
    expect(state.mailboxes.has("Projects/Current")).toBe(true);
    await expect(provider.renameFolder(config.accountId, "INBOX", "Incoming"))
      .rejects.toThrow("System and special-use folders cannot be changed");

    const custom = state.mailboxes.get("Projects/Current");
    if (!custom) throw new Error("Expected custom mailbox");
    custom.messages.set(1, fakeMessage(1, 1n, "Kept mail", "Keep me", new Set()));
    await expect(provider.deleteFolder(config.accountId, "Projects/Current"))
      .rejects.toThrow("Move every message out");
    custom.messages.clear();
    await provider.deleteFolder(config.accountId, "Projects/Current");
    expect(state.mailboxes.has("Projects/Current")).toBe(false);
  });

  test("uses server-side search and returns the newest matching UIDs", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));

    const messages = await provider.searchMessages(config.accountId, "INBOX", "newest", 1);
    expect(messages.map((message) => message.ref.uid)).toEqual([3]);
    expect(state.searches).toEqual([
      {
        or: [
          { subject: "newest" },
          { from: "newest" },
          { to: "newest" },
          { text: "newest" },
        ],
      },
    ]);
    expect(state.searchOptions).toEqual([{ uid: true, returnOptions: ["ALL"] }]);
  });

  test("uses ESEARCH RETURN ALL and parses compact UID ranges", async () => {
    const state = fakeState();
    const inbox = state.mailboxes.get("INBOX");
    if (!inbox) throw new Error("Expected test inbox");
    inbox.messages.clear();
    for (const uid of [8, 9, 101, 102]) {
      inbox.messages.set(uid, fakeMessage(uid, BigInt(uid), `Message ${uid}`, `Body ${uid}`, new Set()));
    }
    state.eSearchAll = "8:9,101:102";

    const messages = await new ImapMailProvider(config, fakeFactory(state)).listMessages(config.accountId, "INBOX", 3);

    expect(messages.map((message) => message.ref.uid)).toEqual([102, 101, 9]);
    expect(state.searchOptions).toEqual([{ uid: true, returnOptions: ["ALL"] }]);
  });

  test("keeps visible recipients separate from conservative delivery attribution", async () => {
    const state = fakeState();
    const inbox = state.mailboxes.get("INBOX");
    if (!inbox) throw new Error("Expected test inbox");
    inbox.messages.clear();
    inbox.messages.set(1, deliveryMessage(1, "Human <human@example.test>", "Delivered-To: human@example.test\r\n", "Copy <copy@example.test>"));
    inbox.messages.set(2, deliveryMessage(2, "Human <human@example.test>", "Delivered-To: catchall+sales@example.test\r\n"));
    inbox.messages.set(3, bccDeliveryMessage(3, "private@example.test"));
    inbox.messages.set(4, deliveryMessage(4, "Human <human@example.test>", "Delivered-To: Alias@Example.Test\r\nEnvelope-To: alias@example.test\r\nDelivered-To: alias@example.test\r\n"));
    inbox.messages.set(5, deliveryMessage(5, "Human <human@example.test>", "Delivered-To: not-an-address\r\nEnvelope-To: broken@@example.test\r\n"));
    inbox.messages.set(6, deliveryMessage(6, "Human <human@example.test>", ""));

    const messages = await new ImapMailProvider(config, fakeFactory(state)).listMessages(config.accountId, "INBOX", 6);
    const byUid = new Map(messages.map((message) => [message.ref.uid, message]));

    expect(byUid.get(1)?.to.map(({ address }) => address)).toEqual(["human@example.test"]);
    expect(byUid.get(1)?.cc?.map(({ address }) => address)).toEqual(["copy@example.test"]);
    expect(byUid.get(1)?.deliveredTo).toEqual(["human@example.test"]);
    expect(byUid.get(2)?.deliveredTo).toEqual(["catchall+sales@example.test"]);
    expect(byUid.get(3)?.to).toEqual([]);
    expect(byUid.get(3)?.deliveredTo).toEqual(["private@example.test"]);
    expect(byUid.get(4)?.deliveredTo).toEqual(["alias@example.test"]);
    expect(byUid.get(5)?.deliveredTo).toBeUndefined();
    expect(byUid.get(6)?.deliveredTo).toBeUndefined();
  });

  test("rejects stale UIDVALIDITY and MODSEQ before mutations", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const staleMailbox = messageRef({ uidValidity: "999" });
    const staleMessage = messageRef({ modseq: "999" });

    expect(await provider.revalidate(staleMailbox)).toBe(false);
    expect(await provider.revalidate(staleMessage)).toBe(false);
    expect(provider.apply(staleMessage, { type: "mark_read" })).rejects.toThrow("missing or stale");
    expect(state.mailboxes.get("INBOX")?.messages.get(3)?.flags?.has("\\Seen")).toBe(false);
  });

  test("applies and undoes read state without an incompatible conditional STORE", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const applied = await provider.apply(messageRef(), { type: "mark_read" });

    expect(applied.previousRead).toBe(false);
    expect(applied.current.modseq).toBe("14");
    expect(state.mailboxes.get("INBOX")?.messages.get(3)?.flags?.has("\\Seen")).toBe(true);
    expect(state.storeOptions).toEqual([{ uid: true }]);

    await provider.undo(applied);
    expect(state.mailboxes.get("INBOX")?.messages.get(3)?.flags?.has("\\Seen")).toBe(false);
    expect(state.storeOptions).toEqual([{ uid: true }, { uid: true }]);
  });

  test("moves to the discovered Trash mailbox and safely moves back on undo", async () => {
    const state = fakeState();
    const provider = new ImapMailProvider(config, fakeFactory(state));
    const applied = await provider.apply(messageRef(), { type: "trash" });

    expect(applied.current).toEqual({
      accountId: config.accountId,
      mailbox: "Bin",
      uidValidity: "303",
      uid: 30,
      modseq: "14",
    });
    expect(state.mailboxes.get("INBOX")?.messages.has(3)).toBe(false);
    expect(state.mailboxes.get("Bin")?.messages.has(30)).toBe(true);

    const reversed = await provider.undo(applied);
    expect(state.mailboxes.get("Bin")?.messages.has(30)).toBe(false);
    expect(state.mailboxes.get("INBOX")?.messages.size).toBe(3);
    expect(reversed).toEqual({
      previous: {
        accountId: config.accountId,
        mailbox: "Bin",
        uidValidity: "303",
        uid: 30,
        modseq: "14",
      },
      current: {
        accountId: config.accountId,
        mailbox: "INBOX",
        uidValidity: "101",
        uid: 4,
        modseq: null,
      },
    });
  });

  test("refuses an untraceable move before changing server state", async () => {
    const state = fakeState();
    const factory: ImapClientFactory = (options) => {
      state.options.push(options);
      const client = new FakeImapClient(state);
      client.capabilities.delete("UIDPLUS");
      return client;
    };
    const provider = new ImapMailProvider(config, factory);

    expect(provider.apply(messageRef(), { type: "move", destination: "Archive" })).rejects.toThrow("UIDPLUS");
    expect(state.mailboxes.get("INBOX")?.messages.has(3)).toBe(true);
    expect(state.mailboxes.get("Archive")?.messages.size).toBe(0);
  });
});

class FakeImapClient implements ImapClient {
  readonly capabilities = new Map<string, boolean | number>([["UIDPLUS", true]]);
  readonly #state: FakeState;
  #selected: StoredMailbox | undefined;

  constructor(state: FakeState) {
    this.#state = state;
  }

  async connect(): Promise<void> {}

  async logout(): Promise<void> {}

  close(): void {}

  async list(_options?: ListOptions): Promise<ListResponse[]> {
    this.#state.lists += 1;
    return [...this.#state.mailboxes.values()].map((mailbox) => ({
      path: mailbox.path,
      pathAsListed: mailbox.path,
      name: mailbox.name,
      delimiter: "/",
      parent: [],
      parentPath: "",
      flags: mailbox.flags ?? new Set<string>(),
      ...(mailbox.specialUse === undefined ? {} : { specialUse: mailbox.specialUse }),
      listed: true,
      subscribed: true,
      status: {
        path: mailbox.path,
        messages: mailbox.messages.size,
        unseen: [...mailbox.messages.values()].filter((message) => !message.flags?.has("\\Seen")).length,
        uidValidity: mailbox.uidValidity,
      },
    }));
  }

  async mailboxCreate(path: string | string[]): Promise<unknown> {
    const normalized = Array.isArray(path) ? path.join("/") : path;
    if (this.#state.mailboxes.has(normalized)) throw new Error(`Mailbox ${normalized} already exists`);
    this.#state.mailboxes.set(normalized, {
      path: normalized,
      name: normalized.split("/").at(-1) ?? normalized,
      uidValidity: BigInt(1_000 + this.#state.mailboxes.size),
      nextUid: 1,
      messages: new Map(),
    });
    return {};
  }

  async mailboxRename(path: string | string[], newPath: string | string[]): Promise<unknown> {
    const mailbox = this.#mailbox(path);
    const normalized = Array.isArray(newPath) ? newPath.join("/") : newPath;
    if (this.#state.mailboxes.has(normalized)) throw new Error(`Mailbox ${normalized} already exists`);
    this.#state.mailboxes.delete(mailbox.path);
    mailbox.path = normalized;
    mailbox.name = normalized.split("/").at(-1) ?? normalized;
    this.#state.mailboxes.set(normalized, mailbox);
    return {};
  }

  async mailboxDelete(path: string | string[]): Promise<unknown> {
    const mailbox = this.#mailbox(path);
    this.#state.mailboxes.delete(mailbox.path);
    if (this.#selected === mailbox) this.#selected = undefined;
    return {};
  }

  async mailboxOpen(path: string | string[], _options?: MailboxOpenOptions): Promise<MailboxObject> {
    const mailbox = this.#mailbox(path);
    this.#state.mailboxOpens += 1;
    this.#state.onMailboxOpen?.(mailbox, this.#state.mailboxOpens);
    this.#selected = mailbox;
    return mailboxObject(mailbox);
  }

  async status(path: string | string[], _query: { uidValidity?: boolean }): Promise<StatusObject> {
    const mailbox = this.#mailbox(path);
    return { path: mailbox.path, uidValidity: mailbox.uidValidity };
  }

  async search(
    query: SearchObject,
    options: { uid?: boolean; returnOptions: Array<"MIN" | "MAX" | "COUNT" | "ALL" | { partial: string }> },
  ): Promise<ESearchResult | number[] | false> {
    this.#state.searches.push(query);
    this.#state.searchOptions.push(options);
    const mailbox = this.#requireSelected();
    const messages = [...mailbox.messages.values()];
    if (query.uid === undefined && this.#state.broadSearchFailures > 0) {
      this.#state.broadSearchFailures -= 1;
      return false;
    }
    if (query.all) return { all: this.#state.eSearchAll ?? messages.map((message) => message.uid).join(",") };
    if (query.uid !== undefined) {
      const uid = Number(query.uid);
      if (this.#state.exactUidSearchFailures.has(uid)) return false;
      return mailbox.messages.has(uid) ? { all: uid.toString() } : {};
    }
    if (query.draft !== undefined || query.deleted !== undefined) {
      const matching = messages.filter((message) => {
        const flags = message.flags ?? new Set<string>();
        return !this.#state.omittedDraftSearchUids.has(message.uid)
          && (query.draft === undefined || flags.has("\\Draft") === query.draft)
          && (query.deleted === undefined || flags.has("\\Deleted") === query.deleted);
      });
      return { all: matching.map(({ uid }) => uid).join(",") };
    }
    const term = query.or?.flatMap((criterion) => [criterion.subject, criterion.from, criterion.to, criterion.text])
      .find((value) => value !== undefined)
      ?.toLowerCase();
    if (!term) return [];
    const matching = messages
      .filter((message) => {
        const source = message.source?.toString().toLowerCase() ?? "";
        return source.includes(term);
      })
      .map((message) => message.uid);
    return { all: matching.join(",") };
  }

  async *fetch(
    range: number[],
    query: FetchQueryObject,
    _options?: FetchOptions,
  ): AsyncIterableIterator<FetchMessageObject> {
    this.#state.fetchQueries.push(query);
    const mailbox = this.#requireSelected();
    for (const uid of range) {
      if (this.#state.omittedFetchUids.has(uid)) continue;
      const message = mailbox.messages.get(uid);
      if (message) yield this.#withFetchOmissions(fetchedMessage(message, query));
    }
  }

  async fetchOne(
    sequence: number,
    query: FetchQueryObject,
    _options?: FetchOptions,
  ): Promise<FetchMessageObject | false> {
    this.#state.fetchQueries.push(query);
    const failure = this.#state.fetchOneFailures.get(sequence);
    if (failure) throw failure;
    if (this.#state.fetchOneFalse.has(sequence)) return false;
    const message = this.#requireSelected().messages.get(sequence);
    return message ? this.#withFetchOmissions(fetchedMessage(message, query)) : false;
  }

  #withFetchOmissions(message: FetchMessageObject): FetchMessageObject {
    const result = { ...message };
    if (this.#state.fetchWithoutFlags.has(message.uid)) delete result.flags;
    if (this.#state.fetchWithoutHeaders.has(message.uid)) delete result.headers;
    return result;
  }

  async messageFlagsAdd(
    range: number,
    flags: string[],
    options?: StoreOptions,
  ): Promise<boolean> {
    this.#state.flagAdds.push({ uid: range, flags: [...flags], options: options ?? {} });
    if (this.#state.messageFlagAddFalseWithUnreadableUid.has(range)) {
      this.#state.fetchOneFalse.add(range);
      return false;
    }
    return this.#changeFlags(range, flags, true, options);
  }

  async messageFlagsRemove(
    range: number,
    flags: string[],
    options?: StoreOptions,
  ): Promise<boolean> {
    return this.#changeFlags(range, flags, false, options);
  }

  async messageMove(
    range: number,
    destination: string | string[],
    _options?: { uid?: boolean },
  ): Promise<CopyResponseObject | false> {
    const source = this.#requireSelected();
    const message = source.messages.get(range);
    if (!message) return false;
    const target = this.#mailbox(destination);
    const targetUid = target.nextUid++;
    source.messages.delete(range);
    target.messages.set(targetUid, {
      ...cloneMessage(message),
      uid: targetUid,
      modseq: (message.modseq ?? 0n) + 1n,
    });
    return {
      path: source.path,
      destination: target.path,
      uidValidity: target.uidValidity,
      uidMap: new Map([[range, targetUid]]),
    };
  }

  async messageDelete(range: number | number[], options?: { uid?: boolean }): Promise<boolean> {
    const mailbox = this.#requireSelected();
    const uids = Array.isArray(range) ? range : [range];
    this.#state.messageDeletes.push({ uids: [...uids], options: options ?? {} });
    const falseResult = uids.length === 1 ? this.#state.messageDeleteFalse.get(uids[0]!) : undefined;
    if (falseResult) {
      const uid = uids[0]!;
      const message = mailbox.messages.get(uid);
      if (falseResult === "absent") mailbox.messages.delete(uid);
      else if (message) message.flags = new Set([...(message.flags ?? []), "\\Deleted"]);
      return false;
    }
    if (uids.length === 1 && this.#state.messageDeleteSuccessWithoutRemoval.has(uids[0]!)) return true;
    let deleted = false;
    for (const uid of uids) deleted = mailbox.messages.delete(uid) || deleted;
    return deleted;
  }

  async append(
    path: string | string[],
    content: string | Buffer,
    flags: string[] = [],
    idate?: Date | string,
  ): Promise<AppendResponseObject | false> {
    const mailbox = this.#mailbox(path);
    const uid = mailbox.nextUid++;
    const source = Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content);
    mailbox.messages.set(uid, {
      seq: uid,
      uid,
      modseq: 1n,
      flags: new Set(flags),
      internalDate: idate ? new Date(idate) : new Date(),
      source,
      headers: selectedHeaders(source, [
        "X-Postreeve-Draft-Tenant-ID",
        "X-Postreeve-Draft-Account-ID",
        "X-Postreeve-Draft-ID",
        "X-Postreeve-Draft-Version",
      ]),
    });
    if (this.#state.ambiguousAppendFailures > 0) {
      this.#state.ambiguousAppendFailures -= 1;
      throw new Error("ambiguous APPEND response");
    }
    return this.capabilities.has("UIDPLUS")
      ? { destination: mailbox.path, uidValidity: mailbox.uidValidity, uid }
      : { destination: mailbox.path };
  }

  #changeFlags(range: number, flags: string[], add: boolean, options?: StoreOptions): boolean {
    this.#state.storeOptions.push(options ?? {});
    const message = this.#requireSelected().messages.get(range);
    if (!message) return false;
    if (options?.unchangedSince !== undefined && message.modseq !== options.unchangedSince) return false;
    const currentFlags = message.flags ?? new Set<string>();
    for (const flag of flags) {
      if (add) currentFlags.add(flag);
      else currentFlags.delete(flag);
    }
    message.flags = currentFlags;
    message.modseq = (message.modseq ?? 0n) + 1n;
    return true;
  }

  #mailbox(path: string | string[]): StoredMailbox {
    const normalized = Array.isArray(path) ? path.join("/") : path;
    const mailbox = this.#state.mailboxes.get(normalized);
    if (!mailbox) throw new Error(`No fake mailbox ${normalized}`);
    return mailbox;
  }

  #requireSelected(): StoredMailbox {
    if (!this.#selected) throw new Error("No mailbox selected");
    return this.#selected;
  }
}

function fakeFactory(state: FakeState): ImapClientFactory {
  return (options) => {
    state.options.push(options);
    return new FakeImapClient(state);
  };
}

function fakeState(): FakeState {
  const inboxMessages = new Map<number, FetchMessageObject>([
    [1, fakeMessage(1, 11n, "First message", "First body", new Set(["\\Seen"]))],
    [2, fakeMessage(2, 12n, "Second message", "Second body", new Set())],
    [
      3,
      fakeRelatedMessage(
        3,
        13n,
        "Newest message",
        "Newest plain text body",
        new Set(),
      ),
    ],
  ]);

  return {
    options: [],
    storeOptions: [],
    flagAdds: [],
    messageDeletes: [],
    searches: [],
    searchOptions: [],
    fetchQueries: [],
    lists: 0,
    mailboxOpens: 0,
    ambiguousAppendFailures: 0,
    messageDeleteFalse: new Map(),
    messageDeleteSuccessWithoutRemoval: new Set(),
    omittedDraftSearchUids: new Set(),
    omittedFetchUids: new Set(),
    fetchWithoutFlags: new Set(),
    fetchWithoutHeaders: new Set(),
    fetchOneFailures: new Map(),
    fetchOneFalse: new Set(),
    exactUidSearchFailures: new Set(),
    broadSearchFailures: 0,
    messageFlagAddFalseWithUnreadableUid: new Set(),
    mailboxes: new Map([
      [
        "INBOX",
        {
          path: "INBOX",
          name: "Inbox",
          uidValidity: 101n,
          specialUse: "\\Inbox",
          nextUid: 4,
          messages: inboxMessages,
        },
      ],
      [
        "Archive",
        {
          path: "Archive",
          name: "Archive",
          uidValidity: 202n,
          specialUse: "\\Archive",
          nextUid: 20,
          messages: new Map(),
        },
      ],
      [
        "Bin",
        {
          path: "Bin",
          name: "Bin",
          uidValidity: 303n,
          specialUse: "\\Trash",
          nextUid: 30,
          messages: new Map(),
        },
      ],
      [
        "Drafts",
        {
          path: "Drafts",
          name: "Drafts",
          uidValidity: 505n,
          specialUse: "\\Drafts",
          nextUid: 1,
          messages: new Map(),
        },
      ],
      [
        "Container",
        {
          path: "Container",
          name: "Container",
          uidValidity: 404n,
          flags: new Set(["\\Noselect"]),
          nextUid: 1,
          messages: new Map(),
        },
      ],
    ]),
  };
}

function fakeRelatedMessage(
  uid: number,
  modseq: bigint,
  subject: string,
  text: string,
  flags: Set<string>,
): FetchMessageObject {
  const message = fakeMessage(uid, modseq, subject, text, flags);
  return {
    ...message,
    source: Buffer.from([
      "From: Sender <sender@example.test>",
      "To: Human <human@example.test>",
      `Message-ID: <message-${uid}@example.test>`,
      "In-Reply-To: <parent@example.test>",
      "References: <root@example.test> <parent@example.test>",
      `Subject: ${subject}`,
      "Date: Fri, 29 Aug 2025 12:00:00 +0000",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="related"',
      "",
      "--related",
      'Content-Type: multipart/alternative; boundary="alternative"',
      "",
      "--alternative",
      "Content-Type: text/plain; charset=utf-8",
      "",
      text,
      "--alternative",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Newest HTML body</p><img src="https://tracker.example.test/pixel.png"><img src="cid:logo@example.test">',
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
    ].join("\r\n")),
  };
}

function fakeMessage(
  uid: number,
  modseq: bigint,
  subject: string,
  text: string,
  flags: Set<string>,
  html?: string,
): FetchMessageObject {
  const htmlPart = html === undefined
    ? ""
    : `--boundary\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n`;
  const contentType = html === undefined
    ? "Content-Type: text/plain; charset=utf-8\r\n\r\n"
    : "Content-Type: multipart/alternative; boundary=boundary\r\n\r\n--boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n";
  const ending = html === undefined ? "" : "--boundary--\r\n";
  const source = Buffer.from(
    `From: Sender <sender@example.test>\r\nReply-To: Replies <replies@example.test>\r\nTo: Human <human@example.test>\r\nMessage-ID: <message-${uid}@example.test>\r\nIn-Reply-To: <parent@example.test>\r\nReferences: <root@example.test> <parent@example.test>\r\nSubject: ${subject}\r\nDate: Fri, 29 Aug 2025 12:00:00 +0000\r\n${contentType}${text}\r\n${htmlPart}${ending}`,
  );
  return {
    seq: uid,
    uid,
    modseq,
    flags,
    internalDate: new Date("2025-08-29T12:00:00.000Z"),
    envelope: {
      subject,
      messageId: `<message-${uid}@example.test>`,
      inReplyTo: "<parent@example.test>",
      from: [{ name: "Sender", address: "sender@example.test" }],
      replyTo: [{ name: "Replies", address: "replies@example.test" }],
      to: [{ name: "Human", address: "human@example.test" }],
    },
    source,
  };
}

function deliveryMessage(uid: number, to: string, deliveryHeaders: string, cc?: string): FetchMessageObject {
  const message = fakeMessage(uid, BigInt(uid), `Delivery ${uid}`, `Body ${uid}`, new Set());
  const address = /<([^>]+)>/.exec(to)?.[1] ?? to;
  const ccAddress = cc ? /<([^>]+)>/.exec(cc)?.[1] ?? cc : undefined;
  return {
    ...message,
    envelope: {
      ...message.envelope,
      to: [{ name: to.includes("<") ? to.slice(0, to.indexOf("<")).trim() : "", address }],
      ...(ccAddress ? { cc: [{ name: cc?.slice(0, cc.indexOf("<")).trim() ?? "", address: ccAddress }] } : {}),
    },
    source: Buffer.from(
      `From: Sender <sender@example.test>\r\nTo: ${to}\r\n${cc ? `Cc: ${cc}\r\n` : ""}${deliveryHeaders}Message-ID: <delivery-${uid}@example.test>\r\nSubject: Delivery ${uid}\r\nDate: Fri, 29 Aug 2025 12:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody ${uid}\r\n`,
    ),
  };
}

function bccDeliveryMessage(uid: number, deliveredTo: string): FetchMessageObject {
  const message = deliveryMessage(uid, "Undisclosed recipients:;", `X-Original-To: ${deliveredTo}\r\n`);
  return {
    ...message,
    envelope: { ...message.envelope, to: [] },
  };
}

function mailboxObject(mailbox: StoredMailbox): MailboxObject {
  return {
    path: mailbox.path,
    delimiter: "/",
    flags: mailbox.flags ?? new Set<string>(),
    uidValidity: mailbox.uidValidity,
    uidNext: mailbox.nextUid,
    exists: mailbox.messages.size,
  };
}

function cloneMessage(message: FetchMessageObject): FetchMessageObject {
  return {
    ...message,
    ...(message.flags === undefined ? {} : { flags: new Set(message.flags) }),
    ...(message.source === undefined ? {} : { source: Buffer.from(message.source) }),
    ...(message.headers === undefined ? {} : { headers: Buffer.from(message.headers) }),
  };
}

function fetchedMessage(message: FetchMessageObject, query: FetchQueryObject): FetchMessageObject {
  const cloned = cloneMessage(message);
  if (typeof query.source === "object" && cloned.source) {
    const start = query.source.start ?? 0;
    const end = query.source.maxLength === undefined ? undefined : start + query.source.maxLength;
    cloned.source = cloned.source.subarray(start, end);
  }
  if (Array.isArray(query.headers) && message.source) {
    cloned.headers = selectedHeaders(message.source, query.headers);
  }
  return cloned;
}

function selectedHeaders(source: Buffer, names: readonly string[]): Buffer {
  const selected = new Set(names.map((name) => name.toLowerCase()));
  const headers: string[] = [];
  let currentSelected = false;
  for (const line of source.toString("utf8").split("\r\n")) {
    if (line === "") break;
    if (/^[ \t]/.test(line)) {
      if (currentSelected) headers[headers.length - 1] += `\r\n${line}`;
      continue;
    }
    const separator = line.indexOf(":");
    currentSelected = separator >= 0 && selected.has(line.slice(0, separator).trim().toLowerCase());
    if (currentSelected) headers.push(line);
  }
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n`);
}

function messageRef(overrides: Partial<MessageRef> = {}): MessageRef {
  return {
    accountId: config.accountId,
    mailbox: "INBOX",
    uidValidity: "101",
    uid: 3,
    modseq: "13",
    ...overrides,
  };
}

function providerDraft(version: number, changes: Partial<Draft> = {}): Draft {
  return {
    id: "imap-postreeve-draft",
    accountId: config.accountId,
    mode: "new",
    to: "person@example.test",
    cc: "",
    bcc: "",
    subject: "Provider draft",
    body: "Body",
    identity: { name: "Human", address: config.username },
    attachments: [],
    delivery: { status: "editable" },
    mirror: { status: "pending" },
    createdAt: "2026-09-06T10:00:00.000Z",
    updatedAt: `2026-09-06T10:00:0${version}.000Z`,
    version,
    ...changes,
  };
}
