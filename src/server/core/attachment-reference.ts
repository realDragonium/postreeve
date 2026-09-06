import { z } from "zod";
import type { MailProviderKind } from "../../shared/contracts";
import type { ProviderAttachmentLocator } from "../mail/provider";

const attachmentReferencePayloadSchema = z.object({
  version: z.literal(1),
  tenantId: z.string().min(1),
  accountId: z.string().min(1),
  canonicalMessageId: z.string().min(1),
  provider: z.enum(["gmail", "imap"]),
  locator: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("gmail"), messageId: z.string().min(1), partId: z.string() }),
    z.object({
      kind: z.literal("imap"),
      mailbox: z.string().min(1),
      uidValidity: z.string().min(1),
      uid: z.number().int().positive(),
      part: z.string().min(1),
    }),
  ]),
});

export interface AttachmentReferenceScope {
  readonly tenantId: string;
  readonly accountId: string;
  readonly canonicalMessageId: string;
  readonly provider: MailProviderKind;
}

export function encodeAttachmentReference(
  scope: AttachmentReferenceScope,
  locator: ProviderAttachmentLocator,
): string {
  return Buffer.from(JSON.stringify(attachmentReferencePayloadSchema.parse({
    version: 1,
    ...scope,
    locator,
  })), "utf8").toString("base64url");
}

export function decodeAttachmentReference(reference: string) {
  try {
    return attachmentReferencePayloadSchema.parse(JSON.parse(Buffer.from(reference, "base64url").toString("utf8")));
  } catch {
    throw new Error("Attachment reference is invalid or stale");
  }
}

export function safeAttachmentFilename(value: string): string {
  const leaf = value.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "";
  const trimmed = Array.from(leaf.replace(/^\.+$/, ""))
    .slice(0, 240)
    .map((character) => {
      const code = character.charCodeAt(0);
      return character.length === 1 && code >= 0xd800 && code <= 0xdfff ? "\ufffd" : character;
    })
    .join("");
  return trimmed || "attachment";
}

export function safeAttachmentMediaType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)
    ? mediaType
    : "application/octet-stream";
}

export function attachmentDisposition(filename: string): string {
  const safe = safeAttachmentFilename(filename);
  const fallback = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
