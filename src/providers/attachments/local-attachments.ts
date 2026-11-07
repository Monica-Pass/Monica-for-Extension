import type { ProviderAccount, VaultItem } from '../../core/model';
import { validateLocalAttachments } from '../../core/local-transfer';
import { localAttachmentSummary } from '../../core/local-attachments';
import type { SecureVaultService } from '../../security/secure-vault-service';
import { base64ToBytes, bytesToBase64 } from '../../security/encoding';
import { mdbx2TransferOperationScope as hash } from '../mdbx2/mdbx2-transfer-identity';
import { ProviderAttachmentError, PROVIDER_ATTACHMENT_CHUNK_BYTES, PROVIDER_ATTACHMENT_UPLOAD_TTL_MS, type ProviderAttachmentSummary } from './attachment-contract';
import type { TransferAttachmentSource } from './transfer-attachment-source';

export class LocalAttachmentService implements TransferAttachmentSource {
  private generation = 0;
  private reads = new Map<string, { providerId: string; itemId: string; sessionId: string; attachment: ProviderAttachmentSummary; bytes: Uint8Array; timer: ReturnType<typeof setTimeout> }>();
  constructor(private readonly vault: Pick<SecureVaultService, 'readLocalAttachmentSnapshot'>) {}
  async list(account: ProviderAccount, item: VaultItem) {
    const current = await this.vault.readLocalAttachmentSnapshot(account.id, item.id);
    if (await hash(current.item) !== await hash(item)) throw new Error('来源项目已变化，请重新读取。');
    return Promise.all(current.files.map(localAttachmentSummary));
  }
  async read(account: ProviderAccount, item: VaultItem, attachment: Pick<ProviderAttachmentSummary, 'attachmentId' | 'fileName'>) {
    const generation = this.generation;
    const current = await this.vault.readLocalAttachmentSnapshot(account.id, item.id);
    const file = current.files.find(row => row.attachmentId === attachment.attachmentId && row.fileName === attachment.fileName);
    if (!file || await hash(current.item) !== await hash(item)) throw new Error('来源附件或项目已变化，请重新读取。');
    await validateLocalAttachments([file], item.id);
    if (generation !== this.generation) throw new Error('附件读取已取消。');
    return base64ToBytes(file.dataBase64);
  }
  async begin(providerId: string, itemId: string, attachmentId: string) {
    const generation = this.generation;
    if (this.reads.size >= 4) throw new ProviderAttachmentError('attachment-read-limit', '同时进行的附件下载过多，请稍后重试。');
    const current = await this.vault.readLocalAttachmentSnapshot(providerId, itemId);
    const file = current.files.find(row => row.attachmentId === attachmentId);
    if (!file || !current.sessionId) throw new Error('本地附件不存在或密码库已锁定。');
    await validateLocalAttachments([file], itemId);
    const attachment = await localAttachmentSummary(file), readHandle = crypto.randomUUID();
    if (generation !== this.generation) throw new Error('附件读取已取消。');
    if (this.reads.size >= 4) throw new ProviderAttachmentError('attachment-read-limit', '同时进行的附件下载过多，请稍后重试。');
    this.reads.set(readHandle, { providerId, itemId, sessionId: current.sessionId, attachment, bytes: base64ToBytes(file.dataBase64),
      timer: setTimeout(() => this.release(providerId, readHandle), PROVIDER_ATTACHMENT_UPLOAD_TTL_MS) });
    return { ...attachment, readHandle, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES };
  }
  async chunk(providerId: string, readHandle: string, offset: number, maxBytes = PROVIDER_ATTACHMENT_CHUNK_BYTES) {
    const route = this.reads.get(readHandle);
    if (!route || route.providerId !== providerId) throw new Error('附件下载已过期。');
    try {
      const current = await this.vault.readLocalAttachmentSnapshot(providerId, route.itemId);
      const file = current.files.find(row => row.attachmentId === route.attachment.attachmentId);
      if (current.sessionId !== route.sessionId || !file || (await localAttachmentSummary(file)).revision !== route.attachment.revision)
        throw new Error('下载期间附件或解锁会话已变化。');
      if (this.reads.get(readHandle) !== route) throw new Error('附件读取已取消。');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > route.bytes.length || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > PROVIDER_ATTACHMENT_CHUNK_BYTES)
        throw new Error('附件读取范围无效。');
      const bytes = route.bytes.subarray(offset, Math.min(offset + maxBytes, route.bytes.length));
      // Slow consumers must not lose an active download to the idle TTL; renew on
      // every served chunk the way the upload store renews writes.
      clearTimeout(route.timer);
      route.timer = setTimeout(() => this.release(providerId, readHandle), PROVIDER_ATTACHMENT_UPLOAD_TTL_MS);
      return { readHandle, attachmentId: route.attachment.attachmentId, fileName: route.attachment.fileName, sizeBytes: route.bytes.length,
        offset, nextOffset: offset + bytes.length, dataBase64: bytesToBase64(bytes), eof: offset + bytes.length === route.bytes.length };
    } catch (error) { this.release(providerId, readHandle); throw error; }
  }
  release(providerId: string, readHandle: string) {
    const route = this.reads.get(readHandle);
    if (!route || route.providerId !== providerId) return false;
    route.bytes.fill(0); clearTimeout(route.timer); return this.reads.delete(readHandle);
  }
  clear() { this.generation++; for (const [id, route] of this.reads) this.release(route.providerId, id); }
}
