import type { OutgoingBody, OutgoingContent } from "./outgoing-content";
import type { OutboundAddress, SendMessageInput, SendReceipt } from "../../shared/contracts";

interface ConversationSourceContext {
  readonly sourceMessageId: string;
  readonly conversationId: string;
}

export type ConversationSendContext = ConversationSourceContext & ({
  readonly type: "reply" | "reply_all";
  readonly sourceSubject?: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly providerConversationId?: string;
} | {
  readonly type: "forward";
});

/**
 * A send request with its resolved From; without `from` a sender uses the account's primary address.
 * `html`, set only for rich-text drafts, replaces `text` as the body source.
 */
export type OutgoingMessage = SendMessageInput & { readonly from?: OutboundAddress; readonly html?: string };

export function outgoingBody(message: OutgoingMessage): OutgoingBody {
  return message.html === undefined ? { text: message.text } : { html: message.html };
}

export class MailSendPreDispatchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message.trim() || "Mail could not be submitted", options);
    this.name = "MailSendPreDispatchError";
  }
}

export interface SentMessage {
  readonly receipt: SendReceipt;
  readonly mime: Buffer;
}

export interface MailSender {
  verifyConnection(): Promise<void>;
  send(input: OutgoingMessage, context?: ConversationSendContext, content?: OutgoingContent): Promise<SentMessage>;
}

export class MailSenderRegistry {
  readonly #senders = new Map<string, MailSender>();

  register(accountId: string, sender: MailSender): void {
    this.#senders.set(accountId, sender);
  }

  remove(accountId: string): void {
    this.#senders.delete(accountId);
  }

  forAccount(accountId: string): MailSender {
    const sender = this.#senders.get(accountId);
    if (!sender) throw new Error(`No outgoing mail provider is configured for account ${accountId}`);
    return sender;
  }
}
