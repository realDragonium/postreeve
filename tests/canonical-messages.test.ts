import { afterEach, describe, expect, test } from "bun:test";
import type { CanonicalMessageObservation, MessageSummary } from "../src/shared/contracts";
import { Store } from "../src/server/db/store";
import { normalizeMessageId } from "../src/server/mail/message-id";
import { toCanonicalObservation } from "../src/server/mail/provider";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function createStore(): Promise<Store> {
  const store = new Store(":memory:");
  stores.push(store);
  for (const id of ["imap-account", "gmail-account"]) {
    await store.insertAccount({
      id,
      name: id,
      email: `${id}@example.test`,
      kind: id.startsWith("gmail") ? "gmail" : "imap",
      encryptedCredentials: null,
    });
  }
  return store;
}

function observation(overrides: Partial<CanonicalMessageObservation> = {}): CanonicalMessageObservation {
  return {
    tenantId: "tenant-a",
    messageId: "<message@example.test>",
    inReplyTo: "<parent@example.test>",
    references: ["<root@example.test>", "<parent@example.test>"],
    location: {
      accountId: "imap-account",
      provider: "imap",
      mailbox: "INBOX",
      uidValidity: "10",
      uid: 42,
      modseq: "1",
      providerId: null,
      read: false,
      flagged: false,
    },
    ...overrides,
  };
}

