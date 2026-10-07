import { describe, expect, it, vi } from 'vitest';
import { strToU8, unzipSync } from 'fflate';
import { createLoginItem, type ProviderKind } from '../../core/model';
import type { PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';
import { bytesToBase64 } from '../../security/encoding';
import { PROVIDER_ATTACHMENT_CHUNK_BYTES, type ProviderAttachmentSummary } from './attachment-contract';
import type { ProviderAttachmentTransferBackend } from './attachment-transfer';
import { preparePasswordProjectRemovalAttachments, verifyPasswordProjectRemovalAttachments, type PasswordProjectAttachmentBackend } from './password-project-removal-attachments';
import { MonicaWebDavProvider } from '../webdav/monica-webdav-provider';
import { decryptAndroidBackup, encryptAndroidBackup } from '../webdav/android-backup-crypto';
import { listAndroidPortableAttachments, readAndroidBackup, readAndroidPortableAttachment, upsertAndroidPortableAttachment, writeAndroidBackup } from '../webdav/android-backup-codec';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function record(kind: ProviderKind = 'mdbx2'): PasswordProjectRemovalRecord {
  const rows = [1, 2].map(n => ({ ...createLoginItem({ title: 'Synthetic', password: `secret-${n}` }), id: id(n),
    passwordGroupId: id(99), providerRefs: [{ providerId: 'provider', remoteId: `remote-${n}` }],
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, value: JSON.stringify({ version: 1, projectId: id(99), groupId: id(10),
      passwordId: id(n + 10), primary: true, label: '', groupOrder: 0, passwordOrder: n - 1 }), protected: true }] }));
  return { version: 1, id: id(88), requestHash: 'a'.repeat(64), createdAt: rows[0].createdAt, updatedAt: rows[0].updatedAt,
    status: 'preparing', retained: [rows[1]], removed: [rows[0]], ownerTransfer: { sourceItemId: id(1), targetItemId: id(2) },
    providerBindings: [{ id: 'provider', kind, name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} }] };
}

/** Protocol-level fake: keeps committed files across fresh coordinators; loses all upload sessions on restart. */
class Backend implements PasswordProjectAttachmentBackend {
  files = new Map<string, { itemId: string; summary: ProviderAttachmentSummary; bytes: Uint8Array }>();
  reads = new Map<string, ReturnType<Backend['snapshot']>>();
  uploads = new Map<string, { itemId: string; input: Parameters<ProviderAttachmentTransferBackend['beginUpload']>[2]; bytes: Uint8Array }>();
  commits = 0;
  failAfterCommit = false;
  afterCommit?: () => void;
  providerKind: ProviderAttachmentSummary['providerKind'] = 'mdbx2';
  snapshot(itemId: string, attachmentId: string) {
    const file = this.files.get(`${itemId}/${attachmentId}`);
    if (!file) throw new Error('file missing');
    return structuredClone(file);
  }
  put(itemId: string, attachmentId: string, bytes: Uint8Array = Uint8Array.of(1, 2, 3), fileName = `${attachmentId}.bin`) {
    this.files.set(`${itemId}/${attachmentId}`, { itemId, bytes: bytes.slice(), summary: {
      attachmentId, providerKind: this.providerKind, fileName, sizeBytes: bytes.length, protected: true, mediaType: 'application/octet-stream' } });
  }
  async listAttachments(_provider: string, itemId: string, cursor?: string) {
    const items = [...this.files.values()].filter(file => file.itemId === itemId).map(file => ({ ...file.summary }));
    const offset = Number(cursor ?? 0);
    return { items: items.slice(offset, offset + 1), nextCursor: offset + 1 < items.length ? String(offset + 1) : undefined };
  }
  async beginRead(_provider: string, itemId: string, attachmentId: string) {
    const file = this.snapshot(itemId, attachmentId), readHandle = crypto.randomUUID();
    this.reads.set(readHandle, file);
    return { ...file.summary, readHandle, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES };
  }
  async readChunk(_provider: string, readHandle: string, offset: number, maxBytes: number) {
    const file = this.reads.get(readHandle)!;
    const nextOffset = Math.min(file.bytes.length, offset + maxBytes, offset + 2);
    return { ...file.summary, readHandle, offset, nextOffset, dataBase64: bytesToBase64(file.bytes.slice(offset, nextOffset)), eof: nextOffset === file.bytes.length };
  }
  async releaseRead(_provider: string, readHandle: string) { return this.reads.delete(readHandle); }
  async beginUpload(_provider: string, itemId: string, input: Parameters<ProviderAttachmentTransferBackend['beginUpload']>[2]) {
    expect(input.replaceExisting).toBe(false);
    if ([...this.files.values()].some(file => file.itemId === itemId && file.summary.fileName === input.fileName)) throw new Error('name conflict');
    const transferId = crypto.randomUUID();
    this.uploads.set(transferId, { itemId, input, bytes: new Uint8Array(input.sizeBytes) });
    return { transferId, nextOffset: 0, maxChunkBytes: PROVIDER_ATTACHMENT_CHUNK_BYTES, expiresAt: Date.now() + 60_000 };
  }
  async uploadChunk(_provider: string, transferId: string, offset: number, bytes: Uint8Array) {
    this.uploads.get(transferId)!.bytes.set(bytes, offset);
    return { transferId, nextOffset: offset + bytes.length, acceptedBytes: bytes.length, repeated: false };
  }
  async finishUpload(_provider: string, itemId: string, transferId: string) {
    const { input, bytes } = this.uploads.get(transferId)!;
    this.put(itemId, input.attachmentId, bytes, input.fileName); this.commits++;
    this.afterCommit?.();
    if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('response lost after commit'); }
    return { changed: true, attachment: this.snapshot(itemId, input.attachmentId).summary };
  }
  async abortUpload(_provider: string, transferId: string) { return this.uploads.delete(transferId); }
  async deleteAttachment(_provider: string, itemId: string, attachmentId: string) {
    if (itemId === id(1)) throw new Error('Source deletion must never be requested');
    return { changed: this.files.delete(`${itemId}/${attachmentId}`) };
  }
}

