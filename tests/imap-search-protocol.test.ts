import { describe, expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { ImapMailProvider } from "../src/server/mail/imap";
import { ImapSearchEvidence } from "../src/server/mail/imap-search-evidence";
import { Store } from "../src/server/db/store";

// This fixture exercises the installed client's command parser and public log
// hook; adapter-level doubles cannot expose information discarded by ImapFlow.
async function protocolFixture(esearch = false) {
  let validity = 101;
  let fetches = 0;
  const capabilities = `IMAP4rev1${esearch ? " ESEARCH" : ""}`;
  let searchResponse: string | undefined = "* SEARCH 1 2 3\r\n";
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.write(`* OK [CAPABILITY ${capabilities}] fixture ready\r\n`);
    let pending = "";
    socket.on("data", chunk => {
      pending += chunk.toString();
      let end: number;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const separator = line.indexOf(" ");
        const tag = line.slice(0, separator);
        const command = line.slice(separator + 1);
        if (command.startsWith("CAPABILITY")) socket.write(`* CAPABILITY ${capabilities}\r\n`);
        else if (command.startsWith("LIST")) socket.write('* LIST () "/" "INBOX"\r\n');
        else if (command.startsWith("EXAMINE")) socket.write(`* FLAGS (\\Seen)\r\n* 3 EXISTS\r\n* OK [UIDVALIDITY ${validity}] valid\r\n* OK [UIDNEXT 4] next\r\n`);
        else if (command.startsWith("UID SEARCH")) {
          if (searchResponse !== undefined) socket.write(searchResponse.replaceAll("$TAG", tag));
        } else if (command.startsWith("UID FETCH")) {
          fetches++;
          const range = command.slice(10).split(" ")[0]!;
          for (const uid of [1, 2, 3].filter(uid => range.split(",").some(part => {
            const [first, last] = part.split(":").map(Number);
            return uid >= first! && uid <= (last ?? first!);
          }))) {
            const headers = `Message-ID: <${uid}@example.test>\r\n\r\n`;
            const source = `Subject: Message ${uid}\r\n${headers}Body`;
            socket.write(`* ${uid} FETCH (UID ${uid} FLAGS () INTERNALDATE "06-Oct-2026 12:00:00 +0000" ENVELOPE ("Tue, 06 Oct 2026 12:00:00 +0000" "Message ${uid}" NIL NIL NIL NIL NIL NIL NIL "<${uid}@example.test>") BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES)] {${Buffer.byteLength(headers)}}\r\n${headers} BODY[]<0> {${Buffer.byteLength(source)}}\r\n${source})\r\n`);
          }
        } else if (command.startsWith("LOGOUT")) socket.write("* BYE closing\r\n");
        else if (!command.startsWith("LOGIN")) {
          socket.write(`${tag} BAD unexpected fixture command\r\n`);
          continue;
        }
        socket.write(`${tag} OK complete\r\n`);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const provider = new ImapMailProvider({ accountId: "fixture", host: "127.0.0.1", port: address.port, secure: false, username: "fixture", password: "fake" });
  return {
    provider,
    validity(value: number) { validity = value; },
    fetches() { return fetches; },
    response(value: string | undefined) { searchResponse = value; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

describe("installed ImapFlow SEARCH evidence", () => {
  test("rejects malformed, omitted and truncated responses while accepting explicit empty plain SEARCH", async () => {
    const fixture = await protocolFixture();
    const store = new Store(":memory:");
    const account = { tenantId: "tenant", accountId: "fixture", provider: "imap" as const };
    const scope = { kind: "mailbox" as const, mailbox: "INBOX" };
    try {
      await store.insertAccount({ id: "fixture", kind: "imap", name: "Fixture", email: "fixture@example.test", encryptedCredentials: null });
      store.synchronization.schedule(account.tenantId, account.accountId, 0);
      const claim = store.synchronization.claim(account.tenantId, 0, 100)!;
      store.synchronization.discover(claim, [scope], 0, 10);
      const fetch = () => fixture.provider.synchronization.fetchPage({ account, scope,
        cursor: store.synchronization.scopes(account)[0]!.cursor, limit: 100, signal: new AbortController().signal });
      const initial = await fetch();
      store.synchronization.commit(claim, scope, initial, 0, 10, 100);
      expect(store.synchronization.indexed(account.tenantId, account.accountId, "INBOX")).toHaveLength(3);
      const checkpoint = store.synchronization.scopes(account)[0]!.cursor;
      for (const response of [
        "* SEARCH 1 bad 3\r\n",
        undefined,
        "* SEARCH 1 0 3\r\n",
        "* SEARCH 1 2.0 3\r\n",
        "* ESEARCH UID ALL 1:4\r\n",
        '* ESEARCH (TAG "wrong") UID ALL 1:3\r\n',
        "* ESEARCH UID ALL 1:3\r\n* ESEARCH UID ALL 1\r\n",
      ]) {
        fixture.response(response);
        await expect(fetch()).rejects.toThrow("invalid-data");
        expect(store.synchronization.scopes(account)[0]!.cursor).toBe(checkpoint);
        expect(store.synchronization.indexed(account.tenantId, account.accountId, "INBOX")).toHaveLength(3);
      }
      fixture.response('* ESEARCH (TAG "$TAG") UID ALL 1:3\r\n');
      expect((await fetch()).messages).toHaveLength(3);
      for (const valid of ["* SEARCH 1 2 3 (MODSEQ 7)\r\n", "* SEARCH 1 2\r\n* SEARCH 2 3\r\n"]) {
        fixture.response(valid);
        expect((await fetch()).messages.map(message => message.ref.uid)).toEqual([1, 2, 3]);
      }
      fixture.response("* SEARCH\r\n");
      const empty = await fetch();
      store.synchronization.commit(claim, scope, empty, 0, 10, 100);
      expect(empty.coverage).toBe("complete");
      expect(store.synchronization.indexed(account.tenantId, account.accountId, "INBOX")).toHaveLength(0);
    } finally {
      store.close();
      await fixture.close();
    }
  });

  test("accepts negotiated ESEARCH with matching tags and an explicit zero count", async () => {
    const fixture = await protocolFixture(true);
    const account = { tenantId: "tenant", accountId: "fixture", provider: "imap" as const };
    const fetch = () => fixture.provider.synchronization.fetchPage({ account, scope: { kind: "mailbox", mailbox: "INBOX" },
      cursor: null, limit: 100, signal: new AbortController().signal });
    try {
      fixture.response('* ESEARCH (TAG "$TAG") UID ALL 1:3 COUNT 3\r\n');
      expect((await fetch()).messages).toHaveLength(3);
      fixture.response('* ESEARCH (TAG "$TAG") UID COUNT 0\r\n');
      expect((await fetch()).messages).toHaveLength(0);
      fixture.response(undefined);
      await expect(fetch()).rejects.toThrow("invalid-data");
    } finally { await fixture.close(); }
  });

  test.each([false, true])("checks raw ESEARCH membership before normalization (negotiated=%s)", async negotiated => {
    const fixture = await protocolFixture(negotiated);
    const store = new Store(":memory:");
    const account = { tenantId: "tenant", accountId: "fixture", provider: "imap" as const };
    const scope = { kind: "mailbox" as const, mailbox: "INBOX" };
    try {
      await store.insertAccount({ id: "fixture", kind: "imap", name: "Fixture", email: "fixture@example.test", encryptedCredentials: null });
      store.synchronization.schedule(account.tenantId, account.accountId, 0);
      const claim = store.synchronization.claim(account.tenantId, 0, 100)!;
      store.synchronization.discover(claim, [scope], 0, 10);
      const fetch = () => fixture.provider.synchronization.fetchPage({ account, scope,
        cursor: store.synchronization.scopes(account)[0]!.cursor, limit: 100, signal: new AbortController().signal });
      const respond = (body: string) => fixture.response(`* ESEARCH (TAG "$TAG") UID ${body}\r\n`);
      respond("ALL 1:3 COUNT 3");
      store.synchronization.commit(claim, scope, await fetch(), 0, 10, 100);
      const checkpoint = store.synchronization.scopes(account)[0]!.cursor;
      const cached = store.synchronization.indexed(account.tenantId, account.accountId, "INBOX");
      expect(cached).toHaveLength(3);
      for (const validity of [101, 900]) {
        fixture.validity(validity);
        for (const invalid of [
          "COUNT 3", "ALL 1 COUNT 3", "ALL 1 COUNT 0", "ALL 1:3 COUNT 2",
          "ALL 1:3 COUNT 3 MIN 2", "ALL 1:3 COUNT 3 MAX 4", "COUNT 0 MIN 1",
          "ALL 1,1 COUNT 2", "ALL 1:3 COUNT 3 COUNT 3", "ALL 1:3 COUNT 3 PARTIAL 1:3",
        ]) {
          respond(invalid);
          const fetched = fixture.fetches();
          await expect(fetch()).rejects.toThrow("invalid-data");
          expect(fixture.fetches()).toBe(fetched);
          expect(store.synchronization.scopes(account)[0]!.cursor).toBe(checkpoint);
          expect(store.synchronization.indexed(account.tenantId, account.accountId, "INBOX")).toEqual(cached);
        }
      }
      fixture.validity(101);
      for (const valid of ["ALL 3:1 COUNT 3 MIN 1 MAX 3", "ALL 1:2,2:3 COUNT 3", "ALL 1,1,2,3 COUNT 3"]) {
        respond(valid);
        expect((await fetch()).messages.map(message => message.ref.uid)).toEqual([1, 2, 3]);
      }
      respond("ALL 1:3,3 COUNT 3");
      if (negotiated) expect((await fetch()).messages).toHaveLength(3);
      else await expect(fetch()).rejects.toThrow("invalid-data"); // ImapFlow reports fallback expansion truncation.
      respond("ALL 1:3");
      if (negotiated) await expect(fetch()).rejects.toThrow("invalid-data");
      else expect((await fetch()).messages).toHaveLength(3);
      respond("COUNT 0");
      const empty = await fetch();
      store.synchronization.commit(claim, scope, empty, 0, 10, 100);
      expect(empty.coverage).toBe("complete");
      expect(store.synchronization.indexed(account.tenantId, account.accountId, "INBOX")).toEqual([]);
    } finally {
      store.close();
      await fixture.close();
    }
  });

  test("unrelated response or warning cannot establish SEARCH coverage", () => {
    const evidence = new ImapSearchEvidence();
    evidence.logger.debug({ src: "s", msg: "* SEARCH 1 2 3" });
    evidence.logger.debug({ src: "c", msg: "A UID SEARCH UID 1:3" });
    evidence.logger.debug({ src: "s", msg: "B OK another command" });
    evidence.logger.debug({ src: "s", msg: "* 3 EXISTS" });
    evidence.logger.debug({ src: "s", msg: "A OK complete" });
    expect(() => evidence.assertComplete()).toThrow("invalid-data");
  });
});