describe("canonical message persistence", () => {
  test("deduplicates repeated and cross-account deliveries within a tenant", async () => {
    const store = await createStore();
    const first = observation();
    const [created] = await store.reconcileMailbox({
      tenantId: first.tenantId, accountId: first.location.accountId, provider: first.location.provider,
      mailbox: first.location.mailbox, observations: [first], authoritative: true,
    });
    const duplicate = observation({ location: {
      ...first.location, accountId: "gmail-account", provider: "gmail", providerId: "gmail-42", uidValidity: "gmail",
    } });
    const [repeated] = await store.reconcileMailbox({
      tenantId: duplicate.tenantId, accountId: duplicate.location.accountId, provider: duplicate.location.provider,
      mailbox: duplicate.location.mailbox, observations: [duplicate], authoritative: true,
    });

    expect(repeated!.id).toBe(created!.id);
    expect(await store.listMessageLocations("tenant-a", created!.id)).toHaveLength(2);
    expect(repeated!.references).toEqual(first.references);
  });

  test("deduplicates commented Message-IDs and retains commented threading identifiers", async () => {
    const store = await createStore();
    const first = observation({
      messageId: "(source (nested\\) comment))\r\n \t<message@Example.Test>",
      inReplyTo: "<parent@Example.Test> (thread\\ comment)",
      references: ["(root) <root@Example.Test>", "<parent@Example.Test> (parent)"],
    });
    const [created] = await store.reconcileMailbox({
      tenantId: first.tenantId, accountId: first.location.accountId, provider: first.location.provider,
      mailbox: first.location.mailbox, observations: [first], authoritative: true,
    });
    const duplicate = observation({ location: {
      ...first.location, accountId: "gmail-account", provider: "gmail", providerId: "gmail-cfws", uidValidity: "gmail",
    } });
    const [repeated] = await store.reconcileMailbox({
      tenantId: duplicate.tenantId, accountId: duplicate.location.accountId, provider: duplicate.location.provider,
      mailbox: duplicate.location.mailbox, observations: [duplicate], authoritative: true,
    });

    expect(repeated).toMatchObject({
      id: created!.id,
      messageId: "<message@example.test>",
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });
    expect(await store.listMessageLocations("tenant-a", created!.id)).toHaveLength(2);
  });

  test("keeps identities tenant-scoped", async () => {
    const store = await createStore();
    const first = observation();
    const second = observation({ tenantId: "tenant-b" });
    const [a] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [first], authoritative: true });
    const [b] = await store.reconcileMailbox({ tenantId: "tenant-b", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [second], authoritative: true });
    expect(a!.id).not.toBe(b!.id);
    expect(await store.getMessage("tenant-b", a!.id)).toBeNull();
    expect(await store.listMessageLocations("tenant-b", a!.id)).toEqual([]);
  });

  test("retains overlapping folders and reconciles moves without changing identity", async () => {
    const store = await createStore();
    const inbox = observation();
    const [canonical] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [inbox], authoritative: true });
    const archive = observation({ location: { ...inbox.location, mailbox: "Archive", uid: 99, modseq: "2" } });
    const [moved] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "Archive", observations: [archive], authoritative: true });
    expect(await store.listMessageLocations("tenant-a", canonical!.id)).toHaveLength(2);

    await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [], authoritative: true });
    expect(moved!.id).toBe(canonical!.id);
    expect((await store.listMessageLocations("tenant-a", canonical!.id)).map(({ mailbox }) => mailbox)).toEqual(["Archive"]);
  });

  test("retains a durable identity when the old location disappears before the move is observed", async () => {
    const store = await createStore();
    const inbox = observation();
    const [canonical] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [inbox], authoritative: true });
    await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [], authoritative: true });
    expect(await store.getMessage("tenant-a", canonical!.id)).not.toBeNull();

    const archive = observation({ location: { ...inbox.location, mailbox: "Archive", uid: 99, modseq: "2" } });
    const [moved] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "Archive", observations: [archive], authoritative: true });
    expect(moved!.id).toBe(canonical!.id);
  });

  test("retains durable canonical messages when an account is removed", async () => {
    const store = await createStore();
    const inbox = observation();
    const [canonical] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [inbox], authoritative: true });
    await store.deleteAccount("imap-account");
    expect(await store.getMessage("tenant-a", canonical!.id)).not.toBeNull();
    expect(await store.listMessageLocations("tenant-a", canonical!.id)).toEqual([]);
  });

  test("updates mutable flags on the location without changing message identity", async () => {
    const store = await createStore();
    const unread = observation();
    const [first] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [unread], authoritative: true });
    const changed = observation({ location: { ...unread.location, modseq: "2", read: true, flagged: true } });
    const [second] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [changed], authoritative: true });
    expect(second!.id).toBe(first!.id);
    expect(await store.listMessageLocations("tenant-a", first!.id)).toMatchObject([{ read: true, flagged: true, modseq: "2" }]);
  });

  test("does not remove unseen locations from a partial mailbox observation", async () => {
    const store = await createStore();
    const first = observation();
    const second = observation({
      messageId: "<second@example.test>",
      location: { ...first.location, uid: 43 },
    });
    const [, unseen] = await store.reconcileMailbox({
      tenantId: "tenant-a",
      accountId: "imap-account",
      provider: "imap",
      mailbox: "INBOX",
      observations: [first, second],
      authoritative: true,
    });

    await store.reconcileMailbox({
      tenantId: "tenant-a",
      accountId: "imap-account",
      provider: "imap",
      mailbox: "INBOX",
      observations: [{ ...first, location: { ...first.location, read: true } }],
      authoritative: false,
    });

    expect(await store.listMessageLocations("tenant-a", unseen!.id)).toHaveLength(1);
  });

  test("uses stable provider location identity when Message-ID is invalid", async () => {
    const store = await createStore();
    const missing = observation({ messageId: null, inReplyTo: null, references: [] });
    const [first] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [missing], authoritative: true });
    const [second] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [{ ...missing, location: { ...missing.location, modseq: "2" } }], authoritative: true });
    expect(second!.id).toBe(first!.id);
  });

  test("does not collapse equal IMAP UIDs from different mailboxes without Message-ID", async () => {
    const store = await createStore();
    const inbox = observation({ messageId: null, inReplyTo: null, references: [] });
    const archive = observation({
      messageId: null,
      inReplyTo: null,
      references: [],
      location: { ...inbox.location, mailbox: "Archive" },
    });
    const [first] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX", observations: [inbox], authoritative: true });
    const [second] = await store.reconcileMailbox({ tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "Archive", observations: [archive], authoritative: true });
    expect(second!.id).not.toBe(first!.id);
  });

  test("promotes a fallback message when its Message-ID becomes available", async () => {
    const store = await createStore();
    const missing = observation({ messageId: null });
    const [fallback] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [missing], authoritative: true,
    });
    const identified = observation({ inReplyTo: null, references: [] });
    const [promoted] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [identified], authoritative: true,
    });

    expect(promoted).toMatchObject({
      id: fallback!.id,
      messageId: "<message@example.test>",
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });
  });

  test("merges a provider fallback from another label into an existing canonical message", async () => {
    const store = await createStore();
    const existing = observation({ inReplyTo: null, references: [] });
    const [canonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [existing], authoritative: true,
    });
    const gmailFallback = observation({
      messageId: null,
      inReplyTo: "<fallback-parent@example.test>",
      references: ["<fallback-root@example.test>", "<fallback-parent@example.test>"],
      location: {
        ...existing.location, accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
        uidValidity: "gmail", uid: 7, providerId: "gmail-shared",
      },
    });
    const [fallback] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [gmailFallback], authoritative: true,
    });
    const identifiedInArchive = observation({
      inReplyTo: null,
      references: [],
      location: { ...gmailFallback.location, mailbox: "Archive", uid: 8 },
    });
    const [merged] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "Archive",
      observations: [identifiedInArchive], authoritative: true,
    });

    expect(merged!.id).toBe(canonical!.id);
    expect(await store.getMessage("tenant-a", fallback!.id)).toBeNull();
    expect((await store.listMessageLocations("tenant-a", canonical!.id)).map(({ mailbox }) => mailbox))
      .toEqual(["Archive", "INBOX", "INBOX"]);
    expect(merged!.inReplyTo).toBe(gmailFallback.inReplyTo);
    expect(merged!.references).toEqual(gmailFallback.references);
  });

  test("retains threading metadata when an ordinary duplicate omits it", async () => {
    const store = await createStore();
    const first = observation();
    const [canonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [first], authoritative: true,
    });
    const [duplicate] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [{ ...first, inReplyTo: null, references: [] }], authoritative: true,
    });

    expect(duplicate).toMatchObject({
      id: canonical!.id,
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });
  });

  test("does not let another tenant's canonical message intercept fallback promotion", async () => {
    const store = await createStore();
    const missing = observation({ tenantId: "tenant-a", messageId: null });
    const [fallback] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [missing], authoritative: true,
    });
    const otherTenant = observation({ tenantId: "tenant-b" });
    const [otherCanonical] = await store.reconcileMailbox({
      tenantId: "tenant-b", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [otherTenant], authoritative: true,
    });
    const [promoted] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [observation()], authoritative: true,
    });

    expect(promoted!.id).toBe(fallback!.id);
    expect(promoted!.id).not.toBe(otherCanonical!.id);
    expect(await store.listMessageLocations("tenant-b", otherCanonical!.id)).toHaveLength(1);
  });

  test("keeps an identified canonical when a later location observation omits Message-ID", async () => {
    const store = await createStore();
    const identified = observation({
      location: {
        ...observation().location, accountId: "gmail-account", provider: "gmail",
        uidValidity: "gmail", uid: 7, providerId: "gmail-stable",
      },
    });
    const [canonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [identified], authoritative: true,
    });
    const missingInArchive = observation({
      messageId: null,
      inReplyTo: null,
      references: [],
      location: { ...identified.location, mailbox: "Archive", uid: 8 },
    });
    const [sameCanonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "Archive",
      observations: [missingInArchive], authoritative: true,
    });

    expect(sameCanonical).toMatchObject({
      id: canonical!.id,
      messageId: "<message@example.test>",
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });
    expect(await store.listMessageLocations("tenant-a", canonical!.id)).toHaveLength(2);
  });

  test("does not conflate different valid identities observed at the same location", async () => {
    const store = await createStore();
    const first = observation();
    const [firstCanonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [first], authoritative: true,
    });
    const replacement = observation({ messageId: "<replacement@example.test>" });
    const [replacementCanonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [replacement], authoritative: true,
    });

    expect(replacementCanonical!.id).not.toBe(firstCanonical!.id);
    expect(await store.getMessage("tenant-a", firstCanonical!.id)).not.toBeNull();
    expect(await store.listMessageLocations("tenant-a", firstCanonical!.id)).toEqual([]);
    expect(await store.listMessageLocations("tenant-a", replacementCanonical!.id)).toHaveLength(1);
  });

  test("returns the surviving canonical for every ordered fallback and valid observation", async () => {
    const store = await createStore();
    const missing = observation({ messageId: null, inReplyTo: null, references: [] });
    const valid = observation();
    const reconciled = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [missing, valid, missing], authoritative: true,
    });

    expect(reconciled).toHaveLength(3);
    expect(new Set(reconciled.map(({ id }) => id))).toEqual(new Set([reconciled[0]!.id]));
    expect(reconciled[0]).toMatchObject({
      messageId: "<message@example.test>",
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });
    expect(await store.listMessageLocations("tenant-a", reconciled[0]!.id)).toHaveLength(1);
  });
});