function setup(kind: ProviderAttachmentSummary['providerKind'] = 'mdbx2') {
  const operation = record(kind), backend = new Backend(); backend.providerKind = kind;
  const vault = { inspectPasswordProjectRemoval: vi.fn(async () => structuredClone({ record: operation, items: [...operation.retained, ...operation.removed] })) };
  return { operation, backend, vault, prepare: () => preparePasswordProjectRemovalAttachments(operation.id, vault, backend) };
}

describe('password project owner attachments', () => {
  it('copies through the actual WebDAV encrypted ZIP adapter and recovers its server-generated attachment ID', async () => {
    const operation = record('monica-webdav'), account = operation.providerBindings[0];
    account.config = { baseUrl: 'https://synthetic.invalid/dav', username: 'synthetic', password: 'synthetic', backupPassword: 'synthetic archive password' };
    const rows = [...operation.removed, ...operation.retained].map(row => ({ ...row, providerRefs: [{ providerId: account.id }] }));
    const seedZip = writeAndroidBackup({ entries: { 'future/unknown.bin': strToU8('unknown preserved') }, items: [], records: new Map(), warnings: [] }, rows, account.id);
    const seed = readAndroidBackup(seedZip, account.id, { allowPortableAttachments: true });
    operation.removed = [seed.items.find(row => row.kind === 'login' && row.password === 'secret-1') as typeof rows[number]];
    operation.retained = [seed.items.find(row => row.kind === 'login' && row.password === 'secret-2') as typeof rows[number]];
    const source = operation.removed[0], target = operation.retained[0];
    operation.ownerTransfer = { sourceItemId: source.id, targetItemId: target.id };
    const bytes = strToU8('  原始附件\r\n00007\tend  ');
    const digest = async (value: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value.slice()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    upsertAndroidPortableAttachment(seed, source, { fileName: 'proof.txt', mimeType: 'text/plain', sizeBytes: bytes.length, sha256Hex: await digest(bytes) }, bytes);
    const before = writeAndroidBackup(seed, seed.items, account.id);
    let remote = await encryptAndroidBackup(before, String(account.config.backupPassword));
    let latest = 'monica_backup_20260101_000000.enc.zip', revision = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers), method = init?.method ?? 'GET';
      if (method === 'PROPFIND') return new Response(headers.get('Depth') === '1'
        ? `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Monica_Backups/${latest}</d:href><d:propstat><d:prop><d:getetag>"${revision}"</d:getetag></d:prop></d:propstat></d:response></d:multistatus>` : '', { status: 207 });
      if (method === 'GET') return new Response(remote.slice(), { headers: { etag: `"${revision}"` } });
      if (method === 'PUT') {
        expect(headers.get('If-None-Match')).toBe('*');
        remote = new Uint8Array(await new Response(init?.body).arrayBuffer()); latest = new URL(String(input)).pathname.split('/').pop()!; revision++;
        return new Response(null, { status: 201, headers: { etag: `"${revision}"` } });
      }
      throw new Error(`Unexpected HTTP ${method}`);
    };
    const provider = new MonicaWebDavProvider(fetcher);
    const find = (itemId: string) => [...operation.removed, ...operation.retained].find(row => row.id === itemId)!;
    class WebDavBackend extends Backend {
      override async listAttachments(_provider: string, itemId: string) {
        const page = await provider.listAttachments(account, find(itemId));
        return { items: page.items, nextCursor: page.nextCursor };
      }
      override async beginRead(_provider: string, itemId: string, attachmentId: string) {
        const read = await provider.readAttachment(account, find(itemId), attachmentId), readHandle = crypto.randomUUID();
        this.reads.set(readHandle, { itemId, summary: read, bytes: read.bytes });
        return { ...read, readHandle };
      }
      override async finishUpload(_provider: string, itemId: string, transferId: string) {
        const { input, bytes } = this.uploads.get(transferId)!;
        // Portable ZIP assigns its own payload path. Its attachmentId argument is for replacement only.
        const attachment = await provider.addAttachment(account, find(itemId), { fileName: input.fileName, mediaType: input.mediaType,
          sizeBytes: input.sizeBytes, sha256Hex: await digest(bytes) }, bytes);
        this.commits++;
        if (this.failAfterCommit) { this.failAfterCommit = false; throw new Error('response lost after ZIP commit'); }
        return { changed: true, attachment };
      }
    }
    const backend = new WebDavBackend(); backend.failAfterCommit = true;
    const vault = { inspectPasswordProjectRemoval: async () => structuredClone({ record: operation, items: [...operation.removed, ...operation.retained] }) };
    await expect(preparePasswordProjectRemovalAttachments(operation.id, vault, backend)).rejects.toThrow('response lost');
    backend.uploads.clear(); backend.reads.clear();
    const result = await preparePasswordProjectRemovalAttachments(operation.id, vault, backend);
    expect(backend.commits).toBe(1); expect(revision).toBe(1);
    expect(result.proofs[0].attachments[0].targetAttachmentId).toMatch(/^android-portable:/);
    const finalZip = await decryptAndroidBackup(remote, String(account.config.backupPassword));
    const final = readAndroidBackup(finalZip, account.id, { allowPortableAttachments: true });
    for (const row of [source, target]) {
      const attachments = listAndroidPortableAttachments(final, row);
      expect(attachments).toHaveLength(1); expect(await readAndroidPortableAttachment(final, attachments[0])).toEqual(bytes);
    }
    const beforeEntries = unzipSync(before), afterEntries = unzipSync(finalZip);
    expect(afterEntries['future/unknown.bin']).toEqual(beforeEntries['future/unknown.bin']);
    expect(final.items).toHaveLength(2);
    for (const raw of seed.records.values()) expect(afterEntries[raw.path]).toEqual(beforeEntries[raw.path]);
  }, 30_000);

  it.each(['mdbx2', 'monica-webdav', 'bitwarden'] as const)('copies paged %s files including an empty file, hashes both ends and preserves originals', async kind => {
    const { operation, backend, prepare } = setup(kind);
    backend.put(id(1), 'a'); backend.put(id(1), 'b', new Uint8Array()); backend.put(id(1), 'c', Uint8Array.of(9, 8));
    const original = [...backend.files.values()].map(file => structuredClone(file));
    const result = await prepare();
    expect(result.proofs[0].attachments).toHaveLength(3); expect(backend.commits).toBe(3);
    expect(result.proofs[0].attachments[1].sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    for (const file of original) expect(backend.snapshot(file.itemId, file.summary.attachmentId)).toEqual(file);
    expect(backend.reads.size).toBe(0); expect(operation.status).toBe('preparing');
    await expect(verifyPasswordProjectRemovalAttachments(operation, result.proofs, backend)).resolves.toBeUndefined();
  });

  it('recovers an upload whose response was lost without uploading another copy after session loss', async () => {
    const { backend, prepare } = setup(); backend.put(id(1), 'a'); backend.failAfterCommit = true;
    await expect(prepare()).rejects.toThrow('response lost');
    expect(backend.commits).toBe(1); backend.uploads.clear(); backend.reads.clear();
    const result = await prepare();
    expect(result.proofs[0].attachments).toHaveLength(1); expect(backend.commits).toBe(1); expect(backend.files.size).toBe(2);
  });

  it('reuses exact existing content but never overwrites different same-name content', async () => {
    const { backend, prepare } = setup(); backend.put(id(1), 'a'); backend.put(id(2), 'existing', Uint8Array.of(1, 2, 3), 'a.bin');
    expect((await prepare()).proofs[0].attachments[0].targetAttachmentId).toBe('existing'); expect(backend.commits).toBe(0);
    backend.put(id(2), 'existing', Uint8Array.of(1, 2, 4), 'a.bin');
    await expect(prepare()).rejects.toThrow('同名附件'); expect(backend.commits).toBe(0);
    expect(backend.snapshot(id(2), 'existing').bytes).toEqual(Uint8Array.of(1, 2, 4));
  });

  it('rejects a source attachment added during copying and preserves all originals', async () => {
    const { backend, prepare } = setup(); backend.put(id(1), 'a'); backend.afterCommit = () => backend.put(id(1), 'late');
    await expect(prepare()).rejects.toThrow('附件已变化'); expect(backend.snapshot(id(1), 'a')).toBeDefined(); expect(backend.snapshot(id(1), 'late')).toBeDefined();
  });

  it.each(['source', 'target'] as const)('rejects same-size %s replacement even when metadata and timestamps do not change', async side => {
    const { backend, operation, prepare } = setup(); backend.put(id(1), 'a');
    const result = await prepare(), proof = result.proofs[0].attachments[0];
    const itemId = side === 'source' ? id(1) : id(2), attachmentId = side === 'source' ? 'a' : proof.targetAttachmentId;
    backend.put(itemId, attachmentId, Uint8Array.of(1, 2, 4), 'a.bin');
    await expect(verifyPasswordProjectRemovalAttachments(operation, result.proofs, backend)).rejects.toThrow('附件已变化');
    expect(backend.snapshot(id(1), 'a')).toBeDefined();
  });

  it('does not mistake unchecked or missing sources for an empty attachment proof', async () => {
    const { backend, operation, prepare } = setup(); const list = vi.spyOn(backend, 'listAttachments');
    expect((await prepare()).proofs[0].attachments).toEqual([]); expect(list).toHaveBeenCalledWith('provider', id(1), undefined);
    backend.put(id(1), 'a');
    await expect(verifyPasswordProjectRemovalAttachments(operation, [{ providerId: 'provider', sourceItemId: id(1), targetItemId: id(2), attachments: [] }], backend)).rejects.toThrow('附件已变化');
    list.mockRejectedValue(new Error('locked'));
    await expect(prepare()).rejects.toThrow('locked');
  });

  it('checks readiness before uploads and again after a concurrent project edit', async () => {
    const { backend, vault, prepare } = setup(); backend.put(id(1), 'a');
    vault.inspectPasswordProjectRemoval.mockRejectedValueOnce(new Error('pending writes'));
    await expect(prepare()).rejects.toThrow('pending writes'); expect(backend.commits).toBe(0);
    backend.afterCommit = () => { vault.inspectPasswordProjectRemoval.mockRejectedValue(new Error('concurrent edit')); };
    await expect(prepare()).rejects.toThrow('concurrent edit'); expect(backend.snapshot(id(1), 'a')).toBeDefined();
  });

  it.each(['repeating-cursor', 'duplicate-id', 'oversized-file'] as const)('rejects malformed %s lists before uploading', async scenario => {
    const { backend, prepare } = setup(); backend.put(id(1), 'a'); const summary = backend.snapshot(id(1), 'a').summary;
    vi.spyOn(backend, 'listAttachments').mockResolvedValue(scenario === 'repeating-cursor' ? { items: [], nextCursor: 'repeat' }
      : { items: scenario === 'duplicate-id' ? [summary, summary] : [{ ...summary, sizeBytes: 64 * 1024 * 1024 + 1 }], nextCursor: undefined });
    await expect(prepare()).rejects.toThrow('附件已变化'); expect(backend.commits).toBe(0);
  });
});
