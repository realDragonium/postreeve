import type { MailProviderId } from "../../shared/contracts";

export interface ServerSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
}

export interface ProviderEntry {
  readonly id: MailProviderId;
  readonly domains: readonly string[];
  readonly mxSuffixes: readonly string[];
  /** Null for providers that cannot be connected with a password. */
  readonly servers: { readonly imap: ServerSettings; readonly smtp: ServerSettings } | null;
}

const tls = (host: string, port: number): ServerSettings => ({ host, port, secure: true });
const startTls = (host: string, port: number): ServerSettings => ({ host, port, secure: false });

export const providerTable: readonly ProviderEntry[] = [
  {
    id: "icloud",
    domains: ["icloud.com", "me.com", "mac.com"],
    mxSuffixes: ["mail.icloud.com"],
    servers: { imap: tls("imap.mail.me.com", 993), smtp: startTls("smtp.mail.me.com", 587) },
  },
  {
    id: "fastmail",
    domains: ["fastmail.com", "fastmail.fm"],
    mxSuffixes: ["messagingengine.com"],
    servers: { imap: tls("imap.fastmail.com", 993), smtp: tls("smtp.fastmail.com", 465) },
  },
  {
    id: "yahoo",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com"],
    mxSuffixes: ["yahoodns.net"],
    servers: { imap: tls("imap.mail.yahoo.com", 993), smtp: tls("smtp.mail.yahoo.com", 465) },
  },
  {
    id: "aol",
    domains: ["aol.com"],
    // AOL's MX hosts live under yahoodns.net and are matched as Yahoo.
    mxSuffixes: [],
    servers: { imap: tls("imap.aol.com", 993), smtp: tls("smtp.aol.com", 465) },
  },
  {
    id: "zoho",
    domains: ["zoho.com", "zohomail.com"],
    mxSuffixes: ["zoho.com"],
    servers: { imap: tls("imap.zoho.com", 993), smtp: tls("smtp.zoho.com", 465) },
  },
  {
    id: "zoho",
    domains: ["zoho.eu", "zohomail.eu"],
    mxSuffixes: ["zoho.eu"],
    servers: { imap: tls("imap.zoho.eu", 993), smtp: tls("smtp.zoho.eu", 465) },
  },
  {
    id: "gmx",
    domains: ["gmx.com"],
    mxSuffixes: [],
    servers: { imap: tls("imap.gmx.com", 993), smtp: startTls("mail.gmx.com", 587) },
  },
  {
    id: "gmx",
    domains: ["gmx.de", "gmx.net", "gmx.at", "gmx.ch"],
    mxSuffixes: ["gmx.net"],
    servers: { imap: tls("imap.gmx.net", 993), smtp: startTls("mail.gmx.net", 587) },
  },
  {
    id: "gmail",
    domains: ["gmail.com", "googlemail.com"],
    mxSuffixes: ["google.com", "googlemail.com"],
    servers: { imap: tls("imap.gmail.com", 993), smtp: tls("smtp.gmail.com", 465) },
  },
  {
    id: "outlook",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
    mxSuffixes: ["outlook.com"],
    servers: null,
  },
  {
    id: "proton",
    domains: ["proton.me", "protonmail.com", "protonmail.ch", "pm.me"],
    mxSuffixes: ["protonmail.ch"],
    servers: null,
  },
];

export function providerForDomain(domain: string): ProviderEntry | undefined {
  return providerTable.find((entry) => entry.domains.includes(domain));
}

export function providerForMxHost(host: string): ProviderEntry | undefined {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return providerTable.find((entry) =>
    entry.mxSuffixes.some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`)));
}
