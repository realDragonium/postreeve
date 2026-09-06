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
