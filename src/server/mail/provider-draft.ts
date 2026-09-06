import type { Draft, DraftRecipientField, OutboundAddress } from "../../shared/contracts";

export interface ProviderDraftMarkers {
  readonly postreeveId: string;
  readonly version: number;
}

export function buildProviderDraftMessage(draft: Draft): Buffer {
  const headers = [
    `From: ${formatAddress(draft.identity)}`,
    ...recipientHeader("To", draft.to),
    ...recipientHeader("Cc", draft.cc),
    ...recipientHeader("Bcc", draft.bcc),
    `Subject: ${encodedWord(draft.subject)}`,
    `Date: ${new Date(draft.updatedAt).toUTCString()}`,
    `Message-ID: <postreeve-draft-${encodedMarker(draft.id)}-${draft.version}@postreeve.local>`,
    `X-Postreeve-Draft-ID: ${encodedMarker(draft.id)}`,
    `X-Postreeve-Draft-Version: ${draft.version}`,
    `X-Postreeve-Draft-Mode: ${draft.mode}`,
    ...(draft.source ? [`X-Postreeve-Draft-Source: ${encodedMarker(JSON.stringify(draft.source))}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(draft.body, "utf8").toString("base64")),
    "",
  ];
  return Buffer.from(headers.join("\r\n"), "utf8");
}

export function parseProviderDraftMarkers(source: Buffer | string): ProviderDraftMarkers | null {
  const headerBlock = source.toString("utf8").split(/\r?\n\r?\n/, 1)[0] ?? "";
  const headers = new Map<string, string>();
  let current = "";
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current) ?? ""}${line.trim()}`);
      continue;
    }
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    current = line.slice(0, separator).trim().toLowerCase();
    headers.set(current, line.slice(separator + 1).trim());
  }
  const encodedId = headers.get("x-postreeve-draft-id");
  const rawVersion = headers.get("x-postreeve-draft-version");
  if (!encodedId || !rawVersion || !/^\d+$/.test(rawVersion)) return null;
  try {
    const postreeveId = Buffer.from(encodedId, "base64url").toString("utf8");
    const version = Number(rawVersion);
    return postreeveId && Number.isSafeInteger(version) && version > 0 ? { postreeveId, version } : null;
  } catch {
    return null;
  }
}

function recipientHeader(name: string, value: DraftRecipientField): string[] {
  const formatted = typeof value === "string"
    ? sanitizeRawHeader(value)
    : value.map(formatAddress).join(", ");
  return formatted ? [`${name}: ${formatted}`] : [];
}

function formatAddress(address: OutboundAddress): string {
  const safeAddress = sanitizeRawHeader(address.address);
  return address.name ? `${encodedWord(address.name)} <${safeAddress}>` : safeAddress;
}

function sanitizeRawHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function encodedWord(value: string): string {
  return value ? `=?UTF-8?B?${Buffer.from(value.replace(/[\r\n]+/g, " "), "utf8").toString("base64")}?=` : "";
}

function encodedMarker(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}
