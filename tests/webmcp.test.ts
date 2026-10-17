import { mailboxPageSchema, type MailboxPage } from "../src/shared/mailbox-query";
import { defaultRetentionPolicy, type AccountHealth, type SynchronizationStatus, type Reauthorization } from "../src/shared/synchronization";
import { describe, expect, test } from "bun:test";

import type {
  Account,
  CanonicalMessageDetail,
  CanonicalMessageSummary,
  CreateFolderInput,
  DeleteFolderInput,
  DirectActionInput,
  Folder,
  MessageRef,
  CreateDraftInput,
  CreateProposalInput,
  Draft,
  Identity,
  Signature,
  UpdateDraftInput,
  OperationBatch,
  Proposal,
  RenameFolderInput,
  UpdateProposalInput,
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

const message: CanonicalMessageSummary = {
  canonicalId: "canonical-message-1",
  canonicalAliases: [],
  conversationId: "conversation-1",
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

const coverage: MailboxPage["coverage"] = { sources: [], complete: false, bodyTextLimit: 32768 };
function page(messages: readonly CanonicalMessageSummary[]): MailboxPage { return { messages: [...messages], nextCursor: null, coverage }; }

const messageDetail: CanonicalMessageDetail = {
  attachments: [],
  ...message,
  text: "Untrusted email body",
  html: null,
};

const olderUnreadMessage: CanonicalMessageSummary = {
  ...message,
  canonicalId: "canonical-message-older",
  ref: { ...message.ref, uid: 6 },
  messageId: "message-older@example.test",
  subject: "Older matching subject",
  receivedAt: "2026-08-28T12:00:00.000Z",
  flagged: true,
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

const proposal: Proposal = {
  id: "8b0a3f8e-3f0e-4f43-9a43-5a2b8b6f1c11",
  accountId: account.id,
  title: "Tidy newsletters",
  status: "draft",
  items: [{ id: "item-1", message: messageRef, subject: "Weekly", action: { type: "trash" }, reason: "Newsletter" }],
  createdAt: "2026-08-29T12:01:00.000Z",
  updatedAt: "2026-08-29T12:01:00.000Z",
  approvedAt: null,
  batchId: null,
};

const draft: Draft = {
  id: "11111111-1111-4111-8111-111111111111",
  accountId: account.id,
  mode: "new", to: [], cc: [], bcc: [], subject: "Hello", format: "plain", body: "Hi",
  identity: { name: account.name, address: account.email }, attachments: [],
  delivery: { status: "editable" }, mirror: { status: "pending" },
  createdAt: "2026-08-29T12:00:00.000Z", updatedAt: "2026-08-29T12:00:00.000Z", version: 3,
};

const health: AccountHealth = { account, state: "catching-up", coverage: "partial", lastSuccessAt: null,
  failure: null, guidance: "Catching up", retryAvailable: true, nextAttemptAt: 0, retainedContentBytes: 0 };

class FakeServices implements WebMcpServices {
  async inspectSynchronization(signal: AbortSignal): Promise<SynchronizationStatus> {
    this.lastSignal = signal;
    return { accounts: [health], retention: defaultRetentionPolicy };
  }
  async retrySynchronization(_id: string, signal: AbortSignal): Promise<AccountHealth> {
    this.lastSignal = signal;
    return health;
  }
  async requestReauthorization(id: string, signal: AbortSignal): Promise<Reauthorization> {
    this.lastSignal = signal;
    return { accountId: id, method: "account-settings", instructions: "Manage this account in Settings." };
  }
  readonly createFolderCalls: CreateFolderInput[] = [];
  readonly renameFolderCalls: RenameFolderInput[] = [];
  readonly deleteFolderCalls: DeleteFolderInput[] = [];
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

  async createFolder(input: CreateFolderInput, signal: AbortSignal): Promise<readonly Folder[]> {
    this.lastSignal = signal;
    this.createFolderCalls.push(input);
    return [folder];
  }

  async renameFolder(input: RenameFolderInput, signal: AbortSignal): Promise<readonly Folder[]> {
    this.lastSignal = signal;
    this.renameFolderCalls.push(input);
    return [folder];
  }

  async deleteFolder(input: DeleteFolderInput, signal: AbortSignal): Promise<readonly Folder[]> {
    this.lastSignal = signal;
    this.deleteFolderCalls.push(input);
    return [folder];
  }

  async listMessages(input: WebMcpListMessagesInput, signal: AbortSignal): Promise<MailboxPage> {
    this.lastSignal = signal;
    this.listCalls.push(input);
    return page([message]);
  }

  async readMessages(_messages: readonly MessageRef[], signal: AbortSignal): Promise<readonly CanonicalMessageDetail[]> {
    this.lastSignal = signal;
    return [messageDetail];
  }

  async searchMessages(
    _input: WebMcpSearchMessagesInput,
    signal: AbortSignal,
  ): Promise<MailboxPage> {
    this.lastSignal = signal;
    return page([olderUnreadMessage, message]);
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

  readonly conversationCalls: string[] = [];
  readonly proposalCreates: CreateProposalInput[] = [];
  readonly proposalUpdates: Array<[string, UpdateProposalInput]> = [];
  readonly listCalls: WebMcpListMessagesInput[] = [];

  async readConversation(conversationId: string, signal: AbortSignal): Promise<readonly CanonicalMessageDetail[]> {
    this.lastSignal = signal;
    this.conversationCalls.push(conversationId);
    return [messageDetail];
  }

  async listProposals(_accountId: string, signal: AbortSignal): Promise<readonly Proposal[]> {
    this.lastSignal = signal;
    return [proposal];
  }

  async createProposal(input: CreateProposalInput, signal: AbortSignal): Promise<Proposal> {
    this.lastSignal = signal;
    this.proposalCreates.push(input);
    return { ...proposal, title: input.title, items: input.items };
  }

  readonly draftCreates: CreateDraftInput[] = [];
  readonly draftUpdates: Array<[string, UpdateDraftInput]> = [];

  async listIdentities(): Promise<readonly Identity[]> {
    return [{ id: "i1", accountId: account.id, name: "Sales", address: "sales@example.test", createdAt: "2026-08-29T12:00:00.000Z" }];
  }

  async listSignatures(): Promise<readonly Signature[]> {
    return [{ address: account.email, html: "<p>— Person</p>" }];
  }

  async listDrafts(): Promise<readonly Draft[]> {
    return [draft];
  }

  async getDraft(): Promise<Draft> {
    return draft;
  }

  async createDraft(input: CreateDraftInput): Promise<Draft> {
    this.draftCreates.push(input);
    const { accountId: _accountId, clientId: _clientId, ...content } = input;
    return { ...draft, ...content };
  }

  async updateDraft(_accountId: string, draftId: string, input: UpdateDraftInput): Promise<Draft> {
    this.draftUpdates.push([draftId, input]);
    const { version: _version, ...content } = input;
    return { ...draft, ...content, version: draft.version + 1 };
  }

  async readAttachment(): Promise<{ mediaType: string; content: Uint8Array }> {
    return { mediaType: "text/plain; charset=utf-8", content: new TextEncoder().encode("hello attachment") };
  }

  async updateProposal(proposalId: string, input: UpdateProposalInput, signal: AbortSignal): Promise<Proposal> {
    this.lastSignal = signal;
    this.proposalUpdates.push([proposalId, input]);
    return { ...proposal, status: input.status ?? proposal.status };
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
      "inspect_synchronization", "retry_synchronization", "request_reauthorization",
      "list_accounts",
      "list_folders",
      "create_folder",
      "rename_folder",
      "delete_folder",
      "list_messages",
      "read_messages",
      "search_messages",
      "send_message",
      "apply_message_actions",
      "list_activity",
      "undo_batch",
      "read_conversation",
      "list_proposals",
      "create_proposal",
      "update_proposal",
      "list_identities",
      "list_signatures",
      "list_drafts",
      "read_draft",
      "read_attachment",
      "create_draft",
      "update_draft",
    ];

    expect(registration?.toolNames).toEqual(expectedNames);
    expect([...modelContext.tools.keys()]).toEqual(expectedNames);
    expect(modelContext.tool("list_messages").inputSchema).toMatchObject({
      type: "object",
      dependentRequired: { accountId: ["mailbox"], mailbox: ["accountId"] },
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
    expect(await modelContext.tool("inspect_synchronization").execute({}, options)).toEqual({ accounts: [health], retention: defaultRetentionPolicy });
    expect(services.lastSignal).toBe(controller.signal);
    expect(await modelContext.tool("retry_synchronization").execute({ accountId: account.id }, options)).toEqual(health);
    expect(services.lastSignal).toBe(controller.signal);
    expect(await modelContext.tool("request_reauthorization").execute({ accountId: account.id }, options)).toMatchObject({ method: "account-settings" });
    expect(services.lastSignal).toBe(controller.signal);
    await expect(modelContext.tool("request_reauthorization").execute({ accountId: account.id, password: "not accepted" }, options)).rejects.toThrow();
    expect(await modelContext.tool("list_accounts").execute({}, options)).toEqual([account]);
    expect(services.lastSignal).toBe(controller.signal);
    expect(
      await modelContext.tool("list_folders").execute({ accountId: account.id }, executeOptions()),
    ).toEqual([folder]);
    expect(
      await modelContext.tool("create_folder").execute(
        { accountId: account.id, name: "Projects" },
        executeOptions(),
      ),
    ).toEqual([folder]);
    expect(
      await modelContext.tool("rename_folder").execute(
        { accountId: account.id, path: "Projects", name: "Clients" },
        executeOptions(),
      ),
    ).toEqual([folder]);
    expect(
      await modelContext.tool("delete_folder").execute(
        { accountId: account.id, path: "Clients" },
        executeOptions(),
      ),
    ).toEqual([folder]);
    expect(services.createFolderCalls).toEqual([{ accountId: account.id, name: "Projects" }]);
    expect(services.renameFolderCalls).toEqual([{ accountId: account.id, path: "Projects", name: "Clients" }]);
    expect(services.deleteFolderCalls).toEqual([{ accountId: account.id, path: "Clients" }]);
    expect(
      await modelContext.tool("list_messages").execute(
        { accountId: account.id, mailbox: "INBOX" },
        executeOptions(),
      ),
    ).toEqual(page([message]));
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
    ).toEqual(page([olderUnreadMessage, message]));
    expect(services.mailboxViews).toEqual([
      {
        accountId: account.id,
        mailbox: "INBOX",
        limit: 50,
        filter: "all",
        sort: "newest",
        query: "",
        ...page([message]),
      },
      {
        accountId: account.id,
        mailbox: "INBOX",
        limit: 50,
        filter: "unread",
        sort: "oldest",
        query: "subject",
        ...page([olderUnreadMessage, message]),
      },
    ]);
    expect(
      await modelContext.tool("send_message").execute(sendToolInput, executeOptions()),
    ).toEqual(receipt);
    expect(services.sendCalls).toEqual([sendInput]);
    const directActionInput: DirectActionInput = {
      accountId: account.id,
      items: [
        { message: messageRef, subject: message.subject, action: { type: "mark_read" } },
        { message: messageRef, subject: message.subject, action: { type: "flag" } },
        { message: messageRef, subject: message.subject, action: { type: "unflag" } },
      ],
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

  test("prepares proposals but never approves or applies them", async () => {
    const services = new FakeServices();
    const tools = createPostreeveWebMcpTools(services);
    const names = tools.map(({ name }) => name);
    expect(names.filter((name) => /approve|apply_proposal|apply_approved/.test(name))).toEqual([]);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const created = await byName.get("create_proposal")!.execute({
      accountId: account.id, title: "Tidy newsletters",
      items: [{ message: messageRef, subject: "Weekly", action: { type: "trash" }, reason: "Newsletter" }],
    }, executeOptions());
    expect(created).toMatchObject({ status: "draft", approvedAt: null });
    expect(services.proposalCreates[0]!.items[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(byName.get("update_proposal")!.execute({ proposalId: proposal.id, status: "approved" }, executeOptions()))
      .rejects.toThrow();
    expect(services.proposalUpdates).toEqual([]);
    expect(await byName.get("update_proposal")!.execute({ proposalId: proposal.id, status: "review" }, executeOptions()))
      .toMatchObject({ status: "review" });
    expect(await byName.get("list_proposals")!.execute({ accountId: account.id }, executeOptions())).toEqual([proposal]);
    expect(await byName.get("read_conversation")!.execute({ conversationId: "conversation-1" }, executeOptions()))
      .toEqual([messageDetail]);
    expect(services.conversationCalls).toEqual(["conversation-1"]);
    const actions = tools.find(({ name }) => name === "apply_message_actions");
    if (!actions) throw new Error("Missing apply_message_actions tool");
    await expect(actions.execute({
      accountId: account.id,
      items: [{ message: messageRef, subject: message.subject, action: { type: "leave" } }],
    }, executeOptions())).rejects.toThrow();
    expect(services.directActionCalls).toEqual([]);
  });

  test("drafts replies from a chosen identity, merges updates, reads attachments and never sends", async () => {
    const services = new FakeServices();
    const tools = new Map(createPostreeveWebMcpTools(services).map((tool) => [tool.name, tool]));
    expect([...tools.keys()].filter((name) => name.includes("send") && name !== "send_message")).toEqual([]);
    await expect(tools.get("create_draft")!.execute({ accountId: account.id, mode: "reply", to: [], subject: "Re: x", body: "y" }, executeOptions()))
      .rejects.toThrow();
    const source = { canonicalMessageId: message.canonicalId, conversationId: message.conversationId };
    await tools.get("create_draft")!.execute({
      accountId: account.id, mode: "reply", source, from: "SALES@example.test", to: ["a@example.test"], subject: "Re: x", body: "Thanks",
    }, executeOptions());
    expect(services.draftCreates[0]).toMatchObject({
      mode: "reply", source, identity: { name: "Sales", address: "sales@example.test" },
      to: [{ name: "", address: "a@example.test" }], cc: [], bcc: [], format: "plain", attachments: [],
    });
    await tools.get("update_draft")!.execute({ accountId: account.id, draftId: draft.id, version: 3, body: "Edited" }, executeOptions());
    expect(services.draftUpdates[0]).toEqual([draft.id, expect.objectContaining({ body: "Edited", subject: "Hello", version: 3 })]);
    expect(services.sendCalls).toEqual([]);
    expect(await tools.get("read_attachment")!.execute({ accountId: account.id, canonicalMessageId: "m", reference: "r" }, executeOptions()))
      .toEqual({ mediaType: "text/plain; charset=utf-8", size: 16, encoding: "text", content: "hello attachment" });
  });

  test("lists every account inbox when no source is given", async () => {
    const services = new FakeServices();
    const tool = createPostreeveWebMcpTools(services).find(({ name }) => name === "list_messages")!;
    await tool.execute({ filter: "unread" }, executeOptions());
    expect(services.listCalls[0]).toMatchObject({ sources: [{ accountId: account.id, mailbox: "INBOX" }], filter: "unread" });
    await expect(tool.execute({ accountId: account.id }, executeOptions())).rejects.toThrow();
  });

  test("rejects message results without a canonical ID", async () => {
    class MissingCanonicalIdServices extends FakeServices {
      override async listMessages(
        input: WebMcpListMessagesInput,
        signal: AbortSignal,
      ): Promise<MailboxPage> {
        const [result] = (await super.listMessages(input, signal)).messages;
        if (!result) return page([]);
        const invalid = structuredClone(result);
        Reflect.deleteProperty(invalid, "canonicalId");
        return page([invalid]);
      }

      override async searchMessages(
        input: WebMcpSearchMessagesInput,
        signal: AbortSignal,
      ): Promise<MailboxPage> {
        const results = (await super.searchMessages(input, signal)).messages;
        const result = results[0];
        if (!result) return page([]);
        const invalid = structuredClone(result);
        Reflect.deleteProperty(invalid, "canonicalId");
        return page([invalid, ...results.slice(1)]);
      }

      override async readMessages(
        messages: readonly MessageRef[],
        signal: AbortSignal,
      ): Promise<readonly CanonicalMessageDetail[]> {
        const results = [...await super.readMessages(messages, signal)];
        const result = results[0];
        if (!result) return [];
        const invalid = structuredClone(result);
        Reflect.deleteProperty(invalid, "canonicalId");
        return [invalid];
      }
    }

    const tools = createPostreeveWebMcpTools(new MissingCanonicalIdServices());
    const list = tools.find(({ name }) => name === "list_messages");
    const read = tools.find(({ name }) => name === "read_messages");
    const search = tools.find(({ name }) => name === "search_messages");
    if (!list || !read || !search) throw new Error("Missing message tools");

    await expect(list.execute({ accountId: account.id, mailbox: "INBOX" }, executeOptions())).rejects.toThrow();
    await expect(read.execute({ messages: [messageRef] }, executeOptions())).rejects.toThrow();
    await expect(search.execute({
      accountId: account.id,
      mailbox: "INBOX",
      query: "subject",
      filter: "all",
      sort: "newest",
    }, executeOptions())).rejects.toThrow();
  });

  test("returns one canonical summary from mocked list and search services", async () => {
    const duplicate: CanonicalMessageSummary = {
      ...message,
      canonicalAliases: ["retired-canonical"],
      ref: { ...message.ref, uid: 9 },
      preview: "Duplicate delivery",
      read: true,
      flagged: true,
    };
    class DuplicateServices extends FakeServices {
      override async listMessages(
        input: WebMcpListMessagesInput,
        signal: AbortSignal,
      ): Promise<MailboxPage> {
        return page([...(await super.listMessages(input, signal)).messages, duplicate]);
      }

      override async searchMessages(
        _input: WebMcpSearchMessagesInput,
        _signal: AbortSignal,
      ): Promise<MailboxPage> {
        return page([message, duplicate]);
      }
    }

    const services = new DuplicateServices();
    const tools = createPostreeveWebMcpTools(services);
    const list = tools.find(({ name }) => name === "list_messages");
    const search = tools.find(({ name }) => name === "search_messages");
    if (!list || !search) throw new Error("Missing message listing tools");

    const listed = mailboxPageSchema.parse(
      await list.execute({ accountId: account.id, mailbox: "INBOX" }, executeOptions()),
    ).messages;
    const searched = mailboxPageSchema.parse(await search.execute({
      accountId: account.id,
      mailbox: "INBOX",
      query: "subject",
      filter: "all",
      sort: "newest",
    }, executeOptions())).messages;

    expect(listed).toEqual([{ ...message, canonicalAliases: ["retired-canonical"] }]);
    expect(searched).toEqual([{ ...message, canonicalAliases: ["retired-canonical"] }]);
    expect(services.mailboxViews.map(({ messages }) => messages)).toEqual([listed, searched]);
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
