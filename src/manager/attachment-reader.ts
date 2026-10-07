import type { ProviderAttachmentPage, ProviderAttachmentReadBeginResult, ProviderAttachmentReadChunk } from "../providers/attachments/attachment-contract";
import type { WalletAsset } from "../core/password-content";
import { base64ToBytes } from "../security/encoding";

export interface AttachmentReader {
  listProviderAttachments(providerId: string, itemId: string, input: { cursor?: string; pageSize: number }): Promise<ProviderAttachmentPage>;
  beginProviderAttachmentRead(providerId: string, itemId: string, attachmentId: string): Promise<ProviderAttachmentReadBeginResult>;
  readProviderAttachmentChunk(providerId: string, handle: string, offset: number): Promise<ProviderAttachmentReadChunk>;
  releaseProviderAttachmentRead(providerId: string, handle: string): Promise<unknown>;
}
export const PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
export async function attachmentSha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Explicit, bounded, cancellable reads. No bytes are exposed until the complete read is verified. */
export async function readVerifiedAttachment(client: AttachmentReader, providerId: string, itemId: string, name: string, expected?: WalletAsset, signal?: AbortSignal) {
  const check = () => { if (signal?.aborted) throw new DOMException("附件读取已取消。", "AbortError"); };
  check();
  const cursors = new Set<string>(); let cursor: string | undefined;
  const matches: ProviderAttachmentPage["items"] = [];
  let pages = 0;
  do {
    if (++pages > 200 || cursor && cursors.has(cursor)) throw new Error("附件分页异常，未打开。");
    if (cursor) cursors.add(cursor);
    const page = await client.listProviderAttachments(providerId, itemId, { cursor, pageSize: 50 }); check();
    matches.push(...page.items.filter(item => item.fileName === name || item.attachmentId === name));
    cursor = page.nextCursor;
  } while (cursor);
  if (matches.length !== 1) throw new Error(matches.length ? "附件名称重复，未打开。" : "附件或 Blob 缺失，原内容未修改。");
  let handle: string | undefined;
  try {
    const start = await client.beginProviderAttachmentRead(providerId, itemId, matches[0].attachmentId);
    handle = start.readHandle; check();
    if (!handle || !Number.isSafeInteger(start.sizeBytes) || start.sizeBytes < 0 || start.sizeBytes > PREVIEW_MAX_BYTES) throw new Error("预览上限为 64 MiB，请使用附件管理下载。");
    if (expected && start.sizeBytes !== expected.size) throw new Error("附件大小不匹配，未打开。");
    const bytes = new Uint8Array(start.sizeBytes); let offset = 0;
    do {
      const chunk = await client.readProviderAttachmentChunk(providerId, handle, offset); check();
      const data = base64ToBytes(chunk.dataBase64);
      if (chunk.readHandle !== handle || chunk.attachmentId !== start.attachmentId || chunk.sizeBytes !== bytes.length || chunk.offset !== offset || chunk.nextOffset !== offset + data.length || chunk.nextOffset > bytes.length || (!data.length && bytes.length > 0) || chunk.eof !== (chunk.nextOffset === bytes.length)) throw new Error("附件分段校验失败。");
      bytes.set(data, offset); offset = chunk.nextOffset;
    } while (offset < bytes.length);
    const sha256 = await attachmentSha256(bytes); check();
    if (expected && sha256 !== expected.sha256) throw new Error("附件 SHA-256 不匹配，未打开。");
    return { bytes, sha256, mediaType: expected?.mimeType || start.mediaType || "application/octet-stream", fileName: start.fileName };
  } finally {
    if (handle) await client.releaseProviderAttachmentRead(providerId, handle).catch(() => undefined);
  }
}
