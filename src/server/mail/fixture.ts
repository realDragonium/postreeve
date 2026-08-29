import type {
  Folder,
  MessageDetail,
  MessageRef,
  MessageSummary,
  SendMessageInput,
  TriageAction,
} from "../../shared/contracts";
import type { AppliedMailAction, MailProvider } from "./provider";

interface FixtureMessage extends MessageDetail {
  mailbox: string;
}

const uidValidity = "1723371481";

export class FixtureMailProvider implements MailProvider {
  readonly #accountId: string;
  readonly #messages: FixtureMessage[];

  constructor(accountId: string) {
    this.#accountId = accountId;
    this.#messages = seedMessages(accountId);
  }

  async listFolders(accountId: string): Promise<Folder[]> {
    this.#assertAccount(accountId);
    return [
      this.#folder("INBOX", "Inbox", "inbox"),
      this.#folder("Archive", "Archive", "archive"),
      this.#folder("Sent", "Sent", "sent"),
      this.#folder("Trash", "Trash", "trash"),
    ];
  }

  async listMessages(accountId: string, mailbox: string, limit: number): Promise<MessageSummary[]> {
    this.#assertAccount(accountId);
    return this.#messages
      .filter((message) => message.mailbox === mailbox)
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, limit)
      .map(toSummary);
  }

  async readMessages(accountId: string, references: MessageRef[]): Promise<MessageDetail[]> {
    this.#assertAccount(accountId);
    return references.map((reference) => {
      const message = this.#find(reference);
      if (!message) throw new Error(`Message UID ${reference.uid} is stale or missing`);
      return toDetail(message);
    });
  }

  async searchMessages(accountId: string, mailbox: string, query: string, limit: number): Promise<MessageSummary[]> {
    this.#assertAccount(accountId);
    const needle = query.toLocaleLowerCase();
    return this.#messages
      .filter((message) => message.mailbox === mailbox)
      .filter((message) => [message.subject, message.preview, message.text, ...message.from.map((from) => from.address)]
        .some((value) => value.toLocaleLowerCase().includes(needle)))
      .slice(0, limit)
      .map(toSummary);
  }

  async revalidate(reference: MessageRef): Promise<boolean> {
    return this.#find(reference) !== undefined;
  }

  async apply(reference: MessageRef, action: TriageAction): Promise<AppliedMailAction> {
    const message = this.#find(reference);
    if (!message) throw new Error(`Message UID ${reference.uid} changed or no longer exists`);
    const previous = structuredClone(message.ref);
    const previousRead = message.read;

    switch (action.type) {
      case "leave":
        break;
      case "mark_read":
        message.read = true;
        break;
      case "mark_unread":
        message.read = false;
        break;
      case "move":
        message.mailbox = action.destination;
        message.ref.mailbox = action.destination;
        break;
      case "trash":
        message.mailbox = "Trash";
        message.ref.mailbox = "Trash";
        break;
    }
    message.ref.modseq = String(Number(message.ref.modseq ?? "0") + 1);
    return { current: structuredClone(message.ref), previous, action, previousRead };
  }

  async undo(applied: AppliedMailAction): Promise<void> {
    const message = this.#find(applied.current);
    if (!message) throw new Error(`Applied message UID ${applied.current.uid} changed or no longer exists`);
    message.mailbox = applied.previous.mailbox;
    message.read = applied.previousRead;
    message.ref = {
      ...applied.previous,
      modseq: String(Number(message.ref.modseq ?? "0") + 1),
    };
  }

  appendSent(input: SendMessageInput, messageId: string, sentAt: string): MessageRef {
    this.#assertAccount(input.accountId);
    const uid = Math.max(0, ...this.#messages.map((message) => message.ref.uid)) + 1;
    const reference: MessageRef = {
      accountId: this.#accountId,
      mailbox: "Sent",
      uidValidity,
      uid,
      modseq: "1",
    };
    this.#messages.push({
      ref: reference,
      mailbox: "Sent",
      messageId,
      subject: input.subject,
      from: [{ name: "Postreeve Demo", address: "demo@postreeve.local" }],
      to: input.to,
      receivedAt: sentAt,
      preview: input.text.replace(/\s+/g, " ").trim().slice(0, 240),
      text: input.text,
      html: null,
      read: true,
      flagged: false,
    });
    return reference;
  }

  #folder(path: string, name: string, specialUse: Folder["specialUse"]): Folder {
    const messages = this.#messages.filter((message) => message.mailbox === path);
    return {
      path,
      name,
      specialUse,
      total: messages.length,
      unread: messages.filter((message) => !message.read).length,
    };
  }

  #find(reference: MessageRef): FixtureMessage | undefined {
    if (reference.accountId !== this.#accountId || reference.uidValidity !== uidValidity) return undefined;
    return this.#messages.find((message) =>
      message.mailbox === reference.mailbox
      && message.ref.uid === reference.uid
      && message.ref.modseq === reference.modseq
    );
  }

  #assertAccount(accountId: string): void {
    if (accountId !== this.#accountId) throw new Error("Account isolation violation");
  }
}

