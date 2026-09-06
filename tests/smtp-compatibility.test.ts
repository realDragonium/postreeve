import { createServer } from "node:net";
import { MailSendPreDispatchError } from "../src/server/mail/sender";
import { createEmptyTestHarness, testAccountInput } from "./support/test-mail";
import { simpleParser } from "mailparser";
import { describe, expect, spyOn, test } from "bun:test";
import type { SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";

import {
  SmtpMailSender,
  type SmtpDeliveryResult,
  type SmtpTransportClient,
} from "../src/server/mail/smtp";
import type { SendMessageInput } from "../src/shared/contracts";

const smtpConfig = {
  accountId: "account-a",
  fromName: "Account A",
  fromAddress: "account-a@example.test",
  host: "smtp.example.test",
  port: 465,
  secure: true,
  username: "account-a@example.test",
  password: "smtp-secret-value",
};

describe("Bun Nodemailer compatibility", () => {
  test("verifies SMTP authentication without sending a message", async () => {
    const transport = new FakeSmtpTransport(deliveredResult());
    const sender = new SmtpMailSender(smtpConfig, () => transport);

    await sender.verifyConnection();

    expect(transport.verifications).toBe(1);
    expect(transport.messages).toHaveLength(0);
  });

  test("loads Nodemailer and maps a validated message to an SMTP transport", async () => {
    const transport = new FakeSmtpTransport({
      messageId: "<server-id@example.test>",
      accepted: ["to@example.test", { address: "copy@example.test" }],
      rejected: [{ address: "hidden@example.test" }],
    });
    let transportOptions: SMTPTransport.Options | undefined;
    const sender = new SmtpMailSender(smtpConfig, (options) => {
      transportOptions = options;
      return transport;
    });

    const receipt = await sender.send(messageInput());

    expect(transportOptions).toMatchObject({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: { user: smtpConfig.username, pass: smtpConfig.password },
      logger: false,
      debug: false,
    });
    const submitted = transport.messages[0];
    expect(submitted?.envelope).toEqual({
      from: smtpConfig.fromAddress, to: ["to@example.test", "copy@example.test", "hidden@example.test"],
    });
    if (!Buffer.isBuffer(submitted?.raw)) throw new Error("Expected composed MIME bytes");
    const parsed = await simpleParser(submitted.raw);
    expect(parsed.subject).toBe("A typed outgoing message");
    expect(parsed.text).toBe("The plain-text body.");
    expect(parsed.bcc).toBeUndefined();
    expect(parsed.from?.value[0]?.address).toBe(smtpConfig.fromAddress);
    expect(submitted.disableFileAccess).toBe(true);
    expect(submitted.disableUrlAccess).toBe(true);
    expect(receipt).toMatchObject({
      accountId: smtpConfig.accountId,
      messageId: "<server-id@example.test>",
      accepted: ["to@example.test", "copy@example.test"],
      rejected: ["hidden@example.test"],
    });
    expect(Date.parse(receipt.submittedAt)).not.toBeNaN();
  });

  test("validates direct sender input before calling the transport", async () => {
    const transport = new FakeSmtpTransport(deliveredResult());
    const sender = new SmtpMailSender(smtpConfig, () => transport);
    const invalid = { ...messageInput(), to: [] };

    expect(sender.send(invalid)).rejects.toThrow();
    expect(transport.messages).toHaveLength(0);
  });

  test("maps resolved reply headers to SMTP without changing delivery receipts", async () => {
    const transport = new FakeSmtpTransport(deliveredResult());
    const sender = new SmtpMailSender(smtpConfig, () => transport);

    const receipt = await sender.send(messageInput(), {
      type: "reply_all",
      sourceMessageId: "canonical-parent",
      conversationId: "conversation-parent",
      sourceSubject: "A typed outgoing message",
      inReplyTo: "<parent@example.test>",
      references: ["<root@example.test>", "<parent@example.test>"],
    });

    const raw = transport.messages[0]?.raw;
    if (!Buffer.isBuffer(raw)) throw new Error("Expected composed MIME bytes");
    const parsed = await simpleParser(raw);
    expect(parsed.inReplyTo).toBe("<parent@example.test>");
    expect(parsed.references).toEqual(["<root@example.test>", "<parent@example.test>"]);
    expect(receipt).toMatchObject({
      accountId: smtpConfig.accountId,
      accepted: ["to@example.test", "copy@example.test", "hidden@example.test"],
      rejected: [],
    });
  });

  test("omits reply headers when the source has no RFC threading identifiers", async () => {
    const transport = new FakeSmtpTransport(deliveredResult());
    const sender = new SmtpMailSender(smtpConfig, () => transport);

    await sender.send(messageInput(), {
      type: "reply",
      sourceMessageId: "canonical-fallback",
      conversationId: "conversation-fallback",
      sourceSubject: "A typed outgoing message",
      references: [],
    });

    const raw = transport.messages[0]?.raw;
    if (!Buffer.isBuffer(raw)) throw new Error("Expected composed MIME bytes");
    const parsed = await simpleParser(raw);
    expect(parsed.inReplyTo).toBeUndefined();
    expect(parsed.references).toBeUndefined();
  });

  test("rejects cross-account sends before SMTP delivery", async () => {
    const transport = new FakeSmtpTransport(deliveredResult());
    const sender = new SmtpMailSender(smtpConfig, () => transport);

    expect(sender.send({ ...messageInput(), accountId: "account-b" })).rejects.toThrow(
      "cannot send for account account-b",
    );
    expect(transport.messages).toHaveLength(0);
  });

  test("keeps credentials out of application logging", async () => {
    const spies = [
      spyOn(console, "debug").mockImplementation(() => {}),
      spyOn(console, "info").mockImplementation(() => {}),
      spyOn(console, "warn").mockImplementation(() => {}),
      spyOn(console, "error").mockImplementation(() => {}),
      spyOn(console, "log").mockImplementation(() => {}),
    ];
    try {
      const sender = new SmtpMailSender(smtpConfig, () => new FakeSmtpTransport(deliveredResult()));
      await sender.send(messageInput());

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

class FakeSmtpTransport implements SmtpTransportClient {
  readonly messages: SendMailOptions[] = [];
  verifications = 0;
  readonly #result: SmtpDeliveryResult;

  constructor(result: SmtpDeliveryResult) {
    this.#result = result;
  }

  async verify(): Promise<boolean> {
    this.verifications += 1;
    return true;
  }

  async sendMail(options: SendMailOptions): Promise<SmtpDeliveryResult> {
    this.messages.push(options);
    return this.#result;
  }
}

function deliveredResult(): SmtpDeliveryResult {
  return {
    messageId: "<server-id@example.test>",
    accepted: ["to@example.test", "copy@example.test", "hidden@example.test"],
    rejected: [],
  };
}

function messageInput(): SendMessageInput {
  return {
    accountId: smtpConfig.accountId,
    to: [{ name: "Recipient", address: "to@example.test" }],
    cc: [{ name: "Copy", address: "copy@example.test" }],
    bcc: [{ name: "", address: "hidden@example.test" }],
    subject: "A typed outgoing message",
    text: "The plain-text body.",
  };
}

test("actual SMTP recipient refusal is retryable while a lost DATA response remains uncertain", async () => {
  const sockets = new Set<import("node:net").Socket>();
  let behavior: "reject" | "lose-data-response" = "reject";
  let dataCommands = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.write("220 localhost synthetic mail\r\n");
    let pending = "";
    let readingMessage = false;
    socket.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end).replace(/\r$/, "");
        pending = pending.slice(end + 1);
        if (readingMessage) {
          if (line === ".") {
            readingMessage = false;
            socket.destroy();
          }
        } else if (line.startsWith("EHLO")) {
          socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        } else if (line.startsWith("AUTH")) {
          socket.write("235 authenticated\r\n");
        } else if (line.startsWith("MAIL FROM")) {
          socket.write("250 sender accepted\r\n");
        } else if (line.startsWith("RCPT TO")) {
          socket.write(behavior === "reject" ? "550 recipient rejected\r\n" : "250 recipient accepted\r\n");
        } else if (line === "DATA") {
          dataCommands += 1;
          readingMessage = true;
          socket.write("354 send content\r\n");
        } else if (line === "QUIT") {
          socket.end("221 closing\r\n");
        } else {
          socket.write("250 ok\r\n");
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing synthetic SMTP port");
  const harness = await createEmptyTestHarness({ senderForAccount: (account) => new SmtpMailSender({
    ...smtpConfig, accountId: account.id, fromAddress: account.email,
    host: "127.0.0.1", port: address.port, secure: false,
  }) });
  try {
    const account = await harness.service.createAccount(testAccountInput());
    let draft = await harness.service.createDraft({
      accountId: account.id, mode: "new", to: "recipient@example.test", cc: "", bcc: "",
      subject: "Synthetic refusal", body: "Retain this draft and file",
      identity: { name: "Sender", address: account.email }, attachments: [],
    });
    const fileId = crypto.randomUUID();
    const bytes = Buffer.from([0, 255, 128]);
    draft = await harness.service.uploadDraftFile(account.id, draft.id, draft.version, { id: fileId, name: "file.bin", type: "application/octet-stream", content: bytes });
    await expect(harness.service.sendDraft(account.id, draft.id, { version: draft.version })).rejects.toBeInstanceOf(MailSendPreDispatchError);
    expect(dataCommands).toBe(0);
    draft = await harness.service.getDraft(account.id, draft.id);
    expect(draft.delivery.status).toBe("failed");
    expect((await harness.service.downloadDraftFile(account.id, draft.id, fileId)).content).toEqual(bytes);
    behavior = "lose-data-response";
    await expect(harness.service.sendDraft(account.id, draft.id, { version: draft.version })).rejects.toThrow();
    expect(dataCommands).toBe(1);
    draft = await harness.service.getDraft(account.id, draft.id);
    expect(draft.delivery.status).toBe("uncertain");
    expect((await harness.service.downloadDraftFile(account.id, draft.id, fileId)).content).toEqual(bytes);
  } finally {
    harness.store.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
