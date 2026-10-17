import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ListResponse } from "imapflow";
import { hc } from "hono/client";
import { createApi, type AppType } from "../src/server/api";
import { ImapMailProvider, type ImapClient } from "../src/server/mail/imap";
import { folderSchema, type FolderMappings } from "../src/shared/contracts";
import { resolveSpecialUses, specialUseFromName, type MailboxCandidate } from "../src/shared/special-folders";
import { createEmptyTestHarness, testAccountInput } from "./support/test-mail";

function candidate(path: string, flagged: MailboxCandidate["flagged"] = null, delimiter = "/"): MailboxCandidate {
  const separator = path.lastIndexOf(delimiter);
  return {
    path,
    name: separator < 0 ? path : path.slice(separator + 1),
    parentPath: separator < 0 ? "" : path.slice(0, separator),
    flagged: path.toUpperCase() === "INBOX" ? "inbox" : flagged,
  };
}

function roles(mailboxes: MailboxCandidate[], overrides: FolderMappings = {}) {
  return Object.fromEntries([...resolveSpecialUses(mailboxes, overrides)]
    .map(([path, { specialUse, specialUseSource }]) => [path, `${specialUse}:${specialUseSource}`]));
}

describe("special-folder resolution", () => {
  test("recognises common names in several languages", () => {
    expect(specialUseFromName("Sent Items")?.role).toBe("sent");
    expect(specialUseFromName("Verzonden")?.role).toBe("sent");
    expect(specialUseFromName("Prullenbak")?.role).toBe("trash");
    expect(specialUseFromName("Deleted Items")?.role).toBe("trash");
    expect(specialUseFromName("Junk E-mail")?.role).toBe("junk");
    expect(specialUseFromName("spam")?.role).toBe("junk");
    expect(specialUseFromName("Concepten")?.role).toBe("drafts");
    expect(specialUseFromName("ARCHIVE")?.role).toBe("archive");
    expect(specialUseFromName("Projects")).toBeNull();
  });

  test("finds cPanel folders under INBOX by name", () => {
    const mailboxes = ["INBOX", "INBOX.Sent", "INBOX.Drafts", "INBOX.Trash", "INBOX.spam", "INBOX.Archive", "INBOX.Clients"]
      .map((path) => candidate(path, null, "."));
    expect(roles(mailboxes)).toEqual({
      INBOX: "inbox:special-use",
      "INBOX.Sent": "sent:name",
      "INBOX.Drafts": "drafts:name",
      "INBOX.Trash": "trash:name",
      "INBOX.spam": "junk:name",
      "INBOX.Archive": "archive:name",
    });
  });

  test("SPECIAL-USE wins over names and nested user folders are never special by name", () => {
    expect(roles([candidate("INBOX"), candidate("Trash"), candidate("Deleted Items", "trash"), candidate("Projects/Archive")]))
      .toEqual({ INBOX: "inbox:special-use", "Deleted Items": "trash:special-use" });
  });

  test("the earlier name in a role's list wins, then listing order", () => {
    expect(roles([candidate("INBOX"), candidate("Deleted"), candidate("Trash"), candidate("Spam"), candidate("Junk")]))
      .toEqual({ INBOX: "inbox:special-use", Trash: "trash:name", Junk: "junk:name" });
  });

  test("overrides win over SPECIAL-USE and names, and take their folder from other roles", () => {
    const mailboxes = [candidate("INBOX"), candidate("Sent", "sent"), candidate("Outbox copies"), candidate("Archive"), candidate("Junk")];
    expect(roles(mailboxes, { sent: "Outbox copies", archive: "Junk" })).toEqual({
      INBOX: "inbox:special-use",
      "Outbox copies": "sent:override",
      Junk: "archive:override",
    });
  });

  test("None removes a role even from flagged folders", () => {
    expect(roles([candidate("INBOX"), candidate("Spam", "junk"), candidate("Junk")], { junk: null }))
      .toEqual({ INBOX: "inbox:special-use" });
  });

  test("a stale or INBOX override is ignored and the role resolves automatically", () => {
    expect(roles([candidate("INBOX"), candidate("Sent Items")], { sent: "Gone" }))
      .toEqual({ INBOX: "inbox:special-use", "Sent Items": "sent:name" });
    expect(roles([candidate("INBOX"), candidate("Archive")], { archive: "INBOX" }))
      .toEqual({ INBOX: "inbox:special-use", Archive: "archive:name" });
  });
});

interface FakeMailbox { path: string; specialUse?: string; flags?: string[]; appended?: number }

/** A LIST-only IMAP client: enough for folder listing, special-folder lookup and folder protection. */
function fakeImap(mailboxes: FakeMailbox[]) {
  const client = {
    capabilities: new Map<string, boolean>(),
    async connect() {},
    async logout() {},
    close() {},
    async list(): Promise<ListResponse[]> {
      return mailboxes.map((mailbox) => {
        const separator = mailbox.path.lastIndexOf("/");
        return {
          path: mailbox.path,
          pathAsListed: mailbox.path,
          name: separator < 0 ? mailbox.path : mailbox.path.slice(separator + 1),
          delimiter: "/",
          parent: [],
          parentPath: separator < 0 ? "" : mailbox.path.slice(0, separator),
          flags: new Set(mailbox.flags ?? []),
          ...(mailbox.specialUse ? { specialUse: mailbox.specialUse } : {}),
          listed: true,
          subscribed: true,
          status: { path: mailbox.path, messages: 0, unseen: 0 },
        } as ListResponse;
      });
    },
    async append(path: string) {
      const mailbox = mailboxes.find((candidate) => candidate.path === path);
      if (!mailbox) throw new Error(`No mailbox ${path}`);
      mailbox.appended = (mailbox.appended ?? 0) + 1;
      return { destination: path };
    },
    async mailboxRename() {},
    async mailboxDelete() {},
  };
  return client as unknown as ImapClient;
}

