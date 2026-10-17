import type { ReceivedAttachment } from "../shared/contracts";

/** Raster formats an `<img>` can show. SVG is left out: opened on its own it would run script in the app origin. */
const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
export const autoPreviewMaxBytes = 10 * 1024 * 1024;
export const autoPreviewMaxImages = 8;

export type PreviewKind = "image" | "pdf";

function baseType(mediaType: string): string {
  return mediaType.split(";")[0]!.trim().toLowerCase();
}

export function previewKind(attachment: Pick<ReceivedAttachment, "mediaType">): PreviewKind | null {
  const type = baseType(attachment.mediaType);
  if (imageTypes.has(type)) return "image";
  if (type === "application/pdf") return "pdf";
  return null;
}

/** Images that load as soon as the message is expanded; the rest wait for Preview. */
export function autoPreviewReferences(attachments: readonly ReceivedAttachment[]): ReadonlySet<string> {
  return new Set(attachments
    .filter((attachment) => previewKind(attachment) === "image" && attachment.size <= autoPreviewMaxBytes)
    .slice(0, autoPreviewMaxImages)
    .map(({ reference }) => reference));
}

/**
 * Retypes downloaded bytes so the browser treats them only as the previewed kind, whatever the server or the
 * sender claimed. Returns null for anything that must not be previewed.
 */
export function previewBlob(content: Blob, attachment: Pick<ReceivedAttachment, "mediaType">): Blob | null {
  const kind = previewKind(attachment);
  if (kind === null) return null;
  return new Blob([content], { type: kind === "pdf" ? "application/pdf" : baseType(attachment.mediaType) });
}
