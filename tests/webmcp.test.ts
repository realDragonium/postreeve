import { describe, expect, test } from "bun:test";

import type {
  Account,
  CreateProposalInput,
  Folder,
  ListMessagesInput,
  MessageDetail,
  MessageRef,
  MessageSummary,
  OperationBatch,
  Proposal,
  UpdateProposalInput,
} from "../src/shared/contracts.ts";
import {
  createPostreeveWebMcpTools,
  registerPostreeveWebMcp,
  resolveWebMcpModelContext,
  type WebMcpExecuteOptions,
  type WebMcpModelContext,
  type WebMcpRegisterOptions,
  type WebMcpServices,
  type WebMcpTool,
} from "../src/server/webmcp/index.ts";

const account: Account = {
  id: "account-1",
  name: "Fixture mailbox",
  email: "fixture@example.test",
  kind: "fixture",
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
  to: [{ name: "Fixture", address: account.email }],
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

const proposal: Proposal = {
  id: "proposal-1",
  accountId: account.id,
  title: "Inbox triage",
  status: "draft",
  items: [
    {
      id: "item-1",
      message: messageRef,
      subject: message.subject,
      action: { type: "mark_read" },
      reason: "Handled",
    },
  ],
  createdAt: "2026-08-29T12:00:00.000Z",
  updatedAt: "2026-08-29T12:00:00.000Z",
  approvedAt: null,
  batchId: null,
};

const batch: OperationBatch = {
  id: "batch-1",
  proposalId: proposal.id,
  accountId: account.id,
  status: "applied",
  operations: [
    {
      itemId: proposal.items[0]?.id ?? "item-1",
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
  readonly updateCalls: Array<{ proposalId: string; input: UpdateProposalInput }> = [];
  readonly applyCalls: string[] = [];
  lastSignal: AbortSignal | null = null;

  async listAccounts(signal: AbortSignal): Promise<readonly Account[]> {
    this.lastSignal = signal;
    return [account];
  }

  async listFolders(_accountId: string, signal: AbortSignal): Promise<readonly Folder[]> {
    this.lastSignal = signal;
    return [folder];
  }

  async listMessages(_input: ListMessagesInput, signal: AbortSignal): Promise<readonly MessageSummary[]> {
    this.lastSignal = signal;
    return [message];
  }

  async readMessages(_messages: readonly MessageRef[], signal: AbortSignal): Promise<readonly MessageDetail[]> {
    this.lastSignal = signal;
    return [messageDetail];
  }

  async searchMessages(
    _input: ListMessagesInput & { query: string },
    signal: AbortSignal,
  ): Promise<readonly MessageSummary[]> {
    this.lastSignal = signal;
    return [message];
  }

  async createProposal(_input: CreateProposalInput, signal: AbortSignal): Promise<Proposal> {
    this.lastSignal = signal;
    return proposal;
  }

  async updateProposal(
    proposalId: string,
    input: UpdateProposalInput,
    signal: AbortSignal,
  ): Promise<Proposal> {
    this.lastSignal = signal;
    this.updateCalls.push({ proposalId, input });
    return proposal;
  }

  async applyProposal(proposalId: string, signal: AbortSignal): Promise<OperationBatch> {
    this.lastSignal = signal;
    this.applyCalls.push(proposalId);
    return batch;
  }

  async undoBatch(_batchId: string, signal: AbortSignal): Promise<OperationBatch> {
    this.lastSignal = signal;
    return { ...batch, status: "undone" };
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
      "create_triage_proposal",
      "update_triage_proposal",
      "apply_approved_proposal",
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
    expect(modelContext.tool("apply_approved_proposal").annotations?.readOnlyHint).toBe(false);

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
        { accountId: account.id, mailbox: "INBOX", query: "subject" },
        executeOptions(),
      ),
    ).toEqual([message]);
    expect(
      await modelContext.tool("create_triage_proposal").execute(
        { accountId: account.id, title: proposal.title, items: proposal.items },
        executeOptions(),
      ),
    ).toEqual(proposal);
    expect(
      await modelContext.tool("update_triage_proposal").execute(
        { proposalId: proposal.id, title: "Updated", status: "review" },
        executeOptions(),
      ),
    ).toEqual(proposal);
    expect(services.updateCalls).toEqual([
      { proposalId: proposal.id, input: { title: "Updated", status: "review" } },
    ]);
    expect(
      await modelContext.tool("apply_approved_proposal").execute(
        { proposalId: proposal.id },
        executeOptions(),
      ),
    ).toEqual(batch);
    expect(services.applyCalls).toEqual([proposal.id]);
    expect(
      await modelContext.tool("undo_batch").execute({ batchId: batch.id }, executeOptions()),
    ).toEqual({ ...batch, status: "undone" });
  });

  test("cannot turn a WebMCP proposal update into human approval", async () => {
    const services = new FakeServices();
    const updateTool = createPostreeveWebMcpTools(services).find(
      ({ name }) => name === "update_triage_proposal",
    );
    if (updateTool === undefined) {
      throw new Error("Missing update_triage_proposal tool");
    }

    await expect(
      updateTool.execute({ proposalId: proposal.id, status: "approved" }, executeOptions()),
    ).rejects.toThrow();
    await expect(
      updateTool.execute(
        { proposalId: proposal.id, approvedAt: "2026-08-29T12:02:00.000Z" },
        executeOptions(),
      ),
    ).rejects.toThrow();
    expect(services.updateCalls).toEqual([]);
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
