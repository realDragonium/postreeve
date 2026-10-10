import { describe, expect, test } from "bun:test";
import { hc } from "hono/client";
import { simpleParser } from "mailparser";
import { createApi, type AppType } from "../src/server/api";
import { composeMime } from "../src/server/mail/outgoing-content";
import { htmlToPlainText, sanitizeOutgoingHtml } from "../src/server/mail/outgoing-html";
import { buildProviderDraftMessage } from "../src/server/mail/provider-draft";
import { draftSchema, signatureSchema, type Account, type CreateDraftInput } from "../src/shared/contracts";
import { createEmptyTestHarness, testAccountInput } from "./support/test-mail";

async function harnessWithAccount() {
  const harness = await createEmptyTestHarness();
  const account = await harness.service.createAccount(testAccountInput());
  return { ...harness, account };
}

function richDraft(account: Account, body: string): CreateDraftInput {
  return {
    accountId: account.id,
    mode: "new",
    format: "html",
    to: "alice@example.test",
    cc: "",
    bcc: "",
    subject: "Hello",
    body,
    identity: { name: account.name, address: account.email },
    attachments: [],
  };
}

describe("outgoing HTML", () => {
  test("keeps formatting and removes active content and remote resources", () => {
    const html = sanitizeOutgoingHtml([
      `<style>p { color: red }</style><script>alert(1)</script>`,
      `<p style="position: fixed; color: #333; background-image: url(https://tracker.example/x)">Hi <b>Sam</b>,</p>`,
      `<a href="javascript:alert(1)" onclick="steal()">bad</a> <a href="https://example.test/page">good</a>`,
      `<img src="https://tracker.example/p.gif" alt="pixel"><img src="data:image/png;base64,AAAA" alt="inline">`,
      `<blockquote><ul><li>one</li></ul></blockquote><iframe src="https://example.test"></iframe>`,
    ].join(""));

    expect(html).toBe([
      `<p style="color:#333">Hi <b>Sam</b>,</p>`,
      `<a>bad</a> <a href="https://example.test/page">good</a>`,
      `<img src="data:image/png;base64,AAAA" alt="inline" />`,
      `<blockquote><ul><li>one</li></ul></blockquote>`,
    ].join(""));
  });

  test("derives plain text and treats markup without text as empty", () => {
    expect(htmlToPlainText(`<p>Hi <b>Sam</b></p><ul><li>one</li></ul><a href="https://example.test">site</a>`))
      .toBe("Hi Sam\n\n * one\n\nsite [https://example.test]");
    expect(htmlToPlainText("<p><br></p><div> </div>")).toBe("");
  });

  test("builds multipart/alternative from sanitized HTML", async () => {
    const raw = await composeMime({ from: "me@example.test", to: "you@example.test" }, {
      html: `<p onclick="x()">Hi <i>you</i></p><script>bad()</script>`,
    });
    const parsed = await simpleParser(raw);

    expect(raw.toString("latin1")).toContain("multipart/alternative");
    expect(parsed.text?.trim()).toBe("Hi you");
    expect(parsed.html).toBe("<p>Hi <i>you</i></p>");
  });
});

describe("rich-text drafts", () => {
  test("stores the format, defaults to plain and sends sanitized HTML with generated text", async () => {
    const { service, store, account, sent } = await harnessWithAccount();
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });
    const { format: _format, ...withoutFormat } = richDraft(account, "Plain body");
    const legacy = await client.api.accounts[":accountId"].drafts.$post({ param: { accountId: account.id }, json: withoutFormat });
    expect(draftSchema.parse(await legacy.json()).format).toBe("plain");

    const draft = await service.createDraft(richDraft(account, `<p>Hi <b>Alice</b></p><img src="https://tracker.example/p.gif">`));
    expect(draft.format).toBe("html");
    await service.sendDraft(account.id, draft.id, { version: draft.version });

    expect(sent[0]?.text).toBe("Hi Alice");
    expect(sent[0]?.html).toBe("<p>Hi <b>Alice</b></p>");
    store.close();
  });

  test("refuses a rich-text draft whose HTML has no text", async () => {
    const { service, store, account, sent } = await harnessWithAccount();
    const draft = await service.createDraft(richDraft(account, "<p><br></p>"));

    await expect(service.sendDraft(account.id, draft.id, { version: draft.version })).rejects.toThrow();
    expect(sent).toEqual([]);
    expect((await service.getDraft(account.id, draft.id)).delivery.status).toBe("editable");
    store.close();
  });

  test("mirrors rich-text drafts to the provider as multipart/alternative", async () => {
    const { service, store, account } = await harnessWithAccount();
    const draft = await service.createDraft(richDraft(account, `<p>Draft <b>copy</b></p><script>x()</script>`));
    const parsed = await simpleParser(await buildProviderDraftMessage({ tenantId: "test-tenant", accountId: account.id }, draft));

    expect(parsed.html).toBe("<p>Draft <b>copy</b></p>");
    expect(parsed.text?.trim()).toBe("Draft copy");
    store.close();
  });
});

describe("signatures", () => {
  test("stores signatures for own addresses and removes them with the identity", async () => {
    const { service, store, account } = await harnessWithAccount();
    const client = hc<AppType>("http://postreeve.local", { fetch: createApi(service).request });
    const param = { accountId: account.id };
    const identity = (await service.addIdentity(account.id, { name: "Sales", address: "sales@example.test" })).identity;

    const put = await client.api.accounts[":accountId"].signatures.$put({
      param, json: { address: "Sales@Example.test", html: "<b>Sales team</b>" },
    });
    expect(signatureSchema.parse(await put.json())).toEqual({ address: "sales@example.test", html: "<b>Sales team</b>" });
    await service.putSignature(account.id, { address: account.email, html: "Me" });

    const foreign = await client.api.accounts[":accountId"].signatures.$put({
      param, json: { address: "other@example.test", html: "Nope" },
    });
    expect(foreign.status).toBe(400);
    const listed = await client.api.accounts[":accountId"].signatures.$get({ param });
    expect(signatureSchema.array().parse(await listed.json()).map(({ address }) => address))
      .toEqual([account.email.toLowerCase(), "sales@example.test"].sort());

    await service.removeIdentity(account.id, identity.id);
    expect(await service.listSignatures(account.id)).toEqual([{ address: account.email.toLowerCase(), html: "Me" }]);
    await service.putSignature(account.id, { address: account.email, html: "  " });
    expect(await service.listSignatures(account.id)).toEqual([]);
    store.close();
  });
});
