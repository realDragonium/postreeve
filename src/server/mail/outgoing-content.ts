import MailComposer from "nodemailer/lib/mail-composer";
import type { Attachment, Options } from "nodemailer/lib/mailer";
import { MailSendPreDispatchError } from "./sender";

export const DEFAULT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export interface OutgoingAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly content: Uint8Array;
}

export interface OutgoingContent {
  readonly files?: readonly OutgoingAttachment[];
  readonly maxMessageBytes?: number;
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
  text: string,
  content: OutgoingContent = {},
  keepBcc = false,
): Promise<Buffer> {
  const textPart: Attachment = { content: Buffer.from(text, "utf8"), contentTransferEncoding: "base64" };
  const composer = new MailComposer({
    ...options,
    text: textPart,
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
