import type { LoginItem, ProviderAccount } from '../../core/model';
import type { PasswordProjectAttachmentBackend } from '../attachments/password-project-removal-attachments';
import { PROVIDER_ATTACHMENT_CHUNK_BYTES } from '../attachments/attachment-contract';
import type { Mdbx2NativeClient } from './native-client';

/** Immutable routing also works while local removed rows are tombstoned. */
export function mdbx2ProjectRemovalAttachments(client: Mdbx2NativeClient, account: ProviderAccount,
  items: LoginItem[]): PasswordProjectAttachmentBackend {
  const handle = String(account.config.vaultHandle);
  const rows = structuredClone(items);
  const reads = new Set<string>(), uploads = new Set<string>();
  const checkProvider = (providerId: string) => {
    if (providerId !== account.id || account.kind !== 'mdbx2') throw new Error('密码项目附件来源不一致。');
  };
  const target = (providerId: string, itemId: string) => {
    checkProvider(providerId);
    const ref = rows.find(row => row.id === itemId)?.providerRefs.find(ref => ref.providerId === providerId);
    if (!ref?.remoteId || !ref.remoteFolderId) throw new Error('密码项目附件缺少原生标识。');
    return { objectId: ref.remoteId, collectionId: ref.remoteFolderId };
  };
  const listAttachments: PasswordProjectAttachmentBackend['listAttachments'] = async (providerId, itemId, cursor) => {
    const { objectId, collectionId } = target(providerId, itemId);
    const page = await client.listAttachments(handle, collectionId, objectId, { cursor, pageSize: 50 });
    if (page.items.some(item => item.deleted)) throw new Error('密码项目附件列表包含已删除内容。');
    return { items: page.items.map(item => ({ ...item, providerKind: 'mdbx2' as const })), nextCursor: page.nextCursor };
  };
  return {
    listAttachments,
    async beginRead(providerId, itemId, attachmentId) {
      // Native reads use vault-wide IDs; prove ownership before opening the stream.
      let cursor: string | undefined; const seen = new Set<string>();
      let found = false;
      do {
        const page = await listAttachments(providerId, itemId, cursor);
        found = page.items.some(item => item.attachmentId === attachmentId);
        if (found) break;
        cursor = page.nextCursor;
        if (cursor && (seen.has(cursor) || seen.size >= 512)) throw new Error('密码项目附件分页无效。');
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (!found) throw new Error('密码项目附件已变化。');
      const read = await client.beginAttachmentRead(handle, attachmentId);
      reads.add(read.readHandle);
      return { ...read, protected: true, providerKind: 'mdbx2', maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES };
    },
    async readChunk(providerId, readHandle, offset, maxBytes) {
      checkProvider(providerId); if (!reads.has(readHandle)) throw new Error('未知附件读取会话。');
      return client.readAttachmentChunk(readHandle, offset, maxBytes);
    },
    async releaseRead(providerId, readHandle) {
      checkProvider(providerId); if (!reads.delete(readHandle)) return false;
      return client.releaseAttachmentRead(readHandle);
    },
    async beginUpload(providerId, itemId, input) {
      const destination = target(providerId, itemId);
      const transfer = await client.beginAttachmentUpload(handle, { ...destination, ...input, mode: 'create' });
      uploads.add(transfer.transferId);
      return { ...transfer, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES, expiresAt: Date.now() + 5 * 60_000 };
    },
    async uploadChunk(providerId, transferId, offset, bytes) {
      checkProvider(providerId); if (!uploads.has(transferId)) throw new Error('未知附件上传会话。');
      return client.sendAttachmentUploadChunk(transferId, offset, bytes);
    },
    async finishUpload(providerId, itemId, transferId) {
      target(providerId, itemId); if (!uploads.has(transferId)) throw new Error('未知附件上传会话。');
      try {
        const result = await client.finishAttachmentUpload(transferId);
        return { changed: result.changed, attachment: { ...result.attachment, providerKind: 'mdbx2' } };
      } finally { uploads.delete(transferId); await client.abortAttachmentUpload(transferId).catch(() => false); }
    },
    async abortUpload(providerId, transferId) {
      checkProvider(providerId); if (!uploads.delete(transferId)) return false;
      return client.abortAttachmentUpload(transferId);
    },
    async deleteAttachment() {
      // Verification failure is not authority to delete a concurrently edited copy.
      throw new Error('附件校验未完成，已保留来源和目标副本供检查。');
    }
  };
}
