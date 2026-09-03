import { afterEach, describe, expect, test } from "bun:test";
import type { CanonicalMessageObservation, MessageSummary } from "../src/shared/contracts";
import { Store } from "../src/server/db/store";
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
