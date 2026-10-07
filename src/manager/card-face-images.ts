import type { ProviderAttachmentSummary } from "../providers/attachments/attachment-contract";

/** Persist filenames, as Android does; ambiguous names must not select arbitrary bytes. */
export function cardFaceImageOptions(attachments: readonly ProviderAttachmentSummary[]): string[] {
  return attachments.filter(item => {
    const mime = item.mediaType?.split(";")[0].trim().toLowerCase();
    const image = mime && mime !== "application/octet-stream"
      ? /^image\/(png|jpeg|webp|gif)$/.test(mime)
      : /\.(png|jpe?g|webp|gif)$/i.test(item.fileName);
    return image && attachments.filter(other => other.fileName === item.fileName || other.attachmentId === item.fileName).length === 1;
  }).map(item => item.fileName);
}
