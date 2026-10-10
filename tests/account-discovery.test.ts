import { describe, expect, test } from "bun:test";
import { accountDiscoverySchema } from "../src/shared/contracts";
import { createApi } from "../src/server/api";
import {
  MAX_DOCUMENT_BYTES,
  createAccountDiscovery,
  lookupDomain,
  parseClientConfig,
  type DiscoveryFetch,
  type ResolveMx,
} from "../src/server/accounts/discovery";
import { createEmptyTestHarness } from "./support/test-mail";

function clientConfig(imap: string, smtp: string): string {
  return `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="example.test">
    <incomingServer type="imap">${imap}</incomingServer>
    <outgoingServer type="smtp">${smtp}</outgoingServer>
  </emailProvider></clientConfig>`;
}

function server(host: string, port: number, socketType: string, username = "%EMAILADDRESS%", auth = "password-cleartext"): string {
  return `<hostname>${host}</hostname><port>${port}</port><socketType>${socketType}</socketType>`
    + `<username>${username}</username><authentication>${auth}</authentication>`;
}

const ownConfig = clientConfig(server("mail.example.test", 993, "SSL"), server("mail.example.test", 587, "STARTTLS"));
const ispdbConfig = clientConfig(server("imap.isp.test", 993, "SSL"), server("smtp.isp.test", 465, "SSL"));

function stubFetch(documents: Record<string, Response | (() => Response)>) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch: DiscoveryFetch = async (url, init) => {
    requests.push({ url, init });
    const document = documents[url];
    if (!document) return new Response("not found", { status: 404 });
    return typeof document === "function" ? document() : document;
  };
  return { fetch, requests };
}

const noMx: ResolveMx = async () => [];
const mxAt = (exchange: string): ResolveMx => async () => [{ exchange: "backup.mx.test", priority: 20 }, { exchange, priority: 10 }];

