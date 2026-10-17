import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createAgentAccess, createPublicAgentAccess } from "../src/server/agent-access";
import { clientAddress } from "../src/server/agent-access/limits";
import { AgentAccessStore, migrateAgentAccess } from "../src/server/agent-access/store";
import { getOwnerSession } from "../src/server/security/owner-auth";
import { Store } from "../src/server/db/store";
import { connectedAgentSchema, createdPersonalTokenSchema, agentEventSchema } from "../src/shared/agent-access";
import { createTestHarness, testAccountInput } from "./support/test-mail";

const origin = "https://mail.example.test";
const redirectUri = "https://claude.ai/api/mcp/auth_callback";
const verifier = "v".repeat(20) + "erifier-with-enough-entropy-1234567890";
const challenge = createHash("sha256").update(verifier).digest("base64url");

async function setup(options: { signedIn?: boolean } = {}) {
  const harness = await createTestHarness();
  const sqlite = new Database(":memory:");
  sqlite.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)");
  migrateAgentAccess(sqlite);
  const clock = { now: new Date("2026-10-17T10:00:00.000Z") };
  const agents = new AgentAccessStore(sqlite, () => clock.now);
  const session = { signedIn: options.signedIn ?? true };
  const app = createAgentAccess({
    service: harness.service, store: agents, publicUrl: `${origin}/`,
    getOwnerSession: () => session.signedIn ? { id: "owner" } : null,
    requireOwner: async (c, next) => session.signedIn ? next() : c.json({ error: "Sign in" }, 401),
  });
  const request = (path: string, init?: RequestInit) => app.request(`${origin}${path}`, init);
  return { ...harness, sqlite, clock, agents, session, app, request };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function register(context: Setup, body: Record<string, unknown> = {}) {
  const response = await context.request("/oauth/register", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", ...body }),
  });
  return { response, body: await response.json() as Record<string, unknown> };
}

function authorizeQuery(clientId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
    code_challenge_method: "S256", state: "state-1", resource: `${origin}/mcp`, ...extra,
  }).toString();
}

async function consent(context: Setup, clientId: string, form: Record<string, string | string[]>) {
  const page = await context.request(`/oauth/authorize?${authorizeQuery(clientId)}`);
  expect(page.status).toBe(200);
  const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())![1]!;
  const body = new URLSearchParams({ request_id: requestId });
  for (const [key, value] of Object.entries(form)) for (const item of [value].flat()) body.append(key, item);
  return context.request("/oauth/authorize", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin }, body,
  });
}

async function token(context: Setup, fields: Record<string, string>) {
  const response = await context.request("/oauth/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields),
  });
  return { response, body: await response.json() as Record<string, string> };
}

/** Register, consent and exchange: the path claude.ai and ChatGPT take. */
async function connect(context: Setup, tier: "read" | "propose" | "act", accounts: string[] | "all" = "all") {
  const clientId = (await register(context)).body.client_id as string;
  const redirect = await consent(context, clientId, {
    decision: "allow", tier, scope_accounts: accounts === "all" ? "all" : "chosen", ...(accounts === "all" ? {} : { account: accounts }),
  });
  expect(redirect.status).toBe(303);
  const location = new URL(redirect.headers.get("Location")!);
  expect(location.searchParams.get("state")).toBe("state-1");
  expect(location.searchParams.get("iss")).toBe(origin);
  const code = location.searchParams.get("code")!;
  const exchanged = await token(context, {
    grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier,
  });
  expect(exchanged.response.status).toBe(200);
  return { clientId, code, ...exchanged.body } as {
    clientId: string; code: string; access_token: string; refresh_token: string; scope: string; token_type: string;
  };
}

let rpcId = 0;
async function rpc(context: Setup, accessToken: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await context.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return { response, body: response.status === 200 ? await response.json() as { result?: any; error?: any } : null };
}

async function callTool(context: Setup, accessToken: string, name: string, args: Record<string, unknown>) {
  const { body } = await rpc(context, accessToken, "tools/call", { name, arguments: args });
  const result = body!.result as { isError?: boolean; content: Array<{ text: string }> };
  return { isError: result.isError === true, text: result.content[0]!.text, json: () => JSON.parse(result.content[0]!.text) };
}

