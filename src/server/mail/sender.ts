import type { SendMessageInput, SendReceipt } from "../../shared/contracts";

export interface MailSender {
  send(input: SendMessageInput): Promise<SendReceipt>;
}

export class MailSenderRegistry {
  readonly #senders = new Map<string, MailSender>();

  register(accountId: string, sender: MailSender): void {
    this.#senders.set(accountId, sender);
  }

  forAccount(accountId: string): MailSender {
    const sender = this.#senders.get(accountId);
    if (!sender) throw new Error(`No outgoing mail provider is configured for account ${accountId}`);
    return sender;
  }
}
