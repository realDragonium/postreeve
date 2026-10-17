import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { checkRecords, dohLookup, parseZoneFile, type DnsLookup } from "../src/server/stalwart/dns";

// Zone text exactly as a Stalwart v0.16.26 server generated it for example.org.
const zone = readFileSync(new URL("./fixtures/stalwart-0.16-zone.txt", import.meta.url), "utf8");

describe("Stalwart zone parsing", () => {
  const records = parseZoneFile(zone, "example.org");

  test("groups every record the domain needs", () => {
    const counts = Object.fromEntries([...new Set(records.map(({ category }) => category))].map((category) => [category, records.filter((record) => record.category === category).length]));
    expect(counts).toEqual({ dkim: 2, spf: 2, mx: 1, dmarc: 1, srv: 6, "mta-sts": 2, "tls-rpt": 1, autoconfig: 3, autodiscover: 1 });
    expect(records.find(({ category }) => category === "mx")).toEqual({ category: "mx", name: "example.org.", type: "MX", value: "10 mail.example.org." });
    expect(records.filter(({ category }) => category === "spf").map(({ name }) => name)).toEqual(["mail.example.org.", "example.org."]);
  });

  test("joins a parenthesised multi-string DKIM value into one copyable value", () => {
    const rsa = records.find(({ name }) => name.startsWith("v1-rsa-"))!;
    expect(rsa.type).toBe("TXT");
    expect(rsa.value).toStartWith("v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBg");
    expect(rsa.value).toEndWith("IDAQAB");
    expect(rsa.value).not.toMatch(/["()\n]/);
  });

  test("resolves relative names against the origin", () => {
    expect(parseZoneFile("@ 3600 IN MX 10 mail.example.org.\n_dmarc IN TXT \"v=DMARC1; p=none\" ; comment\n", "example.org")).toEqual([
      { category: "mx", name: "example.org.", type: "MX", value: "10 mail.example.org." },
      { category: "dmarc", name: "_dmarc.example.org.", type: "TXT", value: "v=DMARC1; p=none" },
    ]);
  });
});

describe("live DNS verification", () => {
  const records = parseZoneFile(zone, "example.org");
  const pick = (category: string) => records.filter((record) => record.category === category);

  test("reports ok, different, missing and error per record", async () => {
    const answers: Record<string, string[] | Error> = {
      "example.org./MX": ["10 MAIL.example.org"],
      "example.org./TXT": ["v=spf1 include:old.example -all", "google-site-verification=abc"],
      "mail.example.org./TXT": ["v=spf1  a -all"],
      "_dmarc.example.org./TXT": [],
      "_smtp._tls.example.org./TXT": new Error("Lookup timed out"),
    };
    const dns: DnsLookup = { label: "fake", lookup: async (name, type) => {
      const answer = answers[`${name}/${type}`] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    } };
    const checks = await checkRecords([...pick("mx"), ...pick("spf"), ...pick("dmarc"), ...pick("tls-rpt")], dns);
    expect(checks.map(({ name, status, found, error }) => ({ name, status, found, error }))).toEqual([
      { name: "example.org.", status: "ok", found: ["10 MAIL.example.org"], error: null },
      { name: "mail.example.org.", status: "ok", found: ["v=spf1  a -all"], error: null },
      { name: "example.org.", status: "different", found: ["v=spf1 include:old.example -all"], error: null },
      { name: "_dmarc.example.org.", status: "missing", found: [], error: null },
      { name: "_smtp._tls.example.org.", status: "error", found: [], error: "Lookup timed out" },
    ]);
  });

  test("DNS-over-HTTPS sends only the name and type and joins split TXT strings", async () => {
    const urls: string[] = [];
    const lookup = dohLookup((async (input: URL) => {
      urls.push(String(input));
      if (input.searchParams.get("name") === "missing.example.org.") return Response.json({ Status: 3 });
      return Response.json({ Status: 0, Answer: [
        { name: "example.org.", type: 16, TTL: 300, data: "\"v=DKIM1; k=rsa; p=AAA\" \"BBB\"" },
        { name: "example.org.", type: 5, TTL: 300, data: "other.example.org." },
      ] });
    }) as unknown as typeof fetch, "https://dns.example.net/dns-query");
    expect(lookup.label).toBe("DNS-over-HTTPS (dns.example.net)");
    expect(await lookup.lookup("example.org.", "TXT")).toEqual(["v=DKIM1; k=rsa; p=AAABBB"]);
    expect(await lookup.lookup("missing.example.org.", "TXT")).toEqual([]);
    expect(urls[0]).toBe("https://dns.example.net/dns-query?name=example.org.&type=TXT");
  });
});
