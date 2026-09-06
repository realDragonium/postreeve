import { composeMime, type OutgoingContent } from "./outgoing-content";
import { MailSendPreDispatchError } from "./sender";
import { createTransport } from "nodemailer";
import type { SendMailOptions } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { z } from "zod";

import {
  sendMessageInputSchema,
  sendReceiptSchema,
  type SendMessageInput,
  type SendReceipt,
} from "../../shared/contracts";
import type { ConversationSendContext, MailSender } from "./sender";

const smtpAccountConfigSchema = z.object({
  accountId: z.string().min(1),
  fromName: z.string().max(120),
  fromAddress: z.email(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  username: z.string().min(1),
  password: z.string().min(1),
});

export type SmtpAccountConfig = z.infer<typeof smtpAccountConfigSchema>;

export interface SmtpDeliveryAddress {
  readonly address: string;
}

export type SmtpDeliveryRecipient = string | SmtpDeliveryAddress;

export interface SmtpDeliveryResult {
  readonly messageId: string;
  readonly accepted: readonly SmtpDeliveryRecipient[];
  readonly rejected: readonly SmtpDeliveryRecipient[];
}

export interface SmtpTransportClient {
  verify(): Promise<boolean>;
  sendMail(options: SendMailOptions): Promise<SmtpDeliveryResult>;
}

export type SmtpTransportFactory = (options: SMTPTransport.Options) => SmtpTransportClient;

const defaultTransportFactory: SmtpTransportFactory = (options) => {
  const transport = createTransport(options);
  return {
    verify: () => transport.verify(),
    sendMail: (message) => transport.sendMail(message),
  };
};

export class SmtpMailSender implements MailSender {
  readonly #config: SmtpAccountConfig;
  readonly #transport: SmtpTransportClient;

  constructor(config: SmtpAccountConfig, createSmtpTransport: SmtpTransportFactory = defaultTransportFactory) {
    this.#config = smtpAccountConfigSchema.parse(config);
    this.#transport = createSmtpTransport({
      host: this.#config.host,
      port: this.#config.port,
      secure: this.#config.secure,
      auth: {
        user: this.#config.username,
        pass: this.#config.password,
      },
      logger: false,
      debug: false,
    });
  }

  async verifyConnection(): Promise<void> {
    const verified = await this.#transport.verify();
    if (!verified) throw new Error("SMTP server rejected the connection");
  }

  async send(rawInput: SendMessageInput, context?: ConversationSendContext, content?: OutgoingContent): Promise<SendReceipt> {
    const input = sendMessageInputSchema.parse(rawInput);
    this.#assertAccount(input.accountId);
    const reply = context?.type === "reply" || context?.type === "reply_all" ? context : undefined;

    const messageId = `<${crypto.randomUUID()}@postreeve.local>`;
    const submittedAt = new Date().toISOString();
    let raw: Buffer;
    try {
      raw = await composeMime({
        messageId,
        date: new Date(submittedAt),
        from: { name: this.#config.fromName, address: this.#config.fromAddress },
        to: input.to,
        cc: input.cc,
        bcc: input.bcc,
        subject: input.subject,
        ...(reply?.inReplyTo ? { inReplyTo: reply.inReplyTo } : {}),
        ...(reply && reply.references.length > 0 ? { references: [...reply.references] } : {}),
        disableFileAccess: true,
        disableUrlAccess: true,
      }, input.text, content);
    } catch (error) {
      throw new MailSendPreDispatchError(error instanceof Error ? error.message : "Mail preparation failed", { cause: error });
    }
    const result = await this.#transport.sendMail({
      raw,
      envelope: { from: this.#config.fromAddress, to: [...input.to, ...input.cc, ...input.bcc].map(({ address }) => address) },
      messageId,
      disableFileAccess: true,
      disableUrlAccess: true,
    });

    return sendReceiptSchema.parse({
      id: crypto.randomUUID(),
      accountId: this.#config.accountId,
      messageId: result.messageId,
      accepted: result.accepted.map(deliveryAddress),
      rejected: result.rejected.map(deliveryAddress),
      submittedAt,
    });
  }

  #assertAccount(accountId: string): void {
    if (accountId !== this.#config.accountId) {
      throw new Error(`SMTP sender for account ${this.#config.accountId} cannot send for account ${accountId}`);
    }
  }
}

function deliveryAddress(recipient: SmtpDeliveryRecipient): string {
  return typeof recipient === "string" ? recipient : recipient.address;
}
