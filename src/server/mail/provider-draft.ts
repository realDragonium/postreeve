import { createHash } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  accountIdSchema,
  conversationSendSourceSchema,
  draftIdSchema,
  type ConversationSendSource,
  type Draft,
  type DraftRecipientField,
} from "../../shared/contracts";
import type { ProviderDraftScope } from "./provider";

export interface ProviderDraftMarkers {
  readonly tenantId: string;
  readonly accountId: string;
  readonly postreeveId: string;
  readonly version: number;
}

export async function buildProviderDraftMessage(scope: ProviderDraftScope, draft: Draft): Promise<Buffer> {
  const message = new MailComposer({
    from: draft.identity,
    ...recipientOption("to", draft.to),
    ...recipientOption("cc", draft.cc),
    ...recipientOption("bcc", draft.bcc),
    subject: sanitizeHeader(draft.subject),
    text: "Postreeve draft body",
    date: new Date(draft.updatedAt),
    messageId: `<postreeve-draft-${boundedId(`${scope.tenantId}\0${scope.accountId}\0${draft.id}`)}-${draft.version}@postreeve.local>`,
    headers: [
      { key: "X-Postreeve-Draft-Tenant-ID", value: foldableEncoded(scope.tenantId) },
      { key: "X-Postreeve-Draft-Account-ID", value: foldableEncoded(scope.accountId) },
      { key: "X-Postreeve-Draft-ID", value: foldableEncoded(draft.id) },
      { key: "X-Postreeve-Draft-Version", value: String(draft.version) },
      { key: "X-Postreeve-Draft-Mode", value: draft.mode },
      ...(draft.source
        ? [{ key: "X-Postreeve-Draft-Source", value: foldableEncoded(JSON.stringify(draft.source)) }]
        : []),
    ],
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  message.keepBcc = true;
  const composed = (await message.build()).toString("utf8");
  const separator = composed.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("Draft composer did not produce an RFC header block");
  const headers = composed.slice(0, separator).replace(
    /^Content-Transfer-Encoding:.*$/im,
    "Content-Transfer-Encoding: base64",
  );
  return Buffer.from(`${headers}\r\n\r\n${wrapBase64(Buffer.from(draft.body, "utf8").toString("base64"))}\r\n`, "utf8");
}

export function parseProviderDraftMarkers(source: Buffer | string): ProviderDraftMarkers | null {
  const headers = parseHeaders(source);
  const encodedTenantId = headers.get("x-postreeve-draft-tenant-id")?.replace(/\s/g, "");
  const encodedAccountId = headers.get("x-postreeve-draft-account-id")?.replace(/\s/g, "");
  const encodedId = headers.get("x-postreeve-draft-id")?.replace(/\s/g, "");
  const rawVersion = headers.get("x-postreeve-draft-version");
  if (!encodedTenantId || !encodedAccountId || !encodedId
    || !/^[A-Za-z0-9_-]+$/.test(encodedTenantId)
    || !/^[A-Za-z0-9_-]+$/.test(encodedAccountId)
    || !/^[A-Za-z0-9_-]+$/.test(encodedId)
    || !rawVersion
    || !/^\d+$/.test(rawVersion)) return null;
  try {
    const tenantId = Buffer.from(encodedTenantId, "base64url").toString("utf8");
    const accountId = accountIdSchema.parse(Buffer.from(encodedAccountId, "base64url").toString("utf8"));
    const postreeveId = draftIdSchema.parse(Buffer.from(encodedId, "base64url").toString("utf8"));
    const version = Number(rawVersion);
    return tenantId.trim() && Number.isSafeInteger(version) && version > 0
      ? { tenantId, accountId, postreeveId, version }
      : null;
  } catch {
    return null;
  }
}

export function parseProviderDraftSource(source: Buffer | string): ConversationSendSource | null {
  const encoded = parseHeaders(source).get("x-postreeve-draft-source")?.replace(/\s/g, "");
  if (!encoded) return null;
  try {
    return conversationSendSourceSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

function recipientOption(
  name: "to" | "cc" | "bcc",
  value: DraftRecipientField,
): Partial<Record<"to" | "cc" | "bcc", DraftRecipientField>> {
  if (Array.isArray(value)) return value.length > 0 ? { [name]: value } : {};
  const sanitized = sanitizeHeader(value);
  return sanitized ? { [name]: makeFoldable(sanitized) } : {};
}

function parseHeaders(source: Buffer | string): Map<string, string> {
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
  return headers;
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function makeFoldable(value: string): string {
  return value.split(/(\s+)/).map((part) => part.length > 70 ? part.match(/.{1,70}/gu)?.join(" ") ?? part : part).join("");
}

function foldableEncoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url").match(/.{1,60}/g)?.join(" ") ?? "";
}

function boundedId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}
