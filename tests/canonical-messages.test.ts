import { afterEach, describe, expect, test } from "bun:test";
import type { CanonicalMessageObservation, CanonicalMessageSummary, MessageSummary } from "../src/shared/contracts";
import { uniqueCanonicalMessages } from "../src/shared/canonical-messages";
import { Store } from "../src/server/db/store";
import { normalizeMessageId } from "../src/server/mail/message-id";
import { toCanonicalObservation, type ProviderMessageSummary } from "../src/server/mail/provider";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

async function createStore(): Promise<Store> {
  const store = new Store(":memory:");
  stores.push(store);
  const accounts = [
    { id: "imap-account", kind: "imap" },
    { id: "gmail-account", kind: "gmail" },
    { id: "gmail-other", kind: "gmail" },
    { id: "scope", kind: "gmail" },
    { id: "scope:provider-id:shared", kind: "gmail" },
  ] as const;
  for (const { id, kind } of accounts) {
    await store.insertAccount({
      id,
      name: id,
      email: `${id}@example.test`,
      kind,
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

  test("keeps the earliest valid canonical delivery timestamp", async () => {
    const store = await createStore();
    const later = observation({ receivedAt: "2026-09-03T12:00:00.000Z" });
    await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [later], authoritative: false,
    });
    const [merged] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [{ ...later, receivedAt: "2026-09-02T12:00:00.000Z", location: {
        ...later.location, accountId: "gmail-account", provider: "gmail", providerId: "gmail-timestamp",
      } }], authoritative: false,
    });
    expect(merged?.receivedAt).toBe("2026-09-02T12:00:00.000Z");
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

  test("keeps durable provider associations tenant-scoped", async () => {
    const store = await createStore();
    const first = observation({
      messageId: null,
      location: {
        ...observation().location,
        accountId: "gmail-account",
        provider: "gmail",
        providerId: "shared-provider-id",
      },
    });
    const second = { ...first, tenantId: "tenant-b" };
    const [tenantA] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [first], authoritative: true,
    });
    const [tenantB] = await store.reconcileMailbox({
      tenantId: "tenant-b", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [second], authoritative: true,
    });

    expect(tenantA!.id).not.toBe(tenantB!.id);
  });

  test("keeps delimiter-bearing provider associations account-scoped", async () => {
    const store = await createStore();
    const first = observation({
      messageId: null,
      location: {
        ...observation().location,
        accountId: "scope:provider-id:shared",
        provider: "gmail",
        providerId: "tail",
      },
    });
    const second = observation({
      messageId: null,
      location: {
        ...first.location,
        accountId: "scope",
        providerId: "shared:provider-id:tail",
      },
    });
    const [firstCanonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: first.location.accountId, provider: "gmail", mailbox: "INBOX",
      observations: [first], authoritative: true,
    });
    const [secondCanonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: second.location.accountId, provider: "gmail", mailbox: "INBOX",
      observations: [second], authoritative: true,
    });

    expect(firstCanonical!.id).not.toBe(secondCanonical!.id);
  });

  test("rejects an empty provider ID consistently with the shared contract", async () => {
    const store = await createStore();
    const invalid = observation({
      messageId: null,
      location: { ...observation().location, providerId: "" },
    });

    await expect(store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [invalid], authoritative: true,
    })).rejects.toThrow("Provider ID must be non-empty when present");
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

  test("links exact provider move references and preserves fallback aliases and threading", async () => {
    const store = await createStore();
    const source = observation({ messageId: null });
    const destination = observation({
      messageId: null,
      inReplyTo: null,
      references: [],
      location: { ...source.location, mailbox: "Archive", uidValidity: "20", uid: 84 },
    });
    const [sourceCanonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [source], authoritative: true,
    });
    const [destinationFallback] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "Archive",
      observations: [destination], authoritative: false,
    });

    expect(await store.recordProviderMove("tenant-a", "imap", {
      accountId: "imap-account", mailbox: "INBOX", uidValidity: "10", uid: 42, modseq: "1",
    }, {
      accountId: "imap-account", mailbox: "Archive", uidValidity: "20", uid: 84, modseq: "2",
    })).toBe(true);
    await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [], authoritative: true,
    });
    const [moved] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "Archive",
      observations: [destination], authoritative: true,
    });

    expect(moved).toMatchObject({
      id: sourceCanonical!.id,
      aliases: [destinationFallback!.id],
      conversationId: sourceCanonical!.conversationId,
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });
    expect(await store.getMessage("tenant-a", destinationFallback!.id)).toEqual(moved!);

    expect(await store.recordProviderMove("tenant-a", "imap", {
      accountId: "imap-account", mailbox: "Archive", uidValidity: "20", uid: 84, modseq: "2",
    }, {
      accountId: "imap-account", mailbox: "INBOX", uidValidity: "30", uid: 96, modseq: "3",
    })).toBe(true);
    await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "Archive",
      observations: [], authoritative: true,
    });
    const reversed = observation({
      messageId: null,
      inReplyTo: null,
      references: [],
      location: { ...source.location, uidValidity: "30", uid: 96, modseq: "3" },
    });
    const [restored] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [reversed], authoritative: true,
    });
    expect(restored!.id).toBe(sourceCanonical!.id);
    expect(restored!.conversationId).toBe(sourceCanonical!.conversationId);
  });

  test("rejects known moves across boundaries or conflicting valid canonical IDs", async () => {
    const store = await createStore();
    const source = observation({ messageId: "<source@example.test>" });
    const destination = observation({
      messageId: "<destination@example.test>",
      location: { ...source.location, mailbox: "Archive", uidValidity: "20", uid: 84 },
    });
    const [sourceCanonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [source], authoritative: true,
    });
    const [destinationCanonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "Archive",
      observations: [destination], authoritative: true,
    });
    const previous = { accountId: "imap-account", mailbox: "INBOX", uidValidity: "10", uid: 42, modseq: "1" };
    const current = { accountId: "imap-account", mailbox: "Archive", uidValidity: "20", uid: 84, modseq: "2" };

    await expect(store.recordProviderMove("tenant-a", "imap", previous, current))
      .rejects.toThrow("different canonical Message-ID");
    await expect(store.recordProviderMove("tenant-a", "imap", previous, { ...current, accountId: "gmail-account" }))
      .rejects.toThrow("cannot cross accounts");
    await expect(store.recordProviderMove("tenant-a", "gmail", previous, current))
      .rejects.toThrow("account boundary is invalid");
    expect(await store.recordProviderMove("tenant-b", "imap", previous, current)).toBe(false);
    expect((await store.listMessageLocations("tenant-a", sourceCanonical!.id))).toHaveLength(1);
    expect((await store.listMessageLocations("tenant-a", destinationCanonical!.id))).toHaveLength(1);
  });

  test("promotes a fallback message when its Message-ID becomes available", async () => {
    const store = await createStore();
    const missing = observation({ messageId: null });
    const [fallback] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [missing], authoritative: true,
    });
    const identified = observation({
      inReplyTo: null,
      references: ["<parent@example.test>", "<new-parent@example.test>"],
    });
    const [promoted] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [identified], authoritative: true,
    });

    expect(promoted).toMatchObject({
      id: fallback!.id,
      messageId: "<message@example.test>",
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>", "<new-parent@example.test>"],
    });
  });

  test("retains a promoted provider association after every source location is removed", async () => {
    const store = await createStore();
    const missing = observation({
      messageId: null,
      location: {
        ...observation().location,
        accountId: "gmail-account",
        provider: "gmail",
        uidValidity: "gmail",
        providerId: "gmail-promoted",
      },
    });
    const [fallback] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [missing], authoritative: true,
    });
    const [promoted] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [{ ...missing, messageId: "<promoted@example.test>", inReplyTo: null, references: [] }],
      authoritative: true,
    });
    await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [], authoritative: true,
    });
    const moved = {
      ...missing,
      inReplyTo: null,
      references: [],
      location: { ...missing.location, mailbox: "Archive", uid: 99 },
    };
    const [reappeared] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "Archive",
      observations: [moved], authoritative: true,
    });

    expect(reappeared).toMatchObject({
      id: fallback!.id,
      messageId: "<promoted@example.test>",
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });
    expect(promoted!.id).toBe(fallback!.id);
    expect((await store.listMessageLocations("tenant-a", fallback!.id)).map(({ mailbox }) => mailbox))
      .toEqual(["Archive"]);

    const isolated = { ...moved, tenantId: "tenant-b", location: { ...moved.location, accountId: "gmail-other" } };
    const [other] = await store.reconcileMailbox({
      tenantId: "tenant-b", accountId: "gmail-other", provider: "gmail", mailbox: "Archive",
      observations: [isolated], authoritative: true,
    });
    expect(other!.id).not.toBe(reappeared!.id);
  });

  test("merges a provider fallback from another label into an existing canonical message", async () => {
    const store = await createStore();
    const existing = observation({
      inReplyTo: null,
      references: ["<canonical-root@example.test>", "<shared-root@example.test>"],
    });
    const [canonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [existing], authoritative: true,
    });
    const gmailFallback = observation({
      messageId: null,
      inReplyTo: "<fallback-parent@example.test>",
      references: ["<shared-root@example.test>", "<fallback-parent@example.test>"],
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
      references: ["<fallback-parent@example.test>", "<observed-parent@example.test>"],
      location: { ...gmailFallback.location, mailbox: "Archive", uid: 8 },
    });
    const [merged] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "Archive",
      observations: [identifiedInArchive], authoritative: true,
    });

    expect(merged!.id).toBe(canonical!.id);
    expect(await store.getMessage("tenant-a", fallback!.id)).toEqual(merged!);
    expect(merged!.aliases).toEqual([fallback!.id]);
    expect(await store.getMessage("tenant-b", fallback!.id)).toBeNull();
    expect(await store.listMessageLocations("tenant-a", fallback!.id))
      .toEqual(await store.listMessageLocations("tenant-a", canonical!.id));
    expect((await store.listMessageLocations("tenant-a", canonical!.id)).map(({ mailbox }) => mailbox))
      .toEqual(["Archive", "INBOX", "INBOX"]);
    expect(merged!.inReplyTo).toBe(gmailFallback.inReplyTo);
    expect(merged!.references).toEqual([
      "<canonical-root@example.test>",
      "<shared-root@example.test>",
      "<fallback-parent@example.test>",
      "<observed-parent@example.test>",
    ]);
  });

  test("keeps every exposed fallback identity resolvable after repeated merges", async () => {
    const store = await createStore();
    const base = observation();
    const [canonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [base], authoritative: true,
    });
    const firstMissing = observation({
      messageId: null,
      location: { ...base.location, accountId: "gmail-account", provider: "gmail", providerId: "gmail-first" },
    });
    const secondMissing = observation({
      messageId: null,
      location: { ...base.location, accountId: "gmail-account", provider: "gmail", providerId: "gmail-second", uid: 43 },
    });
    const fallbacks = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [firstMissing, secondMissing], authoritative: true,
    });

    for (const missing of [firstMissing, secondMissing]) {
      await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
        observations: [{ ...missing, messageId: base.messageId }], authoritative: false,
      });
    }

    const survivor = await store.getMessage("tenant-a", canonical!.id);
    expect(new Set(survivor!.aliases)).toEqual(new Set(fallbacks.map(({ id }) => id)));
    for (const fallback of fallbacks) expect(await store.getMessage("tenant-a", fallback.id)).toEqual(survivor);
    expect(await store.listMessageLocations("tenant-a", canonical!.id)).toHaveLength(3);
  });

  test("retains every merged provider association after all source locations are removed", async () => {
    const store = await createStore();
    const base = observation({ inReplyTo: null, references: [] });
    const [canonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [base], authoritative: true,
    });
    const providerFallbacks = ["gmail-first", "gmail-second"].map((providerId, index) => observation({
      messageId: null,
      inReplyTo: index === 0 ? "<provider-parent@example.test>" : null,
      references: index === 0 ? ["<provider-root@example.test>"] : [],
      location: {
        ...base.location,
        accountId: "gmail-account",
        provider: "gmail",
        uidValidity: "gmail",
        uid: 70 + index,
        providerId,
      },
    }));
    const fallbackMessages = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: providerFallbacks, authoritative: true,
    });
    for (const fallback of providerFallbacks) {
      await store.reconcileMailbox({
        tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
        observations: [{ ...fallback, messageId: base.messageId, inReplyTo: null, references: [] }],
        authoritative: false,
      });
    }
    await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [], authoritative: true,
    });
    await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [], authoritative: true,
    });

    const reappeared = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "Archive",
      observations: providerFallbacks.map((fallback, index) => ({
        ...fallback,
        inReplyTo: null,
        references: [],
        location: { ...fallback.location, mailbox: "Archive", uid: 90 + index },
      })),
      authoritative: true,
    });

    expect(new Set(reappeared.map(({ id }) => id))).toEqual(new Set([canonical!.id]));
    expect(new Set(reappeared[0]!.aliases)).toEqual(new Set(fallbackMessages.map(({ id }) => id)));
    expect(reappeared[0]).toMatchObject({
      inReplyTo: "<provider-parent@example.test>",
      references: ["<provider-root@example.test>"],
    });
    for (const fallback of fallbackMessages) {
      expect(await store.getMessage("tenant-a", fallback.id)).toEqual(reappeared[0]!);
    }
  });

  test("composes retained and newly observed threading references on update", async () => {
    const store = await createStore();
    const first = observation();
    const [canonical] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [first], authoritative: true,
    });
    const [duplicate] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [{
        ...first,
        inReplyTo: null,
        references: ["<parent@example.test>", "<new-parent@example.test>"],
      }],
      authoritative: true,
    });

    expect(duplicate).toMatchObject({
      id: canonical!.id,
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>", "<new-parent@example.test>"],
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

  test("repairs a late IMAP parent into the child's stable conversation and orders the parent first", async () => {
    const store = await createStore();
    const child = observation({
      messageId: "<child@example.test>",
      inReplyTo: "<parent@example.test>",
      references: ["<parent@example.test>"],
    });
    const [storedChild] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [child], authoritative: false,
    });
    const originalConversationId = storedChild!.conversationId;
    const parent = observation({
      messageId: "<parent@example.test>", inReplyTo: null, references: [],
      location: { ...child.location, uid: 41 },
    });
    const [storedParent] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [parent], authoritative: false,
    });

    expect(storedParent!.conversationId).toBe(originalConversationId);
    expect((await store.getMessage("tenant-a", storedChild!.id))!.conversationId).toBe(originalConversationId);
    expect((await store.getConversation("tenant-a", originalConversationId))?.messages.map(({ messageId }) => messageId))
      .toEqual(["<parent@example.test>", "<child@example.test>"]);
  });

  test("groups siblings through a shared unresolved RFC parent without crossing tenants", async () => {
    const store = await createStore();
    const sibling = (tenantId: string, uid: number, messageId: string): CanonicalMessageObservation => observation({
      tenantId, messageId, inReplyTo: "<missing-parent@example.test>", references: [],
      location: { ...observation().location, uid },
    });
    const [first] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [sibling("tenant-a", 51, "<sibling-a@example.test>")], authoritative: false,
    });
    const [second] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [sibling("tenant-a", 52, "<sibling-b@example.test>")], authoritative: false,
    });
    const [otherTenant] = await store.reconcileMailbox({
      tenantId: "tenant-b", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [sibling("tenant-b", 53, "<sibling-c@example.test>")], authoritative: false,
    });
    expect(second!.conversationId).toBe(first!.conversationId);
    expect(otherTenant!.conversationId).not.toBe(first!.conversationId);
    const [parent] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [observation({ messageId: "<missing-parent@example.test>", inReplyTo: null, references: [],
        location: { ...observation().location, uid: 54 } })], authoritative: false,
    });
    expect(parent!.conversationId).toBe(first!.conversationId);
    expect((await store.getConversation("tenant-a", first!.conversationId))?.messages).toHaveLength(3);
  });

  test("connects reverse unresolved RFC edges when a fallback gains its Message-ID", async () => {
    const store = await createStore();
    const child = observation({
      messageId: "<promotion-child@example.test>", inReplyTo: "<promoted-parent@example.test>", references: [],
    });
    const [storedChild] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [child], authoritative: false,
    });
    const fallbackParent = observation({
      messageId: null, inReplyTo: null, references: [], location: { ...child.location, uid: 55 },
    });
    const [fallback] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [fallbackParent], authoritative: false,
    });
    expect(fallback!.conversationId).not.toBe(storedChild!.conversationId);

    const [promoted] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [{ ...fallbackParent, messageId: "<promoted-parent@example.test>" }], authoritative: false,
    });
    expect(promoted!.conversationId).toBe(storedChild!.conversationId);
    expect((await store.getConversation("tenant-a", storedChild!.conversationId))?.messages.map(({ messageId }) => messageId))
      .toEqual(["<promoted-parent@example.test>", "<promotion-child@example.test>"]);
  });

  test("keeps every conflicting observed parent as a durable conversation edge", async () => {
    const store = await createStore();
    const child = observation({ messageId: "<child-conflict@example.test>", inReplyTo: "<parent-b@example.test>", references: [] });
    const [storedChild] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [child], authoritative: false,
    });
    await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [{ ...child, inReplyTo: "<parent-a@example.test>" }], authoritative: false,
    });
    const parents = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [
        observation({ messageId: "<parent-a@example.test>", inReplyTo: null, references: [], location: { ...child.location, uid: 81 } }),
        observation({ messageId: "<parent-b@example.test>", inReplyTo: null, references: [], location: { ...child.location, uid: 82 } }),
      ], authoritative: false,
    });
    expect(new Set(parents.map(({ conversationId }) => conversationId)).size).toBe(1);
    expect(parents[0]!.conversationId).toBe(storedChild!.conversationId);
    expect((await store.getMessage("tenant-a", storedChild!.id))?.inReplyTo).toBe("<parent-a@example.test>");
  });

  test("retains conflicting parent edges and whole conversation membership through a move and account deletion", async () => {
    const store = await createStore();
    const member = (uid: number, token: string, mailbox = "INBOX"): CanonicalMessageObservation => observation({
      messageId: null, inReplyTo: token, references: [],
      location: { ...observation().location, mailbox, uid },
    });
    const [source, sourceSibling] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [member(61, "<thread-a@example.test>"), member(62, "<thread-a@example.test>")], authoritative: false,
    });
    const [destination, destinationSibling] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "Archive",
      observations: [member(71, "<thread-b@example.test>", "Archive"), member(72, "<thread-b@example.test>", "Archive")],
      authoritative: false,
    });
    const oldConversationIds = [source!.conversationId, destination!.conversationId];
    await store.recordProviderMove("tenant-a", "imap", sourceLocation(61), {
      ...sourceLocation(71), mailbox: "Archive",
    });
    const merged = await store.getConversation("tenant-a", source!.conversationId);
    expect(new Set(merged?.messages.map(({ id }) => id))).toEqual(new Set([
      source!.id, sourceSibling!.id, destinationSibling!.id,
    ]));
    expect((await store.getMessage("tenant-a", destination!.id))?.id).toBe(source!.id);
    for (const id of oldConversationIds) expect((await store.getConversation("tenant-a", id))?.id).toBe(merged?.id);
    await store.deleteAccount("imap-account");
    expect((await store.getConversation("tenant-a", merged!.id))?.messages).toHaveLength(3);

    function sourceLocation(uid: number) {
      return { accountId: "imap-account", mailbox: "INBOX", uidValidity: "10", uid, modseq: "1" };
    }
  });

  test("merges initially disconnected IMAP messages when threading headers arrive later", async () => {
    const store = await createStore();
    const first = observation({ messageId: "<first@example.test>", inReplyTo: null, references: [] });
    const second = observation({
      messageId: "<second@example.test>", inReplyTo: null, references: [],
      location: { ...first.location, uid: 43 },
    });
    const [storedFirst, storedSecond] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [first, second], authoritative: false,
    });
    expect(storedFirst!.conversationId).not.toBe(storedSecond!.conversationId);
    const disconnectedConversationId = storedSecond!.conversationId;

    const [repaired] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [{ ...second, inReplyTo: "<first@example.test>", references: ["malformed", "<first@example.test>"] }],
      authoritative: false,
    });
    const conversation = await store.getConversation("tenant-a", repaired!.conversationId);
    expect(conversation?.messages.map(({ id }) => id)).toEqual([storedFirst!.id, storedSecond!.id]);
    expect(conversation?.messages[1]?.references).toEqual(["<first@example.test>"]);
    expect(await store.getConversation("tenant-a", disconnectedConversationId)).toEqual(conversation);
    expect(await store.getConversation("tenant-b", disconnectedConversationId)).toBeNull();
    const mergedAlias = [storedFirst!.conversationId, disconnectedConversationId]
      .find((id) => id !== conversation?.id);
    expect(conversation?.aliases).toContain(mergedAlias!);
  });

  test("keeps a losing conversation ID aliased when its member is observed unchanged", async () => {
    const store = await createStore();
    const parent = observation({ messageId: "<alias-parent@example.test>", inReplyTo: null, references: [] });
    const child = observation({
      messageId: "<alias-child@example.test>", inReplyTo: null, references: [],
      location: { ...parent.location, uid: 91 },
    });
    const [storedParent, storedChild] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [parent, child], authoritative: false,
    });
    const oldIds = [storedParent!.conversationId, storedChild!.conversationId];
    const threadedChild = { ...child, inReplyTo: "<alias-parent@example.test>" };
    await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [threadedChild], authoritative: false,
    });

    const [repeated] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [threadedChild], authoritative: false,
    });
    const conversations = await Promise.all(oldIds.map((id) => store.getConversation("tenant-a", id)));
    expect(new Set(conversations.map((conversation) => conversation?.id)).size).toBe(1);
    expect(conversations.every((conversation) => conversation?.messages.length === 2)).toBe(true);
    expect(repeated!.conversationId).toBe(conversations[0]!.id);
  });

  test("maps opaque Gmail threads directly without crossing account or tenant boundaries", async () => {
    const store = await createStore();
    const gmail = (accountId: string, uid: number, providerId: string): CanonicalMessageObservation & {
      providerConversationId: string;
    } => ({
      tenantId: "tenant-a", messageId: null, inReplyTo: null, references: [], providerConversationId: "thread-7",
      location: { accountId, provider: "gmail", mailbox: "INBOX", uidValidity: "gmail", uid,
        modseq: null, providerId, read: false, flagged: false },
    });
    const [first, duplicate] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-account", provider: "gmail", mailbox: "INBOX",
      observations: [gmail("gmail-account", 1, "gmail-1"), gmail("gmail-account", 2, "gmail-2")],
      authoritative: false,
    });
    const [otherAccount] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "gmail-other", provider: "gmail", mailbox: "INBOX",
      observations: [gmail("gmail-other", 1, "gmail-3")], authoritative: false,
    });

    expect(duplicate!.conversationId).toBe(first!.conversationId);
    expect((await store.getConversation("tenant-a", first!.conversationId))?.messages).toHaveLength(2);
    expect(otherAccount!.conversationId).not.toBe(first!.conversationId);
  });

  test("keeps duplicate delivery singular and malformed or missing threading deterministic", async () => {
    const store = await createStore();
    const malformed = observation({ messageId: null, inReplyTo: "not-an-id", references: ["also invalid"] });
    const [first] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [malformed], authoritative: false,
    });
    const [repeat] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "INBOX",
      observations: [malformed], authoritative: false,
    });
    const [separate] = await store.reconcileMailbox({
      tenantId: "tenant-a", accountId: "imap-account", provider: "imap", mailbox: "Archive",
      observations: [{ ...malformed, location: { ...malformed.location, mailbox: "Archive" } }], authoritative: false,
    });

    expect(repeat!.conversationId).toBe(first!.conversationId);
    expect((await store.getConversation("tenant-a", first!.conversationId))?.messages).toHaveLength(1);
    expect(separate!.conversationId).not.toBe(first!.conversationId);
  });
});

