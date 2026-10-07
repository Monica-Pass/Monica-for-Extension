import { expect, it } from "vitest";
import { cardFaceImageOptions } from "./card-face-images";
import type { ProviderAttachmentSummary } from "../providers/attachments/attachment-contract";
const image = (attachmentId: string, fileName: string, mediaType?: string): ProviderAttachmentSummary => ({ attachmentId, fileName, mediaType, sizeBytes: 12, protected: true, providerKind: "mdbx2" });
it("uses native filenames and allows old image metadata without a MIME type", () => {
  expect(cardFaceImageOptions([image("a", "card.PNG"), image("b", "artwork", "image/webp"), image("c", "front.jpg", "application/octet-stream")])).toEqual(["card.PNG", "artwork", "front.jpg"]);
});
it("excludes duplicate names and names colliding with a different attachment ID", () => {
  expect(cardFaceImageOptions([image("a", "face.png"), image("b", "face.png"), image("c", "front.png"), image("front.png", "back.png")])).toEqual(["back.png"]);
});
it("excludes active formats and does not override an explicit MIME with an image suffix", () => {
  expect(cardFaceImageOptions([image("a", "image.png", "text/html"), image("b", "art.svg", "image/svg+xml"), image("c", "text.txt", "text/plain")])).toEqual([]);
});