async function toolNames(context: Setup, accessToken: string): Promise<string[]> {
  const { body } = await rpc(context, accessToken, "tools/list");
  return (body!.result.tools as Array<{ name: string }>).map(({ name }) => name);
}

describe("remote MCP authorization", () => {
  test("publishes protected resource and authorization server metadata at the public origin", async () => {
    const context = await setup();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await context.request(path);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(await response.json()).toMatchObject({
        resource: `${origin}/mcp`, authorization_servers: [origin],
        scopes_supported: ["mail:read", "mail:propose", "mail:draft", "mail:act"], bearer_methods_supported: ["header"],
      });
    }
    const metadata = await (await context.request("/.well-known/oauth-authorization-server")).json();
    expect(metadata).toMatchObject({
      issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    });
    context.store.close();
  });

  test("registers public and confidential clients and refuses unsafe redirects", async () => {
    const context = await setup();
    const open = await register(context);
    expect(open.response.status).toBe(201);
    expect(open.body).toMatchObject({ client_name: "Claude", token_endpoint_auth_method: "none", redirect_uris: [redirectUri] });
    expect(open.body.client_secret).toBeUndefined();
    const omitted = await register(context, { token_endpoint_auth_method: undefined });
    expect(omitted.body.token_endpoint_auth_method).toBe("none");
    const confidential = await register(context, { token_endpoint_auth_method: "client_secret_post" });
    expect(String(confidential.body.client_secret)).toStartWith("pvs_");
    const stored = context.sqlite.query("SELECT secret_hash FROM agent_clients WHERE id = ?").get(confidential.body.client_id as string) as { secret_hash: string };
    expect(stored.secret_hash).not.toContain("pvs_");
    expect((await register(context, { redirect_uris: ["http://evil.example/cb"] })).body.error).toBe("invalid_redirect_uri");
    expect((await register(context, { redirect_uris: ["http://127.0.0.1:43123/callback"] })).response.status).toBe(201);
    context.store.close();
  });

  test("validates authorize requests and requires a signed-in owner before consent", async () => {
    const context = await setup({ signedIn: false });
    const clientId = (await register(context)).body.client_id as string;
    expect((await context.request(`/oauth/authorize?${authorizeQuery("unknown")}`)).status).toBe(400);
    const wrongRedirect = await context.request(`/oauth/authorize?${authorizeQuery(clientId, { redirect_uri: "https://other.example/cb" })}`);
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.headers.get("Location")).toBeNull();
    const noPkce = await context.request(`/oauth/authorize?${authorizeQuery(clientId, { code_challenge_method: "plain" })}`);
    const noPkceLocation = new URL(noPkce.headers.get("Location")!);
    expect(noPkceLocation.searchParams.get("error")).toBe("invalid_request");
    expect(noPkceLocation.searchParams.get("state")).toBe("state-1");
    const signIn = await context.request(`/oauth/authorize?${authorizeQuery(clientId)}`);
    expect(signIn.status).toBe(401);
    expect(await signIn.text()).toContain("Sign in to Postreeve");
    context.session.signedIn = true;
    const page = await context.request(`/oauth/authorize?${authorizeQuery(clientId)}`);
    const html = await page.text();
    expect(html).toContain("Connect Claude?");
    expect(html).toContain("claude.ai");
    expect(html).toContain("No agent can send mail or accept a proposal");
    context.store.close();
  });

  test("denying consent redirects with access_denied and creates no grant", async () => {
    const context = await setup();
    const clientId = (await register(context)).body.client_id as string;
    const response = await consent(context, clientId, { decision: "deny" });
    expect(new URL(response.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
    expect(context.agents.listActiveGrants()).toEqual([]);
    const crossSite = await context.request("/oauth/authorize", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" },
      body: new URLSearchParams({ request_id: "x", decision: "allow" }),
    });
    expect(crossSite.status).toBe(403);
    context.store.close();
  });

  test("exchanges a code only with the matching PKCE verifier, once", async () => {
    const context = await setup();
    const clientId = (await register(context)).body.client_id as string;
    const redirect = await consent(context, clientId, { decision: "allow", tier: "read", scope_accounts: "all" });
    const code = new URL(redirect.headers.get("Location")!).searchParams.get("code")!;
    const wrong = await token(context, {
      grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: "x".repeat(43),
    });
    expect(wrong.response.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_grant");

    const second = await connect(context, "read");
    expect(second).toMatchObject({ token_type: "Bearer", scope: "mail:read" });
    expect(second.access_token).toStartWith("pva_");
    expect(second.refresh_token).toStartWith("pvr_");
    expect((await rpc(context, second.access_token!, "tools/list")).response.status).toBe(200);
    const replay = await token(context, {
      grant_type: "authorization_code", code: second.code, redirect_uri: redirectUri, client_id: second.clientId, code_verifier: verifier,
    });
    expect(replay.body.error).toBe("invalid_grant");
    expect((await rpc(context, second.access_token!, "tools/list")).response.status).toBe(401);
    const rows = context.sqlite.query("SELECT hash FROM agent_tokens").all() as Array<{ hash: string }>;
    expect(rows.some(({ hash }) => hash === second.access_token || hash.startsWith("pva_"))).toBe(false);
    context.store.close();
  });

  test("rotates refresh tokens and revokes the grant when an old one is replayed", async () => {
    const context = await setup();
    const first = await connect(context, "propose");
    const refreshed = await token(context, { grant_type: "refresh_token", refresh_token: first.refresh_token!, client_id: first.clientId });
    expect(refreshed.response.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.refresh_token);
    expect(refreshed.body.scope).toBe("mail:read mail:propose mail:draft");
    const narrowed = await token(context, {
      grant_type: "refresh_token", refresh_token: refreshed.body.refresh_token!, client_id: first.clientId, scope: "mail:read",
    });
    expect(narrowed.body.scope).toBe("mail:read");
    expect(await toolNames(context, narrowed.body.access_token!)).not.toContain("create_proposal");
    const widened = await token(context, {
      grant_type: "refresh_token", refresh_token: narrowed.body.refresh_token!, client_id: first.clientId, scope: "mail:read mail:act",
    });
    expect(widened.body.error).toBe("invalid_scope");

    context.clock.now = new Date(context.clock.now.getTime() + 60_000);
    const reuse = await token(context, { grant_type: "refresh_token", refresh_token: first.refresh_token!, client_id: first.clientId });
    expect(reuse.body.error).toBe("invalid_grant");
    expect((await rpc(context, narrowed.body.access_token!, "tools/list")).response.status).toBe(401);
    expect(context.agents.listActiveGrants()).toEqual([]);
    context.store.close();
  });

  test("revoking a refresh token ends the connection; expired access tokens stop working", async () => {
    const context = await setup();
    const first = await connect(context, "read");
    const revoked = await context.request("/oauth/revoke", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: first.refresh_token! }),
    });
    expect(revoked.status).toBe(200);
    const rejected = await rpc(context, first.access_token!, "tools/list");
    expect(rejected.response.status).toBe(401);
    expect(rejected.response.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');

    const second = await connect(context, "read");
    context.clock.now = new Date(context.clock.now.getTime() + 61 * 60_000);
    expect((await rpc(context, second.access_token!, "tools/list")).response.status).toBe(401);
    context.store.close();
  });
});