function toSummary(message: FixtureMessage): MessageSummary {
  const { html: _html, text: _text, mailbox: _mailbox, ...summary } = message;
  return structuredClone(summary);
}

function toDetail(message: FixtureMessage): MessageDetail {
  const { mailbox: _mailbox, ...detail } = message;
  return structuredClone(detail);
}

function seedMessages(accountId: string): FixtureMessage[] {
  const address = (name: string, email: string) => ({ name, address: email });
  const ref = (uid: number, mailbox = "INBOX"): MessageRef => ({
    accountId,
    mailbox,
    uidValidity,
    uid,
    modseq: "1",
  });
  return [
    {
      ref: ref(104),
      mailbox: "INBOX",
      messageId: "<launch-review@postreeve.dev>",
      subject: "Postreeve launch review",
      from: [address("Maya Chen", "maya@example.com")],
      to: [address("Demo User", "demo@postreeve.local")],
      receivedAt: "2026-08-29T09:30:00.000Z",
      preview: "The launch checklist is ready. Could you review the final three items?",
      text: "Hi!\n\nThe launch checklist is ready. Could you review the final three items before our demo?\n\nThanks,\nMaya",
      html: "<p>Hi!</p><p>The <strong>launch checklist</strong> is ready. Could you review the final three items before our demo?</p><img src=\"https://tracker.example/pixel.png\" alt=\"\"><p>Thanks,<br>Maya</p>",
      read: false,
      flagged: true,
    },
    {
      ref: ref(103),
      mailbox: "INBOX",
      messageId: "<digest@example.net>",
      subject: "Your weekly engineering digest",
      from: [address("Engineering Weekly", "digest@example.net")],
      to: [address("Demo User", "demo@postreeve.local")],
      receivedAt: "2026-08-28T16:00:00.000Z",
      preview: "This week: local-first software, typed APIs, and agent tools.",
      text: "This week: local-first software, typed APIs, and agent tools.\n\nManage preferences on our website.",
      html: null,
      read: false,
      flagged: false,
    },
    {
      ref: ref(102),
      mailbox: "INBOX",
      messageId: "<receipt@cloud.example>",
      subject: "Receipt for August",
      from: [address("Cloud Hosting", "billing@cloud.example")],
      to: [address("Demo User", "demo@postreeve.local")],
      receivedAt: "2026-08-27T11:15:00.000Z",
      preview: "Your payment was successful. No action is required.",
      text: "Your payment was successful. No action is required. Total: $18.00.",
      html: "<p>Your payment was successful. <strong>No action is required.</strong></p>",
      read: true,
      flagged: false,
    },
    {
      ref: ref(101, "Archive"),
      mailbox: "Archive",
      messageId: "<welcome@postreeve.dev>",
      subject: "Welcome to Postreeve",
      from: [address("Postreeve", "hello@postreeve.dev")],
      to: [address("Demo User", "demo@postreeve.local")],
      receivedAt: "2026-08-20T08:00:00.000Z",
      preview: "Your human-in-the-loop mailbox is ready.",
      text: "Your human-in-the-loop mailbox is ready.",
      html: null,
      read: true,
      flagged: false,
    },
  ];
}
