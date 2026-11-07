import { describe, expect, it, vi } from 'vitest';
import { SecureVaultService } from '../../security/secure-vault-service';
import { MemoryVaultStorage } from '../../security/vault-storage';
import { MemoryVaultSessionStore } from '../../security/vault-session';
import { createLoginItem } from '../../core/model';
import { bytesToBase64 } from '../../security/encoding';
import { PROVIDER_ATTACHMENT_UPLOAD_TTL_MS } from './attachment-contract';
import { LocalAttachmentService } from './local-attachments';
import type { LocalAttachmentMutation } from '../../core/local-attachments';

async function fixture() {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), service = new SecureVaultService(storage, sessions);
  const item = createLoginItem({ title: 'Synthetic file owner' }), state = await service.setup('', [item]);
  const bytes = new TextEncoder().encode('synthetic maFile'), digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const input: LocalAttachmentMutation = { operationId: crypto.randomUUID(), providerId: state.providers[0].id, itemId: item.id, attachmentId: crypto.randomUUID(), mode: 'create' };
  input.attachment = { itemId: item.id, attachmentId: input.attachmentId, fileName: 'steam.maFile', sizeBytes: bytes.length, sha256: [...digest].map(n => n.toString(16).padStart(2, '0')).join(''), dataBase64: bytesToBase64(bytes) };
  const sessionId = (await sessions.read())!.id!, files = new LocalAttachmentService(service);
  return { service, storage, sessions, input, sessionId, files };
}
describe('local encrypted attachments', () => {
  it('enforces the read limit under concurrent starts and supports the sole-local alias', async () => {
    const { service, input, sessionId, files } = await fixture();
    try {
      await service.mutateLocalAttachment(input, sessionId);
      expect((await service.getProvider('local'))?.id).toBe(input.providerId);
      expect((await service.readLocalAttachmentSnapshot('local', input.itemId)).files).toHaveLength(1);
      const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => files.begin(input.providerId, input.itemId, input.attachmentId)));
      expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(4);
      await service.upsertProvider({ id: 'other-local', kind: 'local', name: 'Other', config: {}, enabled: true, isDefaultSaveTarget: false });
      expect(await service.getProvider('local')).toBeUndefined();
      await expect(service.readLocalAttachmentSnapshot('local', input.itemId)).rejects.toThrow('不可用');
    } finally { files.clear(); }
  });
  it('uploads and downloads exact bytes; old upload and deletion retries do not undo later changes', async () => {
    const { service, storage, input, sessionId, files } = await fixture();
    try {
      const uploaded = await service.mutateLocalAttachment(input, sessionId);
      const begun = await files.begin(input.providerId, input.itemId, input.attachmentId);
      expect((await files.chunk(input.providerId, begun.readHandle, 0)).dataBase64).toBe(input.attachment!.dataBase64);
      files.release(input.providerId, begun.readHandle);
      const remove = { ...input, operationId: crypto.randomUUID(), mode: 'delete' as const, attachment: undefined, expectedRevision: uploaded.attachment!.revision };
      await service.mutateLocalAttachment(remove, sessionId);
      const afterDelete = await storage.read();
      await service.mutateLocalAttachment(input, sessionId);
      expect(await storage.read()).toEqual(afterDelete);
      await service.mutateLocalAttachment(remove, sessionId);
      expect((await service.readState()).localItemAttachments).toEqual([]);
    } finally { files.clear(); }
  });
  it('refuses stale replacement/deletion and interrupted download after replacement', async () => {
    const { service, input, sessionId, files } = await fixture();
    try {
      const uploaded = await service.mutateLocalAttachment(input, sessionId), begun = await files.begin(input.providerId, input.itemId, input.attachmentId);
      const replace = { ...input, operationId: crypto.randomUUID(), mode: 'replace' as const, expectedRevision: uploaded.attachment!.revision,
        attachment: { ...input.attachment!, mediaType: 'application/json' } };
      await service.mutateLocalAttachment(replace, sessionId);
      await expect(service.mutateLocalAttachment({ ...replace, operationId: crypto.randomUUID() }, sessionId)).rejects.toThrow('已变化');
      await expect(service.mutateLocalAttachment({ ...replace, mode: 'delete', operationId: crypto.randomUUID(), attachment: undefined }, sessionId)).rejects.toThrow('已变化');
      await expect(files.chunk(input.providerId, begun.readHandle, 0)).rejects.toThrow('已变化');
    } finally { files.clear(); }
  });
  it('does not commit a bad body or another item attachment and releases reads on lock/invalid bounds', async () => {
    const { service, storage, input, sessionId, files } = await fixture();
    try {
      const before = await storage.read();
      await expect(service.mutateLocalAttachment({ ...input, attachment: { ...input.attachment!, dataBase64: 'AAAA' } }, sessionId)).rejects.toThrow('完整性');
      await expect(service.mutateLocalAttachment({ ...input, itemId: 'other-item' }, sessionId)).rejects.toThrow('不可用');
      expect(await storage.read()).toEqual(before);
      await service.mutateLocalAttachment(input, sessionId);
      const first = await files.begin(input.providerId, input.itemId, input.attachmentId);
      await expect(files.chunk(input.providerId, first.readHandle, 0, -1)).rejects.toThrow('范围');
      expect(files.release(input.providerId, first.readHandle)).toBe(false);
      const second = await files.begin(input.providerId, input.itemId, input.attachmentId);
      await service.lock();
      await expect(files.chunk(input.providerId, second.readHandle, 0)).rejects.toThrow();
      expect(files.release(input.providerId, second.readHandle)).toBe(false);
    } finally { files.clear(); }
  });
  it('cannot repopulate a cleared read cache from an in-flight begin', async () => {
    const { service, input, sessionId, files } = await fixture();
    try {
      await service.mutateLocalAttachment(input, sessionId);
      const original = service.readLocalAttachmentSnapshot.bind(service);
      vi.spyOn(service, 'readLocalAttachmentSnapshot').mockImplementation(async (...args) => { const result = await original(...args); files.clear(); return result; });
      await expect(files.begin(input.providerId, input.itemId, input.attachmentId)).rejects.toThrow('已取消');
    } finally { files.clear(); }
  });
  it('renews the read session on every served chunk and expires only when idle', async () => {
    const { service, input, sessionId, files } = await fixture();
    await service.mutateLocalAttachment(input, sessionId);
    vi.useFakeTimers();
    try {
      const begun = await files.begin(input.providerId, input.itemId, input.attachmentId);
      vi.advanceTimersByTime(PROVIDER_ATTACHMENT_UPLOAD_TTL_MS - 1);
      expect((await files.chunk(input.providerId, begun.readHandle, 0)).dataBase64).toBe(input.attachment!.dataBase64);
      vi.advanceTimersByTime(PROVIDER_ATTACHMENT_UPLOAD_TTL_MS - 1);
      expect((await files.chunk(input.providerId, begun.readHandle, 0)).eof).toBe(true);
      vi.advanceTimersByTime(PROVIDER_ATTACHMENT_UPLOAD_TTL_MS + 1);
      await expect(files.chunk(input.providerId, begun.readHandle, 0)).rejects.toThrow('已过期');
    } finally { vi.useRealTimers(); files.clear(); }
  });
});
