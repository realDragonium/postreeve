import type { MailboxEvent } from "../../shared/mailbox-events";

export type MailboxEventListener = (event: MailboxEvent) => void;

export class MailboxEvents {
  readonly #listeners = new Set<MailboxEventListener>();

  subscribe(listener: MailboxEventListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  publish(event: MailboxEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
