import { domainToASCII } from "node:url";
import MailComposer from "nodemailer/lib/mail-composer";
import type { Attachment, Options } from "nodemailer/lib/mailer";
import { htmlToPlainText, sanitizeOutgoingHtml } from "./outgoing-html";
import { MailSendPreDispatchError } from "./sender";

export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export interface OutgoingAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly content: Uint8Array;
}

export type OutgoingBody = { readonly text: string } | { readonly html: string };

export interface OutgoingContent {
  readonly files?: readonly OutgoingAttachment[];
  readonly maxMessageBytes?: number;
}

export function outgoingMessageId(fromAddress: string): string {
  const domain = domainToASCII(fromAddress.slice(fromAddress.lastIndexOf("@") + 1).toLowerCase());
  return `<${crypto.randomUUID()}@${domain || "localhost"}>`;
}

export function positiveByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Mail size limits must be positive integers");
  return value;
}

export function assertMessageSize(content: Uint8Array, limit = DEFAULT_MAX_MESSAGE_BYTES): void {
  if (content.byteLength > positiveByteLimit(limit)) {
    throw new MailSendPreDispatchError(`The complete encoded message exceeds the ${limit}-byte message limit`);
  }
}

export async function composeMime(
  options: Options,
  body: OutgoingBody,
  content: OutgoingContent = {},
  keepBcc = false,
): Promise<Buffer> {
  const html = "html" in body ? sanitizeOutgoingHtml(body.html) : null;
  const text = html === null && "text" in body ? body.text : htmlToPlainText(html ?? "");
  const composer = new MailComposer({
    ...options,
    text: base64Part(text),
    ...(html === null ? {} : { html: base64Part(html) }),
    attachments: (content.files ?? []).map((attachment): Attachment => ({
      filename: attachment.name,
      contentType: attachment.type,
      content: Buffer.from(attachment.content),
      contentDisposition: "attachment",
      contentTransferEncoding: "base64",
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  composer.keepBcc = keepBcc;
  const raw = await composer.build();
  assertMessageSize(raw, content.maxMessageBytes);
  return raw;
}

function base64Part(value: string): Attachment {
  return { content: Buffer.from(value, "utf8"), contentTransferEncoding: "base64" };
}
