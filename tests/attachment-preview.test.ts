import { describe, expect, test } from "bun:test";
import type { ReceivedAttachment } from "../src/shared/contracts";
import { autoPreviewMaxBytes, autoPreviewReferences, previewBlob, previewKind } from "../src/web/attachment-preview";

function attachment(reference: string, mediaType: string, size = 1_000): ReceivedAttachment {
  return { reference, canonicalMessageId: "message", filename: `${reference}.bin`, mediaType, size, sizeIsEstimate: false };
}

describe("attachment preview", () => {
  test("previews raster images and PDFs only", () => {
    expect(previewKind(attachment("a", "image/png"))).toBe("image");
    expect(previewKind(attachment("a", "IMAGE/JPEG; name=x.jpg"))).toBe("image");
    expect(previewKind(attachment("a", "application/pdf"))).toBe("pdf");
    expect(previewKind(attachment("a", "image/svg+xml"))).toBeNull();
    expect(previewKind(attachment("a", "text/html"))).toBeNull();
    expect(previewKind(attachment("a", "application/octet-stream"))).toBeNull();
  });

  test("loads at most eight images of at most 10 MB on their own", () => {
    const list = [
      attachment("big", "image/png", autoPreviewMaxBytes + 1),
      attachment("pdf", "application/pdf"),
      ...Array.from({ length: 9 }, (_, index) => attachment(`image-${index}`, "image/gif")),
    ];
    const auto = autoPreviewReferences(list);
    expect(auto.size).toBe(8);
    expect(auto.has("big")).toBe(false);
    expect(auto.has("pdf")).toBe(false);
    expect(auto.has("image-8")).toBe(false);
  });

  test("retypes bytes to the previewed kind and refuses other types", async () => {
    const bytes = new Blob(["<script>alert(1)</script>"], { type: "text/html" });
    expect(previewBlob(bytes, attachment("a", "application/pdf"))?.type).toBe("application/pdf");
    expect(previewBlob(bytes, attachment("a", "image/webp; x=y"))?.type).toBe("image/webp");
    expect(previewBlob(bytes, attachment("a", "text/html"))).toBeNull();
    expect(await previewBlob(bytes, attachment("a", "image/png"))!.text()).toBe("<script>alert(1)</script>");
  });
});
