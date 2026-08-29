import { describe, expect, test } from "bun:test";

import type {
  Account,
  DirectActionInput,
  Folder,
  MessageDetail,
  MessageRef,
  MessageSummary,
  OperationBatch,
  SendMessageInput,
  SendReceipt,
} from "../src/shared/contracts.ts";
import {
  createPostreeveWebMcpTools,
  registerPostreeveWebMcp,
  resolveWebMcpModelContext,
  type WebMcpExecuteOptions,
  type WebMcpListMessagesInput,
  type WebMcpMailboxView,
  type WebMcpModelContext,
  type WebMcpRegisterOptions,
  type WebMcpServices,
  type WebMcpSearchMessagesInput,
  type WebMcpTool,
} from "../src/server/webmcp/index.ts";

const account: Account = {
  id: "account-1",
  name: "Work mailbox",
  email: "person@example.test",
  kind: "imap",
};

const folder: Folder = {
  path: "INBOX",
  name: "Inbox",
  specialUse: "inbox",
  unread: 1,
  total: 1,
};

const messageRef: MessageRef = {
  accountId: account.id,
  mailbox: folder.path,
  uidValidity: "42",
  uid: 7,
  modseq: "9",
};

const message: MessageSummary = {
  ref: messageRef,
  messageId: "message-1@example.test",
  subject: "Untrusted message subject",
  from: [{ name: "Sender", address: "sender@example.test" }],
  to: [{ name: "Person", address: account.email }],
  deliveredTo: ["catchall+work@example.test"],
  receivedAt: "2026-08-29T12:00:00.000Z",
  preview: "Untrusted email preview",
  read: false,
  flagged: false,
};

const messageDetail: MessageDetail = {
  ...message,
  text: "Untrusted email body",
  html: null,
};

const olderUnreadMessage: MessageSummary = {
  ...message,
  ref: { ...message.ref, uid: 6 },
  messageId: "message-older@example.test",
  subject: "Older matching subject",
  receivedAt: "2026-08-28T12:00:00.000Z",
  flagged: true,
};

const readMessage: MessageSummary = {
  ...message,
  ref: { ...message.ref, uid: 8 },
  messageId: "message-read@example.test",
  subject: "Read matching subject",
  receivedAt: "2026-08-27T12:00:00.000Z",
  read: true,
};

const sendInput: SendMessageInput = {
  accountId: account.id,
  to: [{ name: "", address: "recipient@example.test" }],
  cc: [],
  bcc: [],
  subject: "Approved message",
  text: "This message was approved by the user.",
};
const sendToolInput = {
  accountId: account.id,
  to: ["recipient@example.test"],
  cc: [],
  bcc: [],
  subject: sendInput.subject,
  text: sendInput.text,
};

const receipt: SendReceipt = {
  id: "sent-1",
  accountId: account.id,
  messageId: "sent-message@example.test",
  accepted: ["recipient@example.test"],
  rejected: [],
  submittedAt: "2026-08-29T12:00:30.000Z",
};

const batch: OperationBatch = {
  id: "batch-1",
  proposalId: "direct-action-1",
  accountId: account.id,
  status: "applied",
  operations: [
    {
      itemId: "item-1",
      message: messageRef,
      action: { type: "mark_read" },
      status: "applied",
      error: null,
    },
  ],
  createdAt: "2026-08-29T12:01:00.000Z",
  updatedAt: "2026-08-29T12:01:00.000Z",
};

class FakeServices implements WebMcpServices {
  readonly sendCalls: SendMessageInput[] = [];
  readonly directActionCalls: DirectActionInput[] = [];
  readonly activityCalls: string[] = [];
  readonly mailboxViews: WebMcpMailboxView[] = [];
  lastSignal: AbortSignal | null = null;

  async listAccounts(signal: AbortSignal): Promise<readonly Account[]> {
    this.lastSignal = signal;
    return [account];
  }

  async listFolders(_accountId: string, signal: AbortSignal): Promise<readonly Folder[]> {
    this.lastSignal = signal;
    return [folder];
  }

  async listMessages(_input: WebMcpListMessagesInput, signal: AbortSignal): Promise<readonly MessageSummary[]> {
    this.lastSignal = signal;
    return [message];
  }

  async readMessages(_messages: readonly MessageRef[], signal: AbortSignal): Promise<readonly MessageDetail[]> {
    this.lastSignal = signal;
    return [messageDetail];
  }

  async searchMessages(
    _input: WebMcpSearchMessagesInput,
    signal: AbortSignal,
  ): Promise<readonly MessageSummary[]> {
    this.lastSignal = signal;
    return [message, olderUnreadMessage, readMessage];
  }

  async sendMessage(input: SendMessageInput, signal: AbortSignal): Promise<SendReceipt> {
    this.lastSignal = signal;
    this.sendCalls.push(input);
    return receipt;
  }

  async applyMessageActions(input: DirectActionInput, signal: AbortSignal): Promise<OperationBatch> {
    this.lastSignal = signal;
    this.directActionCalls.push(input);
    return batch;
  }

  async listActivity(accountId: string, signal: AbortSignal): Promise<readonly OperationBatch[]> {
    this.lastSignal = signal;
    this.activityCalls.push(accountId);
    return [batch];
  }

  async undoBatch(_batchId: string, signal: AbortSignal): Promise<OperationBatch> {
    this.lastSignal = signal;
    return { ...batch, status: "undone" };
  }

  showMailboxView(view: WebMcpMailboxView): void {
    this.mailboxViews.push(view);
  }
}

class FakeModelContext implements WebMcpModelContext {
  readonly tools = new Map<string, WebMcpTool>();

