import type { RecoveryDownloadChunk, RecoveryDownloadDescriptor } from '../background/keepass-recovery-download';
import { base64ToBytes } from '../security/encoding';

const MAX_BYTES = 528 * 1024 * 1024, MAX_CHUNK = 256 * 1024;
export interface RecoveryDownloadReader {
  read(handle: string, offset: number): Promise<RecoveryDownloadChunk>;
  release(handle: string): Promise<unknown>;
}

/** Returns only a complete authenticated transport. Caller owns and wipes the
 * returned encrypted bytes after saving; failure wipes the partial assembly. */
export async function assembleKeePassRecoveryDownload(
  descriptor: RecoveryDownloadDescriptor, reader: RecoveryDownloadReader,
  signal?: AbortSignal, progress?: (received: number, total: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  let complete = false;
  const check = () => {
    signal?.throwIfAborted();
    if (Date.now() >= descriptor.expiresAt) throw new Error('恢复副本下载已过期，请重新导出。');
  };
  try {
    if (!descriptor.downloadHandle || !Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes <= 0
      || descriptor.sizeBytes > MAX_BYTES || !Number.isSafeInteger(descriptor.maxChunkBytes)
      || descriptor.maxChunkBytes <= 0 || descriptor.maxChunkBytes > MAX_CHUNK
      || !Number.isFinite(descriptor.expiresAt) || !/^[a-f0-9]{64}$/.test(descriptor.sha256))
      throw new Error('恢复副本下载信息无效。');
    check();
    bytes = new Uint8Array(descriptor.sizeBytes);
    for (let offset = 0; offset < bytes.length;) {
      check();
      const chunk = await reader.read(descriptor.downloadHandle, offset);
      check();
      if (chunk.downloadHandle !== descriptor.downloadHandle || chunk.offset !== offset
        || !Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset <= offset || chunk.nextOffset > bytes.length
        || chunk.nextOffset - offset > descriptor.maxChunkBytes || chunk.eof !== (chunk.nextOffset === bytes.length)
        || typeof chunk.dataBase64 !== 'string' || chunk.dataBase64.length > Math.ceil(descriptor.maxChunkBytes / 3) * 4
        || chunk.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.dataBase64))
        throw new Error('恢复副本下载分块无效。');
      const decoded = base64ToBytes(chunk.dataBase64);
      try {
        if (decoded.length !== chunk.nextOffset - offset) throw new Error('恢复副本下载分块长度不一致。');
        bytes.set(decoded, offset);
      } finally { decoded.fill(0); }
      offset = chunk.nextOffset;
      progress?.(offset, bytes.length);
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    check();
    if ([...digest].map(value => value.toString(16).padStart(2, '0')).join('') !== descriptor.sha256)
      throw new Error('恢复副本下载校验失败。');
    complete = true;
    return bytes;
  } finally {
    if (!complete) bytes?.fill(0);
    // A lost release response cannot invalidate already verified bytes. The
    // backend also wipes on expiry/lock; UI cancellation uses the request ID.
    try { await reader.release(descriptor.downloadHandle); } catch { /* bounded backend expiry */ }
    if (complete && signal?.aborted) { bytes?.fill(0); signal.throwIfAborted(); }
  }
}