test("provider summaries map identifiers, threading, location, and flags into the shared observation", () => {
  const summary: MessageSummary = {
    ref: { accountId: "gmail-account", mailbox: "INBOX", uidValidity: "gmail", uid: 7, modseq: "3", providerId: "gmail-id" },
    messageId: " <MESSAGE@Example.Test> ", inReplyTo: "<PARENT@Example.Test>", references: ["<ROOT@Example.Test>"],
    subject: "Subject", from: [], to: [], receivedAt: "2026-09-03T00:00:00.000Z", preview: "", read: true, flagged: false,
  };
  expect(toCanonicalObservation("tenant-a", "gmail", summary)).toEqual({
    tenantId: "tenant-a", messageId: "<MESSAGE@example.test>", inReplyTo: "<PARENT@example.test>", references: ["<ROOT@example.test>"],
    location: { accountId: "gmail-account", provider: "gmail", mailbox: "INBOX", uidValidity: "gmail", uid: 7,
      modseq: "3", providerId: "gmail-id", read: true, flagged: false },
  });
});

test("normalizes valid quoted and domain-literal Message-IDs without accepting malformed IDs", () => {
  const summary = (messageId: string): MessageSummary => ({
    ref: { accountId: "imap-account", mailbox: "INBOX", uidValidity: "10", uid: 7, modseq: null },
    messageId,
    subject: "Subject",
    from: [],
    to: [],
    receivedAt: "2026-09-03T00:00:00.000Z",
    preview: "",
    read: false,
    flagged: false,
  });

  expect(toCanonicalObservation("tenant-a", "imap", summary(' <"quoted local"@Example.Test> ')).messageId)
    .toBe('<"quoted local"@example.test>');
  expect(toCanonicalObservation("tenant-a", "imap", summary("<local@[IPv6:2001:DB8::1]> ")).messageId)
    .toBe("<local@[ipv6:2001:db8::1]>");
  expect(toCanonicalObservation("tenant-a", "imap", summary("not-a-message-id")).messageId).toBeNull();
});

test("normalizes surrounding RFC 5322 CFWS without accepting malformed or multiple IDs", () => {
  expect(normalizeMessageId("(outer (nested\\) comment) tail)\r\n \t<local@Example.Test> (trailing\\\\comment)"))
    .toBe("<local@example.test>");
  expect(normalizeMessageId("<local@example.test>\r\n\t(comment)"))
    .toBe("<local@example.test>");

  for (const malformed of [
    "(unclosed) (comment <local@example.test>",
    "<local@example.test> (unclosed",
    "(bad\r\nfold) <local@example.test>",
    "<local@example.test>\n (bare line feed)",
    "<one@example.test> <two@example.test>",
    "(comment) <local@example.test> trailing",
  ]) {
    expect(normalizeMessageId(malformed)).toBeNull();
  }
});
