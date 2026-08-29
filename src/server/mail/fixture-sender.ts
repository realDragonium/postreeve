import {
  sendMessageInputSchema,
  sendReceiptSchema,
  type OutboundAddress,
  type SendMessageInput,
  type SendReceipt,
} from "../../shared/contracts";
import type { MailSender } from "./sender";

export interface FixtureMailSenderConfig {
  readonly accountId: string;
  readonly fromName: string;
  readonly fromAddress: string;
}

export interface FixtureSentMessage {
  readonly from: OutboundAddress;
  readonly input: SendMessageInput;
  readonly receipt: SendReceipt;
}

export type FixtureSentMessageCallback = (
  message: FixtureSentMessage,
) => void | Promise<void>;

const discardFixtureMessage: FixtureSentMessageCallback = () => {};

export class FixtureMailSender implements MailSender {
  readonly #config: FixtureMailSenderConfig;
  readonly #onSent: FixtureSentMessageCallback;

  constructor(config: FixtureMailSenderConfig, onSent: FixtureSentMessageCallback = discardFixtureMessage) {
    if (!config.accountId) throw new Error("A fixture account ID is required");
    this.#config = { ...config };
    this.#onSent = onSent;
  }

  async send(rawInput: SendMessageInput): Promise<SendReceipt> {
    const input = sendMessageInputSchema.parse(rawInput);
    this.#assertAccount(input.accountId);

    const id = crypto.randomUUID();
    const receipt = sendReceiptSchema.parse({
      id,
      accountId: this.#config.accountId,
      messageId: `<${id}@fixture.postreeve.local>`,
      accepted: [...input.to, ...input.cc, ...input.bcc].map(({ address }) => address),
      rejected: [],
      submittedAt: new Date().toISOString(),
    });

    await this.#onSent({
      from: { name: this.#config.fromName, address: this.#config.fromAddress },
      input: structuredClone(input),
      receipt: structuredClone(receipt),
    });
    return receipt;
  }

  #assertAccount(accountId: string): void {
    if (accountId !== this.#config.accountId) {
      throw new Error(`Fixture sender for account ${this.#config.accountId} cannot send for account ${accountId}`);
    }
  }
}
