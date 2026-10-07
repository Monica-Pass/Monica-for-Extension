import type { ProviderAccount, VaultItem } from "../core/model";
import { ProviderAttachmentError, type ProviderAttachmentMutationResult } from "../providers/attachments/attachment-contract";
import type { ProviderAttachmentUploadStore } from "../providers/attachments/attachment-upload-store";
import type { MonicaWebDavProvider } from "../providers/webdav/monica-webdav-provider";

const inFlight = new WeakMap<ProviderAttachmentUploadStore, Map<string, Promise<ProviderAttachmentMutationResult>>>();

/** Complete through the existing staged/encrypted ZIP adapter. A failed PUT must
 * never become a successful transfer receipt or modify the caller's item. */
export async function finishWebDavAttachmentUpload(
  uploads: ProviderAttachmentUploadStore,
  adapter: Pick<MonicaWebDavProvider, "addAttachment">,
  account: ProviderAccount,
  item: VaultItem,
  request: { transferId: string; operationId?: string }
): Promise<ProviderAttachmentMutationResult> {
  const intent = uploads.intent(request.transferId);
  if (account.kind !== "monica-webdav" || !intent || intent.providerId !== account.id || intent.itemId !== item.id || intent.providerKind !== "monica-webdav") {
    throw new ProviderAttachmentError("attachment-upload-target-mismatch", "Android portable 附件上传目标与当前项目不一致。");
  }
  if (request.operationId && intent.operationId && request.operationId !== intent.operationId) {
    throw new ProviderAttachmentError("attachment-operation-invalid", "附件完成操作与已开始的上传不一致。");
  }
  const committed = uploads.committedResult(request.transferId);
  if (committed) return committed;
  if (typeof account.config.backupPassword !== "string" || !account.config.backupPassword) {
    throw new ProviderAttachmentError("attachment-encryption-required", "写入 Android portable 附件前必须设置 WebDAV 备份密码。");
  }
  if (intent.replaceExisting && !intent.attachmentId) {
    throw new ProviderAttachmentError("attachment-id-required", "替换 Android portable 附件需要指定现有附件。");
  }
  let pending = inFlight.get(uploads);
  if (!pending) { pending = new Map(); inFlight.set(uploads, pending); }
  const previous = pending.get(request.transferId);
  if (previous) return previous;
  const operation = (async () => {
    const upload = await uploads.complete(request.transferId);
    const attachment = await adapter.addAttachment(account, item, {
      fileName: upload.intent.fileName,
      mediaType: upload.intent.mediaType,
      sizeBytes: upload.intent.sizeBytes,
      sha256Hex: upload.sha256,
      attachmentId: upload.intent.replaceExisting ? upload.intent.attachmentId : undefined
    }, upload.bytes);
    const result = { changed: true, attachment };
    uploads.markCommitted(request.transferId, result);
    return result;
  })();
  pending.set(request.transferId, operation);
  try { return await operation; }
  finally { pending.delete(request.transferId); }
}
