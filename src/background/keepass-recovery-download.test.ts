import { expect, it, vi } from 'vitest';
import { base64ToBytes } from '../security/encoding';
import { KeePassRecoveryDownloads, RECOVERY_DOWNLOAD_CHUNK_BYTES } from './keepass-recovery-download';

it('transfers bounded exact chunks with repeatable reads and wipes temporary data on release', async () => {
  const downloads = new KeePassRecoveryDownloads(async () => 'session-source');
  const bytes = Uint8Array.from({ length: RECOVERY_DOWNLOAD_CHUNK_BYTES + 17 }, (_, i) => i % 251), original = bytes.slice();
  const descriptor = await downloads.begin('kp', 'page', async () => bytes);
  try {
    expect(descriptor.sha256).toBe([...new Uint8Array(await crypto.subtle.digest('SHA-256', original))].map(n => n.toString(16).padStart(2, '0')).join(''));
    const first = await downloads.read('kp', 'page', descriptor.downloadHandle, 0);
    expect(first.nextOffset).toBe(RECOVERY_DOWNLOAD_CHUNK_BYTES); expect(first.eof).toBe(false);
    expect(await downloads.read('kp', 'page', descriptor.downloadHandle, 0)).toEqual(first);
    const last = await downloads.read('kp', 'page', descriptor.downloadHandle, first.nextOffset);
    expect(last.eof).toBe(true);
    expect(new Uint8Array([...base64ToBytes(first.dataBase64), ...base64ToBytes(last.dataBase64)])).toEqual(original);
    await expect(downloads.read('kp', 'another-page', descriptor.downloadHandle, 0)).rejects.toThrow('当前页面');
    await expect(downloads.read('another-source', 'page', descriptor.downloadHandle, 0)).rejects.toThrow('当前页面');
    expect(bytes).toEqual(original);
    downloads.release('kp', 'page', descriptor.downloadHandle); expect(bytes.every(n => n === 0)).toBe(true);
    expect(downloads.release('kp', 'page', descriptor.downloadHandle)).toBe(false);
  } finally { downloads.clear(); }
});

it.each(['lock', 'expiry', 'source'] as const)('rejects %s changes and clears the buffer', async mode => {
  let binding = 'session', now = 1;
  const downloads = new KeePassRecoveryDownloads(async () => binding, () => now), bytes = Uint8Array.of(1, 2, 3);
  const descriptor = await downloads.begin('kp', 'page', async () => bytes);
  if (mode === 'lock') downloads.clear();
  if (mode === 'expiry') now = descriptor.expiresAt;
  if (mode === 'source') binding = 'replaced';
  await expect(downloads.read('kp', 'page', descriptor.downloadHandle, 0)).rejects.toThrow();
  expect(bytes).toEqual(new Uint8Array(3)); downloads.clear();
});

it('rejects a late encoder result after clear and reserves capacity while encoding', async () => {
  const downloads = new KeePassRecoveryDownloads(async () => 'session');
  let resolve!: (bytes: Uint8Array) => void;
  const started = downloads.begin('kp', 'page', () => new Promise<Uint8Array>(done => { resolve = done; }));
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  await expect(downloads.begin('kp', 'other', async () => Uint8Array.of(7))).rejects.toThrow('完成或取消');
  downloads.clear(); const bytes = Uint8Array.of(1, 2); resolve(bytes);
  await expect(started).rejects.toThrow(); expect(bytes).toEqual(new Uint8Array(2));
});

it('does not revive a download cleared during the final authorization check', async () => {
  let calls = 0;
  const bytes = Uint8Array.of(1, 2);
  const downloads = new KeePassRecoveryDownloads(async () => { if (++calls === 2) downloads.clear(); return 'session'; });
  await expect(downloads.begin('kp', 'page', async () => bytes)).rejects.toThrow();
  expect(bytes).toEqual(new Uint8Array(2));
});

it('recovers a lost begin response by request identity without regenerating the file', async () => {
  const downloads = new KeePassRecoveryDownloads(async () => 'session'), create = vi.fn(async () => Uint8Array.of(3, 4));
  try {
    const descriptor = await downloads.begin('kp', 'page', create, 'request-1');
    expect(await downloads.status('kp', 'page', 'request-1')).toEqual({ state: 'ready', descriptor });
    expect(await downloads.status('kp', 'other', 'request-1')).toEqual({ state: 'absent' });
    downloads.cancel('kp', 'other', 'request-1');
    expect(await downloads.status('kp', 'page', 'request-1')).toEqual({ state: 'ready', descriptor });
    downloads.cancel('kp', 'page', 'request-1');
    expect(await downloads.status('kp', 'page', 'request-1')).toEqual({ state: 'cancelled' });
    await expect(downloads.begin('kp', 'page', create, 'request-1')).rejects.toThrow('已取消');
    expect(create).toHaveBeenCalledOnce();
  } finally { downloads.clear(); }
});

it('cancels before or during generation without allowing delayed output or a replay to recreate it', async () => {
  const downloads = new KeePassRecoveryDownloads(async () => 'session');
  downloads.cancel('kp', 'page', 'before');
  const create = vi.fn(async () => Uint8Array.of(1));
  await expect(downloads.begin('kp', 'page', create, 'before')).rejects.toThrow('已取消'); expect(create).not.toHaveBeenCalled();
  let finish!: (bytes: Uint8Array) => void;
  const starting = downloads.begin('kp', 'page', () => new Promise<Uint8Array>(resolve => { finish = resolve; }), 'during');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  expect(await downloads.status('kp', 'page', 'during')).toEqual({ state: 'pending' });
  downloads.cancel('kp', 'page', 'during');
  const bytes = Uint8Array.of(8); finish(bytes);
  await expect(starting).rejects.toThrow(); expect(bytes[0]).toBe(0);
  expect(await downloads.status('kp', 'page', 'during')).toEqual({ state: 'cancelled' });
});
