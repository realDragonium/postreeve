import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createTcpServer, type AddressInfo, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createServer as createTlsServer, TLSSocket } from "node:tls";
import { hc } from "hono/client";
import { createApi, type AppType } from "../src/server/api";
import { CertificateTrustError } from "../src/server/core/errors";
import { PostreeveService } from "../src/server/core/postreeve";
import { Store } from "../src/server/db/store";
import { ImapMailProvider } from "../src/server/mail/imap";
import { MailProviderRegistry } from "../src/server/mail/provider";
import { MailSenderRegistry } from "../src/server/mail/sender";
import { SmtpMailSender } from "../src/server/mail/smtp";
import { inspectCertificate, isCertificateError, normalizeFingerprint, pinnedTlsOptions, type TlsPin } from "../src/server/mail/tls-trust";
import { CredentialVault } from "../src/server/security/credentials";
import type { CreateAccountInput } from "../src/shared/contracts";

const fixtures = join(import.meta.dir, "fixtures", "tls");
const pair = (name: string) => ({ key: readFileSync(join(fixtures, `${name}.key`)), cert: readFileSync(join(fixtures, `${name}.crt`), "utf8") });
const pinned = pair("pinned");
const other = pair("other");
const pinnedFingerprint = normalizeFingerprint(new X509Certificate(pinned.cert).fingerprint256);
const pin: TlsPin = { fingerprint: pinnedFingerprint, certificate: pinned.cert };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** Answers IMAP commands just far enough for a login and LIST. */
function imapSession(socket: Socket | TLSSocket, greet = true): void {
  if (greet) socket.write("* OK IMAP4rev1 ready\r\n");
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let index = buffer.indexOf("\r\n"); index >= 0; index = buffer.indexOf("\r\n")) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const [tag, command = ""] = line.split(" ");
      switch (command.toUpperCase()) {
        case "CAPABILITY": socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`); break;
        case "LIST": socket.write(`* LIST () "/" INBOX\r\n${tag} OK done\r\n`); break;
        case "LOGOUT": socket.end(`* BYE\r\n${tag} OK done\r\n`); break;
        default: socket.write(`${tag} OK done\r\n`);
      }
    }
  });
  socket.on("error", () => undefined);
}

/** Answers SMTP commands just far enough for EHLO, AUTH and QUIT. */
function smtpSession(socket: Socket | TLSSocket): void {
  socket.write("220 smtp.test ready\r\n");
  socket.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
      const command = line.split(" ")[0]!.toUpperCase();
      if (command === "EHLO") socket.write("250-smtp.test\r\n250 AUTH PLAIN LOGIN\r\n");
      else if (command === "AUTH") socket.write("235 2.7.0 accepted\r\n");
      else if (command === "QUIT") socket.end("221 bye\r\n");
      else socket.write("250 ok\r\n");
    }
  });
  socket.on("error", () => undefined);
}

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const tlsServer = (certificate: { key: Buffer; cert: string }, session: (socket: TLSSocket) => void) =>
  listen(createTlsServer(certificate, session));

/** A plain-text server that upgrades to TLS after STARTTLS, like port 143 or 587. */
function startTlsServer(protocol: "imap" | "smtp", certificate: { key: Buffer; cert: string }) {
  return listen(createTcpServer((socket) => {
    socket.write(protocol === "imap" ? "* OK ready\r\n" : "220 ready\r\n");
    socket.on("data", (chunk) => {
      const line = chunk.toString();
      if (/^EHLO/i.test(line)) socket.write("250-smtp.test\r\n250 STARTTLS\r\n");
      else if (/STARTTLS/i.test(line)) {
        socket.removeAllListeners("data");
        socket.write(protocol === "imap" ? "a1 OK begin TLS\r\n" : "220 go ahead\r\n", () => {
          const secured = new TLSSocket(socket, { isServer: true, ...certificate });
          secured.on("error", () => undefined);
        });
      }
    });
    socket.on("error", () => undefined);
  }));
}

const imapConfig = (port: number, tlsPin?: TlsPin) => ({
  accountId: "self-hosted", host: "127.0.0.1", port, secure: true, username: "owner@self-hosted.test", password: "secret",
  ...tlsPin ? { tlsPin } : {},
});
const smtpConfig = (port: number, tlsPin?: TlsPin) => ({
  accountId: "self-hosted", fromName: "Owner", fromAddress: "owner@self-hosted.test", host: "127.0.0.1", port, secure: true,
  username: "owner@self-hosted.test", password: "secret", ...tlsPin ? { tlsPin } : {},
});

describe("certificate inspection", () => {
  test("reads the certificate over implicit TLS and both STARTTLS dialects", async () => {
    const endpoints = [
      { port: await tlsServer(pinned, (socket) => socket.end()), secure: true },
      { port: await startTlsServer("imap", pinned), secure: false },
    ];
    for (const { port, secure } of endpoints) {
      expect((await inspectCertificate({ protocol: "imap", host: "127.0.0.1", port, secure })).fingerprint).toBe(pinnedFingerprint);
    }
    const smtp = await inspectCertificate({ protocol: "smtp", host: "127.0.0.1", port: await startTlsServer("smtp", pinned), secure: false });
    expect(smtp).toMatchObject({
      service: "smtp", fingerprint: pinnedFingerprint, selfSigned: true,
      subject: "CN=mail.self-hosted.test, O=Postreeve test fixture",
    });
    expect(smtp.validTo > "2100").toBe(true);
  });
});

describe("pinned connections", () => {
  test("IMAP refuses a self-signed certificate unless exactly that certificate is pinned", async () => {
    const port = await tlsServer(pinned, (socket) => imapSession(socket));
    const unpinned = await new ImapMailProvider(imapConfig(port)).verifyConnection().catch((error: unknown) => error);
    expect(isCertificateError(unpinned)).toBe(true);
    await new ImapMailProvider(imapConfig(port, pin)).verifyConnection();

    const changedPort = await tlsServer(other, (socket) => imapSession(socket));
    const changed = await new ImapMailProvider(imapConfig(changedPort, pin)).verifyConnection().catch((error: unknown) => error);
    expect(isCertificateError(changed)).toBe(true);
  });

  test("SMTP follows the same pin", async () => {
    const port = await tlsServer(pinned, (socket) => smtpSession(socket));
    const unpinned = await new SmtpMailSender(smtpConfig(port)).verifyConnection().catch((error: unknown) => error);
    expect(isCertificateError(unpinned)).toBe(true);
    await new SmtpMailSender(smtpConfig(port, pin)).verifyConnection();

    const changedPort = await tlsServer(other, (socket) => smtpSession(socket));
    const changed = await new SmtpMailSender(smtpConfig(changedPort, pin)).verifyConnection().catch((error: unknown) => error);
    expect(isCertificateError(changed)).toBe(true);
  });

  test("a pin keeps verification on and only replaces the host-name check", () => {
    const options = pinnedTlsOptions(pin).tls!;
    expect(options.rejectUnauthorized).toBeUndefined();
    const check = options.checkServerIdentity!;
    expect(check("192.168.1.10", { fingerprint256: new X509Certificate(pinned.cert).fingerprint256 } as never)).toBeUndefined();
    const mismatch = check("192.168.1.10", { fingerprint256: new X509Certificate(other.cert).fingerprint256 } as never);
    expect(isCertificateError(mismatch)).toBe(true);
    expect(pinnedTlsOptions(undefined)).toEqual({});
  });
});

describe("trusting a certificate from account setup", () => {
  async function serviceWith(imapPort: number, smtpPort: number) {
    const store = new Store(":memory:");
    const service = new PostreeveService(store, { tenantId: "t" }, new MailProviderRegistry(), new MailSenderRegistry(),
      new CredentialVault(Buffer.alloc(32, 9).toString("base64")),
      (accountId, credentials) => new ImapMailProvider({ accountId, ...credentials }),
      (account, credentials) => new SmtpMailSender({ accountId: account.id, fromName: account.name, fromAddress: account.email, ...credentials.smtp! }));
    const input: CreateAccountInput = {
      kind: "imap", name: "Self-hosted", email: "owner@self-hosted.test", host: "127.0.0.1", port: imapPort, secure: true,
      username: "owner@self-hosted.test", password: "secret", smtpHost: "127.0.0.1", smtpPort, smtpSecure: true,
      smtpUsername: "owner@self-hosted.test", smtpPassword: "secret", saveSentCopy: false,
    };
    return { store, service, input };
  }

  test("shows the presented certificate, pins the reviewed one and reports a changed one", async () => {
    const imapPort = await tlsServer(pinned, (socket) => imapSession(socket));
    const smtpPort = await tlsServer(pinned, (socket) => smtpSession(socket));
    const { store, service, input } = await serviceWith(imapPort, smtpPort);
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });

    const untrusted = await client.api.accounts.test.$post({ json: input });
    expect(untrusted.status).toBe(400);
    expect(await untrusted.json()).toMatchObject({
      code: "certificate_untrusted",
      certificate: { service: "imap", port: imapPort, fingerprint: pinnedFingerprint, selfSigned: true },
    });

    const smtpUntrusted = await service.testNewAccountConnection({ ...input, imapTrustedCertificate: pinnedFingerprint })
      .catch((error: unknown) => error);
    expect(smtpUntrusted).toBeInstanceOf(CertificateTrustError);
    expect((smtpUntrusted as CertificateTrustError).certificate.service).toBe("smtp");

    const otherFingerprint = normalizeFingerprint(new X509Certificate(other.cert).fingerprint256);
    await expect(service.testNewAccountConnection({ ...input, imapTrustedCertificate: otherFingerprint }))
      .rejects.toThrow("now presents a different certificate than the one you reviewed");

    const colonFingerprint = new X509Certificate(pinned.cert).fingerprint256;
    const account = await service.createAccount({ ...input, imapTrustedCertificate: colonFingerprint, smtpTrustedCertificate: pinnedFingerprint });
    expect(await service.getAccountSettings(account.id)).toMatchObject({
      imapTrustedCertificate: pinnedFingerprint, smtpTrustedCertificate: pinnedFingerprint,
    });

    const settings = await service.getAccountSettings(account.id);
    const { id: _id, kind: _kind, ...update } = settings;
    const changedPort = await tlsServer(other, (socket) => imapSession(socket));
    const changed = await service.testAccountConnection(account.id, { ...update, port: changedPort }).catch((error: unknown) => error);
    expect(changed).toBeInstanceOf(CertificateTrustError);
    expect((changed as CertificateTrustError).message).toContain("certificate changed and no longer matches the one you trusted");
    expect((changed as CertificateTrustError).certificate.fingerprint).toBe(otherFingerprint);

    await service.updateAccount(account.id, { ...update, smtpTrustedCertificate: null }).catch(() => undefined);
    expect((await service.getAccountSettings(account.id)).smtpTrustedCertificate).toBe(pinnedFingerprint);
    store.close();
  });
});