const imapConfig = { accountId: "imap-account", host: "imap.example.test", port: 993, secure: true, username: "u", password: "p" };

describe("IMAP special folders", () => {
  test("lists name-detected folders and stores sent copies in them", async () => {
    const mailboxes: FakeMailbox[] = [{ path: "INBOX" }, { path: "Verzonden" }, { path: "Prullenbak" }, { path: "Projects" }];
    const provider = new ImapMailProvider(imapConfig, () => fakeImap(mailboxes));

    expect((await provider.listFolders(imapConfig.accountId)).map(({ path, specialUse, specialUseSource }) => [path, specialUse, specialUseSource]))
      .toEqual([["INBOX", "inbox", "special-use"], ["Verzonden", "sent", "name"], ["Prullenbak", "trash", "name"], ["Projects", null, null]]);
    await provider.appendSentMessage(imapConfig.accountId, Buffer.from("Subject: hi\r\n\r\nbody"), "2026-10-17T09:00:00.000Z");
    expect(mailboxes.find(({ path }) => path === "Verzonden")?.appended).toBe(1);
    await expect(provider.renameFolder(imapConfig.accountId, "Verzonden", "Old")).rejects.toThrow("System and special-use folders cannot be changed");
  });

  test("an override redirects sent copies away from the SPECIAL-USE folder", async () => {
    const mailboxes: FakeMailbox[] = [{ path: "INBOX" }, { path: "Sent", specialUse: "\\Sent" }, { path: "Outbox copies" }];
    const provider = new ImapMailProvider(imapConfig, () => fakeImap(mailboxes));
    provider.setFolderOverrides({ sent: "Outbox copies" });

    await provider.appendSentMessage(imapConfig.accountId, Buffer.from("Subject: hi\r\n\r\nbody"), "2026-10-17T09:00:00.000Z");
    expect(mailboxes.find(({ path }) => path === "Outbox copies")?.appended).toBe(1);
    expect(mailboxes.find(({ path }) => path === "Sent")?.appended).toBeUndefined();
    await provider.renameFolder(imapConfig.accountId, "Sent", "Old sent");
  });

  test("names the missing folder and how to fix it", async () => {
    const provider = new ImapMailProvider(imapConfig, () => fakeImap([{ path: "INBOX" }]));
    await expect(provider.appendSentMessage(imapConfig.accountId, Buffer.from("x"), "2026-10-17T09:00:00.000Z"))
      .rejects.toThrow("This account has no Sent folder; choose one under Manage folders");
  });
});

describe("folder-mapping API", () => {
  const mailboxes = (): FakeMailbox[] => [{ path: "INBOX" }, { path: "Sent", specialUse: "\\Sent" }, { path: "Mail" }, { path: "Old" }, { path: "Spam" }];

  async function harness(storePath?: string) {
    const state = mailboxes();
    const created = await createEmptyTestHarness({
      ...(storePath ? { storePath } : {}),
      providerForAccount: (accountId) => new ImapMailProvider({ ...imapConfig, accountId }, () => fakeImap(state)),
    });
    return created;
  }

  test("stores overrides, answers with resolved folders and validates paths", async () => {
    const { service } = await harness();
    const account = await service.createAccount(testAccountInput());
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });
    const param = { accountId: account.id };

    expect(await (await client.api.accounts[":accountId"]["folder-mappings"].$get({ param })).json()).toEqual({});
    const saved = await client.api.accounts[":accountId"]["folder-mappings"].$put({ param, json: { sent: "Mail", junk: null } });
    expect(saved.status).toBe(200);
    const folders = folderSchema.array().parse(await saved.json());
    expect(folders.filter(({ specialUse }) => specialUse !== null).map(({ path, specialUse }) => [path, specialUse]))
      .toEqual([["INBOX", "inbox"], ["Mail", "sent"]]);
    expect(await (await client.api.accounts[":accountId"]["folder-mappings"].$get({ param })).json()).toEqual({ sent: "Mail", junk: null });

    for (const json of [{ sent: "Mail", archive: "Mail" }, { archive: "INBOX" }, { trash: "Missing" }]) {
      const refused = await client.api.accounts[":accountId"]["folder-mappings"].$put({ param, json });
      expect(refused.status).toBe(400);
    }
    expect(await service.getFolderMappings(account.id)).toEqual({ sent: "Mail", junk: null });
  });

  test("overrides survive a restart and are removed with their account", async () => {
    const directory = mkdtempSync(join(tmpdir(), "postreeve-folder-mappings-"));
    const storePath = join(directory, "postreeve.sqlite");
    try {
      const first = await harness(storePath);
      const account = await first.service.createAccount(testAccountInput());
      await first.service.putFolderMappings(account.id, { archive: "Old" });
      first.store.close();

      const second = await harness(storePath);
      const folders = await second.service.listFolders(account.id);
      expect(folders.find(({ path }) => path === "Old")).toMatchObject({ specialUse: "archive", specialUseSource: "override" });
      await second.service.removeAccount(account.id);
      expect(second.store.folderMappings("test-tenant", account.id)).toEqual({});
      second.store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