describe("account settings discovery", () => {
  test("answers known provider domains from the table without network access", async () => {
    const { fetch, requests } = stubFetch({});
    const lookups: string[] = [];
    const discover = createAccountDiscovery({ fetch, resolveMx: async (domain) => { lookups.push(domain); return []; } });

    expect(await discover("person@Me.com")).toEqual({
      provider: "icloud",
      source: "provider",
      settings: {
        host: "imap.mail.me.com", port: 993, secure: true, username: "person@Me.com",
        smtpHost: "smtp.mail.me.com", smtpPort: 587, smtpSecure: false, smtpUsername: "person@Me.com",
      },
    });
    expect(await discover("person@hotmail.com")).toEqual({ provider: "outlook", source: "provider", settings: null });
    expect(requests).toEqual([]);
    expect(lookups).toEqual([]);
  });

  test("prefers the domain's own autoconfig over the ISPDB and only uses fixed HTTPS URLs", async () => {
    const { fetch, requests } = stubFetch({
      "https://example.test/.well-known/autoconfig/mail/config-v1.1.xml": new Response(ownConfig),
      "https://autoconfig.thunderbird.net/v1.1/example.test": new Response(ispdbConfig),
    });
    const result = await createAccountDiscovery({ fetch, resolveMx: mxAt("in1-smtp.messagingengine.com") })("person@example.test");

    expect(result).toEqual({
      provider: null,
      source: "autoconfig",
      settings: {
        host: "mail.example.test", port: 993, secure: true, username: "person@example.test",
        smtpHost: "mail.example.test", smtpPort: 587, smtpSecure: false, smtpUsername: "person@example.test",
      },
    });
    expect(requests.map(({ url }) => url).sort()).toEqual([
      "https://autoconfig.example.test/mail/config-v1.1.xml",
      "https://autoconfig.thunderbird.net/v1.1/example.test",
      "https://example.test/.well-known/autoconfig/mail/config-v1.1.xml",
    ]);
    for (const { init } of requests) {
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("falls back to the ISPDB, then to the MX host's provider", async () => {
    const ispdb = stubFetch({ "https://autoconfig.thunderbird.net/v1.1/example.test": new Response(ispdbConfig) });
    expect((await createAccountDiscovery({ fetch: ispdb.fetch, resolveMx: noMx })("person@example.test")).source).toBe("ispdb");

    const mx = stubFetch({});
    expect(await createAccountDiscovery({ fetch: mx.fetch, resolveMx: mxAt("in1-smtp.messagingengine.com.") })("person@example.test"))
      .toEqual({
        provider: "fastmail",
        source: "mx",
        settings: {
          host: "imap.fastmail.com", port: 993, secure: true, username: "person@example.test",
          smtpHost: "smtp.fastmail.com", smtpPort: 465, smtpSecure: true, smtpUsername: "person@example.test",
        },
      });
  });

  test("treats redirects, oversized bodies, failures and timeouts as no answer", async () => {
    const { fetch } = stubFetch({
      "https://autoconfig.example.test/mail/config-v1.1.xml": new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } }),
      "https://example.test/.well-known/autoconfig/mail/config-v1.1.xml": () => new Response(ownConfig + " ".repeat(MAX_DOCUMENT_BYTES)),
      "https://autoconfig.thunderbird.net/v1.1/example.test": () => { throw new TypeError("network down"); },
    });
    const discover = createAccountDiscovery({ fetch, resolveMx: () => new Promise(() => {}), timeoutMs: 5 });
    expect(await discover("person@example.test")).toEqual({ provider: null, source: null, settings: null });

    const hanging: DiscoveryFetch = (_url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
    expect((await createAccountDiscovery({ fetch: hanging, resolveMx: noMx, timeoutMs: 5 })("person@example.test")).settings).toBeNull();
  });

  test("makes no lookup for IP literals, single labels or URL-like domains", async () => {
    for (const email of ["person@[127.0.0.1]", "person@intranet", "person@10.0.0.1", "person@example.test:8443", "person@example.test/x"]) {
      expect(lookupDomain(email)).toBeNull();
    }
    expect(lookupDomain("person@Example.TEST.")).toBe("example.test");

    const { fetch, requests } = stubFetch({});
    expect(await createAccountDiscovery({ fetch, resolveMx: noMx })("person@intranet")).toEqual({ provider: null, source: null, settings: null });
    expect(requests).toEqual([]);
  });

  test("recognizes providers without password sign-in through MX", async () => {
    const { fetch } = stubFetch({});
    expect(await createAccountDiscovery({ fetch, resolveMx: mxAt("example-test.mail.protection.outlook.com") })("person@example.test"))
      .toEqual({ provider: "outlook", source: "mx", settings: null });
  });
});

describe("autoconfig documents", () => {
  test("skip unencrypted, OAuth-only and invalid servers", () => {
    const xml = clientConfig(
      server("plain.example.test", 143, "plain")
        + "</incomingServer><incomingServer type=\"imap\">" + server("oauth.example.test", 993, "SSL", "%EMAILADDRESS%", "OAuth2")
        + "</incomingServer><incomingServer type=\"imap\">" + server("127.0.0.1", 993, "SSL")
        + "</incomingServer><incomingServer type=\"imap\">" + server("imap.example.test", 993, "SSL", "%EMAILLOCALPART%"),
      server("smtp.example.test", 465, "SSL", "%EMAILLOCALPART%@%EMAILDOMAIN%"),
    );
    expect(parseClientConfig(xml, "person@example.test")).toEqual({
      host: "imap.example.test", port: 993, secure: true, username: "person",
      smtpHost: "smtp.example.test", smtpPort: 465, smtpSecure: true, smtpUsername: "person@example.test",
    });
  });

  test("require both an IMAP and an SMTP server and fall back to the address for unknown placeholders", () => {
    const plainOnly = clientConfig(server("mail.example.test", 143, "plain"), server("mail.example.test", 465, "SSL"));
    expect(parseClientConfig(plainOnly, "person@example.test")).toBeNull();
    expect(parseClientConfig("<html>not a config</html>", "person@example.test")).toBeNull();

    const realName = clientConfig(server("imap.example.test", 993, "SSL", "%REALNAME%"), server("smtp.example.test", 465, "SSL"));
    expect(parseClientConfig(realName, "person@example.test")?.username).toBe("person@example.test");
  });
});

describe("discovery route", () => {
  test("returns the injected proposal and rejects invalid addresses", async () => {
    const { service } = await createEmptyTestHarness();
    const requested: string[] = [];
    const app = createApi(service, undefined, {
      discoverAccount: async (email) => {
        requested.push(email);
        return { provider: "fastmail", source: "provider", settings: null };
      },
    });
    const post = (body: unknown) => app.request("/api/accounts/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const found = await post({ email: "person@fastmail.com" });
    expect(found.status).toBe(200);
    expect(accountDiscoverySchema.parse(await found.json()).provider).toBe("fastmail");
    expect((await post({ email: "not-an-address" })).status).toBe(400);
    expect(requested).toEqual(["person@fastmail.com"]);
  });
});