test("provider summaries map identifiers, threading, location, and flags into the shared observation", () => {
  const summary: ProviderMessageSummary = {
    ref: { accountId: "gmail-account", mailbox: "INBOX", uidValidity: "gmail", uid: 7, modseq: "3", providerId: "gmail-id" },
    messageId: " <MESSAGE@Example.Test> ", inReplyTo: "<PARENT@Example.Test>", references: ["<ROOT@Example.Test>"],
    subject: "Subject", from: [], to: [], receivedAt: "2026-09-03T00:00:00.000Z", preview: "", read: true, flagged: false,
    providerConversationId: "gmail-thread",
  };
  expect(toCanonicalObservation("tenant-a", "gmail", summary)).toEqual({
    tenantId: "tenant-a", messageId: "<MESSAGE@example.test>", inReplyTo: "<PARENT@example.test>", references: ["<ROOT@example.test>"],
    receivedAt: "2026-09-03T00:00:00.000Z",
    providerConversationId: "gmail-thread",
    location: { accountId: "gmail-account", provider: "gmail", mailbox: "INBOX", uidValidity: "gmail", uid: 7,
      modseq: "3", providerId: "gmail-id", read: true, flagged: false },
  });
});

test("provider timestamp provenance preserves missing dates and accepts a real epoch", () => {
  const summary = (canonicalReceivedAt: string | null | undefined): ProviderMessageSummary => ({
    ref: { accountId: "gmail-account", mailbox: "INBOX", uidValidity: "gmail", uid: 8, modseq: null },
    messageId: "<timestamp@example.test>", subject: "Subject", from: [], to: [],
    receivedAt: "1970-01-01T00:00:00.000Z", preview: "", read: false, flagged: false,
    ...(canonicalReceivedAt === undefined ? {} : { canonicalReceivedAt }),
  });
  expect(toCanonicalObservation("tenant-a", "gmail", summary(null)).receivedAt).toBeNull();
  expect(toCanonicalObservation("tenant-a", "gmail", summary("1970-01-01T00:00:00.000Z")).receivedAt)
    .toBe("1970-01-01T00:00:00.000Z");
  expect(toCanonicalObservation("tenant-a", "gmail", summary(undefined)).receivedAt)
    .toBe("1970-01-01T00:00:00.000Z");
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

test("canonical deduplication retains added aliases when invalid aliases keep the same length", () => {
  const summary = (canonicalAliases: string[]): CanonicalMessageSummary => ({
    canonicalId: "canonical",
    canonicalAliases,
    conversationId: "conversation",
    ref: { accountId: "account", mailbox: "INBOX", uidValidity: "1", uid: 1, modseq: null },
    messageId: "<message@example.test>",
    subject: "Subject",
    from: [],
    to: [],
    receivedAt: "2026-09-03T00:00:00.000Z",
    preview: "",
    read: false,
    flagged: false,
  });

  for (const existing of [["canonical", "retained"], ["retained", "retained"]]) {
    const [deduplicated] = uniqueCanonicalMessages([summary(existing), summary(["added"])]);
    expect(deduplicated!.canonicalAliases).toEqual(["retained", "added"]);
  }
});
