import { expect, it, vi } from 'vitest';
import { KeePassRecoveryDownloads, RECOVERY_DOWNLOAD_CHUNK_BYTES } from '../background/keepass-recovery-download';
import { assembleKeePassRecoveryDownload } from './keepass-recovery-download';

async function fixture() {
  const backend = new KeePassRecoveryDownloads(async () => 'source');
  const original = Uint8Array.from({ length: RECOVERY_DOWNLOAD_CHUNK_BYTES + 7 }, (_, i) => i % 251);
  const descriptor = await backend.begin('kp', 'page', async () => original.slice());
  const reader = {
    read: vi.fn((handle: string, offset: number) => backend.read('kp', 'page', handle, offset)),
    release: vi.fn(async (handle: string) => backend.release('kp', 'page', handle)),
  };
  return { backend, original, descriptor, reader };
}
it('assembles real bounded backend chunks and releases the backend buffer', async () => {
  const { original, descriptor, reader } = await fixture();
  const progress = vi.fn();
  expect(await assembleKeePassRecoveryDownload(descriptor, reader, undefined, progress)).toEqual(original);
  expect(reader.read).toHaveBeenCalledTimes(2);
  expect(progress).toHaveBeenLastCalledWith(original.length, original.length);
  expect(reader.release).toHaveBeenCalledOnce();
  await expect(reader.read(descriptor.downloadHandle, 0)).rejects.toThrow();
});
it.each(['offset', 'nextOffset', 'eof', 'downloadHandle', 'dataBase64', 'sha256', 'sizeBytes'] as const)(
  'rejects corrupted %s and releases the session', async field => {
    const { descriptor, reader } = await fixture();
    if (field === 'sha256') descriptor.sha256 = '0'.repeat(64);
    else if (field === 'sizeBytes') descriptor.sizeBytes = Number.MAX_SAFE_INTEGER;
    else {
      const read = reader.read.getMockImplementation()!;
      reader.read.mockImplementation(async (handle, offset) => ({ ...await read(handle, offset),
        [field]: { offset: 1, nextOffset: 0, eof: true, downloadHandle: 'wrong', dataBase64: 'AAAA' }[field] }));
    }
    await expect(assembleKeePassRecoveryDownload(descriptor, reader)).rejects.toThrow();
    expect(reader.release).toHaveBeenCalledOnce();
  });
it('cancels after a read without issuing a second read', async () => {
  const { descriptor, reader } = await fixture(), controller = new AbortController();
  const read = reader.read.getMockImplementation()!;
  reader.read.mockImplementation(async (handle, offset) => { const chunk = await read(handle, offset); controller.abort(); return chunk; });
  await expect(assembleKeePassRecoveryDownload(descriptor, reader, controller.signal)).rejects.toThrow();
  expect(reader.read).toHaveBeenCalledOnce(); expect(reader.release).toHaveBeenCalledOnce();
});
it('retains independently verified bytes if the release response is lost', async () => {
  const { descriptor, reader, original } = await fixture(), release = reader.release.getMockImplementation()!;
  reader.release.mockImplementation(async handle => { await release(handle); throw new Error('response lost'); });
  expect(await assembleKeePassRecoveryDownload(descriptor, reader)).toEqual(original);
});
it('honors cancellation while awaiting final release', async () => {
  const { descriptor, reader } = await fixture(), controller = new AbortController();
  const release = reader.release.getMockImplementation()!;
  reader.release.mockImplementation(async handle => { const result = await release(handle); controller.abort(); return result; });
  await expect(assembleKeePassRecoveryDownload(descriptor, reader, controller.signal)).rejects.toThrow();
});