  async registerTool(tool: WebMcpTool, options?: WebMcpRegisterOptions): Promise<void> {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => this.tools.delete(tool.name), { once: true });
  }

  tool(name: string): WebMcpTool {
    const tool = this.tools.get(name);
    if (tool === undefined) {
      throw new Error(`Missing tool: ${name}`);
    }
    return tool;
  }
}

const executeOptions = (): WebMcpExecuteOptions => ({ signal: new AbortController().signal });

describe("Postreeve WebMCP", () => {
  test("registers the complete strongly typed tool contract and disposes it", async () => {
    const services = new FakeServices();
    const modelContext = new FakeModelContext();
    const registration = await registerPostreeveWebMcp(services, modelContext);

    const expectedNames = [
      "list_accounts",
      "list_folders",
      "list_messages",
      "read_messages",
      "search_messages",
      "send_message",
      "apply_message_actions",
      "list_activity",
      "undo_batch",
    ];

    expect(registration?.toolNames).toEqual(expectedNames);
    expect([...modelContext.tools.keys()]).toEqual(expectedNames);
    expect(modelContext.tool("list_messages").inputSchema).toMatchObject({
      type: "object",
      required: ["accountId", "mailbox"],
    });
    expect(modelContext.tool("list_messages").annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });
    expect(modelContext.tool("send_message").annotations?.readOnlyHint).toBe(false);
    expect(modelContext.tool("apply_message_actions").annotations).toEqual({
      readOnlyHint: false,
      untrustedContentHint: true,
    });
    expect(modelContext.tool("list_activity").annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
    });

    registration?.dispose();
    expect(modelContext.tools.size).toBe(0);
  });

  test("validates inputs, routes calls, validates outputs, and forwards cancellation", async () => {
    const services = new FakeServices();
    const tools = createPostreeveWebMcpTools(services);
    const modelContext = new FakeModelContext();
    for (const tool of tools) {
      await modelContext.registerTool(tool);
    }

    const controller = new AbortController();
    const options = { signal: controller.signal };
    expect(await modelContext.tool("list_accounts").execute({}, options)).toEqual([account]);
    expect(services.lastSignal).toBe(controller.signal);
    expect(
      await modelContext.tool("list_folders").execute({ accountId: account.id }, executeOptions()),
    ).toEqual([folder]);
    expect(
      await modelContext.tool("list_messages").execute(
        { accountId: account.id, mailbox: "INBOX" },
        executeOptions(),
      ),
    ).toEqual([message]);
    expect(
      await modelContext.tool("read_messages").execute({ messages: [messageRef] }, executeOptions()),
    ).toEqual([messageDetail]);
    expect(
      await modelContext.tool("search_messages").execute(
        {
          accountId: account.id,
          mailbox: "INBOX",
          query: "subject",
          filter: "unread",
          sort: "oldest",
        },
        executeOptions(),
      ),
    ).toEqual([olderUnreadMessage, message]);
    expect(services.mailboxViews).toEqual([
      {
        accountId: account.id,
        mailbox: "INBOX",
        limit: 50,
        filter: "all",
        sort: "newest",
        query: "",
        messages: [message],
      },
      {
        accountId: account.id,
        mailbox: "INBOX",
        limit: 50,
        filter: "unread",
        sort: "oldest",
        query: "subject",
        messages: [message, olderUnreadMessage, readMessage],
      },
    ]);
    expect(
      await modelContext.tool("send_message").execute(sendToolInput, executeOptions()),
    ).toEqual(receipt);
    expect(services.sendCalls).toEqual([sendInput]);
    const directActionInput: DirectActionInput = {
      accountId: account.id,
      items: [{ message: messageRef, subject: message.subject, action: { type: "mark_read" } }],
    };
    expect(
      await modelContext.tool("apply_message_actions").execute(directActionInput, executeOptions()),
    ).toEqual(batch);
    expect(services.directActionCalls).toEqual([directActionInput]);
    expect(
      await modelContext.tool("list_activity").execute({ accountId: account.id }, executeOptions()),
    ).toEqual([batch]);
    expect(services.activityCalls).toEqual([account.id]);
    expect(
      await modelContext.tool("undo_batch").execute({ batchId: batch.id }, executeOptions()),
    ).toEqual({ ...batch, status: "undone" });
  });

  test("does not expose agent-only proposals or internal no-op actions", async () => {
    const services = new FakeServices();
    const tools = createPostreeveWebMcpTools(services);
    const names = tools.map(({ name }) => name);
    expect(names).not.toContain("create_triage_proposal");
    expect(names).not.toContain("update_triage_proposal");
    expect(names).not.toContain("apply_approved_proposal");
    const actions = tools.find(({ name }) => name === "apply_message_actions");
    if (!actions) throw new Error("Missing apply_message_actions tool");
    await expect(actions.execute({
      accountId: account.id,
      items: [{ message: messageRef, subject: message.subject, action: { type: "leave" } }],
    }, executeOptions())).rejects.toThrow();
    expect(services.directActionCalls).toEqual([]);
  });

  test("is inert outside a WebMCP-capable browser", async () => {
    const registration = await registerPostreeveWebMcp(new FakeServices(), null);
    expect(registration).toBeNull();
  });

  test("prefers the current document API and supports the navigator fallback", () => {
    const documentContext = new FakeModelContext();
    const navigatorContext = new FakeModelContext();

    expect(
      resolveWebMcpModelContext({
        document: { modelContext: documentContext },
        navigator: { modelContext: navigatorContext },
      }),
    ).toBe(documentContext);
    expect(
      resolveWebMcpModelContext({ navigator: { modelContext: navigatorContext } }),
    ).toBe(navigatorContext);
    expect(resolveWebMcpModelContext({ document: {}, navigator: {} })).toBeNull();
  });
});