describe("remote MCP endpoint", () => {
  test("asks for authorization with resource metadata and refuses streams", async () => {
    const context = await setup();
    const missing = await rpc(context, null, "tools/list");
    expect(missing.response.status).toBe(401);
    expect(missing.response.headers.get("WWW-Authenticate"))
      .toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    expect((await context.request("/mcp", { method: "GET" })).status).toBe(405);
    context.store.close();
  });

  test("initializes statelessly and shares tool schemas with WebMCP", async () => {
    const context = await setup();
    const { access_token } = await connect(context, "act");
    const initialized = await rpc(context, access_token!, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
    });
    expect(initialized.body!.result.serverInfo.name).toBe("postreeve");
    expect(initialized.body!.result.capabilities.tools).toBeDefined();
    expect(initialized.response.headers.get("Mcp-Session-Id")).toBeNull();
    const { body } = await rpc(context, access_token!, "tools/list");
    const tools = body!.result.tools as Array<{ name: string; inputSchema: object; annotations: Record<string, boolean> }>;
    const { createPostreeveWebMcpTools } = await import("../src/server/webmcp/tools");
    const page = createPostreeveWebMcpTools({} as never);
    const listFolders = tools.find(({ name }) => name === "list_folders")!;
    expect(listFolders.inputSchema).toEqual(page.find(({ name }) => name === "list_folders")!.inputSchema!);
    expect(listFolders.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tools.find(({ name }) => name === "delete_folder")!.annotations.destructiveHint).toBe(true);
    context.store.close();
  });

  test("never offers sending or approval, and update_proposal cannot approve", async () => {
    const context = await setup();
    const { access_token } = await connect(context, "act");
    const names = await toolNames(context, access_token!);
    expect(names).not.toContain("send_message");
    expect(names.filter((name) => /approve|decline|apply_proposal|unsubscribe|send/.test(name))).toEqual([]);
    expect(names).toContain("create_proposal");

    const created = await callTool(context, access_token!, "create_proposal", {
      accountId: context.account.id, title: "Tidy",
      items: [{ message: context.messages[0]!.ref, subject: context.messages[0]!.subject, action: { type: "mark_read" }, reason: "Seen" }],
    });
    expect(created.isError).toBe(false);
    const proposal = created.json();
    expect(proposal).toMatchObject({ status: "draft", approvedAt: null });
    const approve = await callTool(context, access_token!, "update_proposal", { proposalId: proposal.id, status: "approved" });
    expect(approve.isError).toBe(true);
    const sent = await callTool(context, access_token!, "send_message", {
      accountId: context.account.id, to: ["someone@example.test"], subject: "Hi", text: "Hello",
    });
    expect(sent.isError).toBe(true);
    expect(context.sent).toEqual([]);
    const [stored] = await context.service.listProposals(context.account.id);
    expect(stored).toMatchObject({ status: "draft", approvedAt: null, batchId: null });
    context.store.close();
  });

  test("a prepare-tier agent drafts a reply for review; a read-only agent cannot draft", async () => {
    const context = await setup();
    const { access_token } = await connect(context, "propose");
    const names = await toolNames(context, access_token);
    expect(names).toEqual(expect.arrayContaining(["create_draft", "update_draft", "list_identities", "read_attachment"]));
    expect(names).not.toContain("apply_message_actions");
    const source = context.messages[0]!;
    const created = await callTool(context, access_token, "create_draft", {
      accountId: context.account.id, mode: "reply", to: [source.from[0]?.address ?? "sender@example.test"],
      source: { canonicalMessageId: source.canonicalId, conversationId: source.conversationId },
      subject: `Re: ${source.subject}`, body: "Thanks, I will look at it.",
    });
    expect(created.isError).toBe(false);
    const draft = created.json();
    expect(draft).toMatchObject({ mode: "reply", delivery: { status: "editable" }, identity: { address: context.account.email } });
    const updated = await callTool(context, access_token, "update_draft", {
      accountId: context.account.id, draftId: draft.id, version: draft.version, body: "Thanks!",
    });
    expect(updated.json()).toMatchObject({ body: "Thanks!", subject: `Re: ${source.subject}`, mode: "reply" });
    const stale = await callTool(context, access_token, "update_draft", {
      accountId: context.account.id, draftId: draft.id, version: draft.version, body: "Overwrite",
    });
    expect(stale.isError).toBe(true);
    expect(context.sent).toEqual([]);
    const events = agentEventSchema.array().parse(await (await context.request("/api/agent-access/events")).json());
    expect(events.find(({ tool }) => tool === "create_draft")?.summary).toBe(`“Re: ${source.subject}” · reply`);

    const reader = await connect(context, "read");
    const refused = await callTool(context, reader.access_token, "create_draft", {
      accountId: context.account.id, to: ["x@example.test"], subject: "x", body: "y",
    });
    expect(refused.isError).toBe(true);
    expect(await context.service.listDrafts(context.account.id)).toHaveLength(1);
    context.store.close();
  });

  test("a read-only agent cannot act", async () => {
    const context = await setup();
    const { access_token } = await connect(context, "read");
    const names = await toolNames(context, access_token!);
    expect(names).toContain("read_conversation");
    for (const name of ["apply_message_actions", "undo_batch", "create_folder", "create_proposal", "retry_synchronization"]) {
      expect(names).not.toContain(name);
    }
    const message = context.messages[0]!;
    const attempt = await callTool(context, access_token!, "apply_message_actions", {
      accountId: context.account.id, items: [{ message: message.ref, subject: message.subject, action: { type: "trash" } }],
    });
    expect(attempt.isError).toBe(true);
    expect(attempt.text).toContain("not available");
    expect(await context.service.listBatches(context.account.id)).toEqual([]);
    context.store.close();
  });

  test("round-trips list, read, conversation and an audited, undoable action against test doubles", async () => {
    const context = await setup();
    const { access_token } = await connect(context, "act");
    const page = await callTool(context, access_token!, "list_messages", { filter: "all" });
    expect(page.isError).toBe(false);
    const messages = page.json().messages as typeof context.messages;
    expect(messages.length).toBeGreaterThan(0);
    const read = await callTool(context, access_token!, "read_messages", { messages: [messages[0]!.ref] });
    expect(read.json()[0].canonicalId).toBe(messages[0]!.canonicalId);
    const conversation = await callTool(context, access_token!, "read_conversation", { conversationId: messages[0]!.conversationId });
    expect(conversation.json().map(({ canonicalId }: { canonicalId: string }) => canonicalId)).toContain(messages[0]!.canonicalId);

    const applied = await callTool(context, access_token!, "apply_message_actions", {
      accountId: context.account.id, items: [{ message: messages[0]!.ref, subject: messages[0]!.subject, action: { type: "flag" } }],
    });
    const batch = applied.json();
    expect(batch.status).toBe("applied");
    expect((await callTool(context, access_token!, "undo_batch", { batchId: batch.id })).json().status).toBe("undone");

    const events = agentEventSchema.array().parse(await (await context.request("/api/agent-access/events")).json());
    const applyEvent = events.find(({ tool }) => tool === "apply_message_actions")!;
    expect(applyEvent).toMatchObject({ agentName: "Claude", outcome: "ok", targetKind: "batch", targetId: batch.id, summary: "1 item" });
    const readEvent = events.find(({ tool }) => tool === "read_messages")!;
    expect(readEvent.summary).toBe("1 message");
    expect(JSON.stringify(events)).not.toContain(messages[0]!.subject);
    const [agent] = connectedAgentSchema.array().parse(await (await context.request("/api/agent-access/agents")).json());
    expect(agent).toMatchObject({ name: "Claude", kind: "oauth", tier: "act", redirectHost: "claude.ai", accountIds: null });
    expect(agent!.lastUsedAt).not.toBeNull();
    context.store.close();
  });

  test("restricts a grant to the chosen accounts", async () => {
    const context = await setup();
    const other = await context.service.createAccount(testAccountInput("Home", "home@example.test"));
    const { access_token } = await connect(context, "act", [context.account.id]);
    const accounts = (await callTool(context, access_token!, "list_accounts", {})).json() as Array<{ id: string }>;
    expect(accounts.map(({ id }) => id)).toEqual([context.account.id]);
    const blocked = await callTool(context, access_token!, "list_folders", { accountId: other.id });
    expect(blocked).toMatchObject({ isError: true, text: "Account not available to this agent" });
    const inboxes = (await callTool(context, access_token!, "list_messages", {})).json();
    expect(inboxes.messages.every(({ ref }: { ref: { accountId: string } }) => ref.accountId === context.account.id)).toBe(true);
    const status = (await callTool(context, access_token!, "inspect_synchronization", {})).json();
    expect(status.accounts.map(({ account }: { account: { id: string } }) => account.id)).toEqual([context.account.id]);
    context.store.close();
  });

  test("the official MCP SDK client connects with a bearer token", async () => {
    const context = await setup();
    const { access_token } = await connect(context, "read");
    const client = new Client({ name: "sdk", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      fetch: async (url, init) => context.app.request(String(url), init as RequestInit),
      requestInit: { headers: { Authorization: `Bearer ${access_token}` } },
    });
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    expect((await client.listTools()).tools.map(({ name }) => name)).toContain("list_messages");
    const result = await client.callTool({ name: "list_accounts", arguments: {} });
    expect(result.isError).toBeFalsy();
    await client.close();
    context.store.close();
  });

  test("personal access tokens work at /mcp and revoke from settings", async () => {
    const context = await setup();
    const created = await context.request("/api/agent-access/tokens", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "laptop", tier: "read", accountIds: null }),
    });
    expect(created.status).toBe(201);
    const { agent, token: personal } = createdPersonalTokenSchema.parse(await created.json());
    expect(personal).toStartWith("pvt_");
    expect(agent).toMatchObject({ kind: "token", name: "laptop", tier: "read" });
    expect((await callTool(context, personal, "list_accounts", {})).isError).toBe(false);
    expect(await toolNames(context, personal)).not.toContain("apply_message_actions");

    const revoked = await context.request(`/api/agent-access/agents/${agent.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(200);
    expect((await rpc(context, personal, "tools/list")).response.status).toBe(401);
    expect(await (await context.request("/api/agent-access/agents")).json()).toEqual([]);
    context.session.signedIn = false;
    expect((await context.request("/api/agent-access/agents")).status).toBe(401);
    context.store.close();
  });
});

describe("separate agent origin (Funnel port)", () => {
  test("issuer, resource and token endpoints follow POSTREEVE_MCP_PUBLIC_URL; consent stays on the UI origin", async () => {
    const harness = await createTestHarness();
    const ui = "https://box.tail.ts.net";
    const agentOrigin = "https://box.tail.ts.net:8443";
    const app = createAgentAccess({
      service: harness.service, store: harness.store.agentAccess, publicUrl: ui, mcpPublicUrl: `${agentOrigin}/`,
      getOwnerSession: () => ({ id: "owner" }), requireOwner: async (_c, next) => next(),
    });
    const metadata = await (await app.request(`${agentOrigin}/.well-known/oauth-authorization-server`)).json();
    expect(metadata).toMatchObject({
      issuer: agentOrigin, authorization_endpoint: `${ui}/oauth/authorize`, token_endpoint: `${agentOrigin}/oauth/token`,
      registration_endpoint: `${agentOrigin}/oauth/register`, revocation_endpoint: `${agentOrigin}/oauth/revoke`,
    });
    expect(await (await app.request(`${agentOrigin}/.well-known/oauth-protected-resource/mcp`)).json())
      .toMatchObject({ resource: `${agentOrigin}/mcp`, authorization_servers: [agentOrigin] });

    const registered = await (await app.request(`${agentOrigin}/oauth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirectUri] }),
    })).json() as { client_id: string };
    const query = new URLSearchParams({
      response_type: "code", client_id: registered.client_id, redirect_uri: redirectUri, code_challenge: challenge,
      code_challenge_method: "S256", state: "s", resource: `${agentOrigin}/mcp`,
    });
    const page = await app.request(`${ui}/oauth/authorize?${query}`);
    expect(page.status).toBe(200);
    const requestId = /name="request_id" value="([^"]+)"/.exec(await page.text())![1]!;
    const decided = await app.request(`${ui}/oauth/authorize`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ui },
      body: new URLSearchParams({ request_id: requestId, decision: "allow", tier: "read", scope_accounts: "all" }),
    });
    const location = new URL(decided.headers.get("Location")!);
    expect(location.searchParams.get("iss")).toBe(agentOrigin);
    const tokens = await (await app.request(`${agentOrigin}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: location.searchParams.get("code")!, redirect_uri: redirectUri,
        client_id: registered.client_id, code_verifier: verifier,
      }),
    })).json() as { access_token: string };
    const call = (target: string, token: string | null) => app.request(`${target}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect((await call(agentOrigin, tokens.access_token)).status).toBe(200);
    expect((await call(agentOrigin, null)).headers.get("WWW-Authenticate"))
      .toBe(`Bearer resource_metadata="${agentOrigin}/.well-known/oauth-protected-resource/mcp"`);
    expect(await (await app.request(`${ui}/api/agent-access/endpoint`)).json()).toEqual({ mcpUrl: `${agentOrigin}/mcp` });
    harness.store.close();
  });
});

describe("public listener", () => {
  test("serves only the agent endpoints and shares rate limits with the private listener", async () => {
    const harness = await createTestHarness();
    const options = { service: harness.service, store: harness.store.agentAccess, publicUrl: "https://box.tail.ts.net", mcpPublicUrl: origin };
    const publicApp = createPublicAgentAccess(options);
    const privateApp = createAgentAccess({ ...options, getOwnerSession: () => ({ id: "owner" }), requireOwner: async (_c, next) => next() });
    expect((await publicApp.request(`${origin}/.well-known/oauth-authorization-server`)).status).toBe(200);
    expect((await publicApp.request(`${origin}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
    expect((await publicApp.request(`${origin}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await publicApp.request(`${origin}/oauth/authorize?client_id=x`)).status).toBe(404);
    expect((await publicApp.request(`${origin}/api/agent-access/agents`)).status).toBe(404);
    expect((await privateApp.request("https://box.tail.ts.net/api/agent-access/agents")).status).toBe(200);

    const register = (app: typeof publicApp) => app.request(`${origin}/oauth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri] }),
    });
    for (let index = 0; index < 5; index += 1) expect((await register(publicApp)).status).toBe(201);
    for (let index = 0; index < 5; index += 1) expect((await register(privateApp)).status).toBe(201);
    expect((await register(publicApp)).status).toBe(429);
    harness.store.close();
  });

  test("trusts X-Forwarded-For only from a loopback peer", async () => {
    const { Hono } = await import("hono");
    const app = new Hono().get("/", (c) => c.text(clientAddress(c)));
    const ask = (peer: string, forwarded: string) => app.fetch(new Request("http://x/", { headers: { "X-Forwarded-For": forwarded } }),
      { requestIP: () => ({ address: peer, family: peer.includes(":") ? "IPv6" : "IPv4", port: 1 }) });
    expect(await (await ask("127.0.0.1", "198.51.100.1, 203.0.113.7")).text()).toBe("203.0.113.7");
    expect(await (await ask("203.0.113.9", "10.0.0.1")).text()).toBe("203.0.113.9");
  });
});

describe("internet-facing bounds", () => {
  test("rate limits registration per forwarded address and MCP calls per token", async () => {
    const context = await setup();
    const registerFrom = (address: string) => context.request("/oauth/register", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.9, ${address}` },
      body: JSON.stringify({ client_name: "x", redirect_uris: [redirectUri] }),
    });
    for (let index = 0; index < 10; index += 1) expect((await registerFrom("203.0.113.1")).status).toBe(201);
    const limited = await registerFrom("203.0.113.1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await registerFrom("203.0.113.2")).status).toBe(201);

    const { access_token } = await connect(context, "read");
    for (let index = 0; index < 120; index += 1) expect((await rpc(context, access_token, "tools/list")).response.status).toBe(200);
    expect((await rpc(context, access_token, "tools/list")).response.status).toBe(429);
    context.store.close();
  });

  test("refuses oversized bodies before parsing and hides internal failures", async () => {
    const context = await setup();
    const big = await context.request("/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(2 * 1024 * 1024) },
      body: "x".repeat(2 * 1024 * 1024),
    });
    expect(big.status).toBe(413);
    const bigToken = await context.request("/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "a=" + "x".repeat(20_000),
    });
    expect(bigToken.status).toBe(413);

    context.agents.findToken = () => { throw new Error("SQLITE_CORRUPT: secret detail"); };
    const failed = await rpc(context, "pva_anything", "tools/list");
    expect(failed.response.status).toBe(500);
    expect(await failed.response.json()).toEqual({ error: "server_error" });
    context.store.close();
  });
});

describe("agent access storage and owner placeholder", () => {
  test("the main store migrates agent tables", () => {
    const store = new Store(":memory:");
    const { client } = store.agentAccess.registerClient({ name: "x", redirectUris: [redirectUri], authMethod: "none" });
    expect(store.agentAccess.getClient(client.id)?.name).toBe("x");
    store.close();
  });

  test("the placeholder only trusts loopback hosts", async () => {
    const { Hono } = await import("hono");
    const app = new Hono().get("/", (c) => c.json({ session: getOwnerSession(c) }));
    const ask = async (host: string) => (await (await app.request("/", { headers: { Host: host } })).json()).session;
    expect(await ask("127.0.0.1:3000")).toEqual({ id: "loopback-owner" });
    expect(await ask("mail.example.com")).toBeNull();
  });
});
