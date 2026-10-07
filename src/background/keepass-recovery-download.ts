import { bytesToBase64 } from '../security/encoding';

export const RECOVERY_DOWNLOAD_CHUNK_BYTES = 256 * 1024;
export const RECOVERY_DOWNLOAD_MAX_BYTES = 528 * 1024 * 1024;
const TTL = 5 * 60_000;
export interface RecoveryDownloadDescriptor {
  downloadHandle: string; fileName: string; sizeBytes: number; sha256: string; maxChunkBytes: number; expiresAt: number;
}
export interface RecoveryDownloadChunk {
  downloadHandle: string; offset: number; nextOffset: number; eof: boolean; dataBase64: string;
}
interface Session { descriptor: RecoveryDownloadDescriptor; providerId: string; owner: string; binding: string; bytes: Uint8Array; timer: ReturnType<typeof setTimeout> }
export type RecoveryDownloadStatus = { state: 'absent' | 'pending' | 'cancelled' } | { state: 'ready'; descriptor: RecoveryDownloadDescriptor };

/** Owns only an independently encrypted export. Release, expiry and lock wipe
 * that temporary buffer; none of these actions touches stored recovery copies. */
export class KeePassRecoveryDownloads {
  private session?: Session;
  private pending?: { providerId: string; owner: string; requestId: string; epoch: number };
  private requestId?: string;
  private readonly cancelled = new Map<string, number>();
  private epoch = 0;
  constructor(private readonly authorize: (providerId: string) => Promise<string>, private readonly now = () => Date.now()) {}
  async begin(providerId: string, owner: string, create: () => Promise<Uint8Array>, requestId: string = crypto.randomUUID()): Promise<RecoveryDownloadDescriptor> {
    this.validateRequestId(requestId);
    this.pruneCancelled();
    if (this.cancelled.has(this.requestKey(providerId, owner, requestId))) throw new Error('恢复副本导出已取消。');
    if (this.session && this.session.descriptor.expiresAt <= this.now()) this.clear();
    if (this.pending || this.session) throw new Error('请先完成或取消当前恢复副本下载。');
    const epoch = this.epoch, expiresAt = this.now() + TTL;
    this.pending = { providerId, owner, requestId, epoch };
    let bytes: Uint8Array | undefined;
    try {
      const binding = await this.authorize(providerId);
      if (!binding || epoch !== this.epoch) throw new Error('恢复副本导出已取消。');
      bytes = await create();
      if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > RECOVERY_DOWNLOAD_MAX_BYTES) throw new Error('恢复副本导出文件大小无效。');
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const currentBinding = await this.authorize(providerId);
      if (epoch !== this.epoch || expiresAt <= this.now() || binding !== currentBinding) throw new Error('导出期间密码源或解锁会话已变化，请重试。');
      const descriptor: RecoveryDownloadDescriptor = { downloadHandle: crypto.randomUUID(), fileName: 'monica-recovery.kdbx', sizeBytes: bytes.length,
        sha256, maxChunkBytes: RECOVERY_DOWNLOAD_CHUNK_BYTES, expiresAt };
      const timer = setTimeout(() => { if (this.session?.descriptor.downloadHandle === descriptor.downloadHandle) this.clear(); }, Math.max(1, expiresAt - this.now()));
      this.session = { descriptor, providerId, owner, binding, bytes, timer }; bytes = undefined;
      this.requestId = requestId;
      return { ...descriptor };
    } finally { this.pending = undefined; bytes?.fill(0); }
  }
  async status(providerId: string, owner: string, requestId: string): Promise<RecoveryDownloadStatus> {
    this.validateRequestId(requestId); this.pruneCancelled();
    const binding = await this.authorize(providerId);
    if (this.cancelled.has(this.requestKey(providerId, owner, requestId))) return { state: 'cancelled' };
    if (this.pending?.providerId === providerId && this.pending.owner === owner && this.pending.requestId === requestId)
      return { state: this.pending.epoch === this.epoch ? 'pending' : 'cancelled' };
    const session = this.session;
    if (!session || this.requestId !== requestId || session.providerId !== providerId || session.owner !== owner) return { state: 'absent' };
    if (session.binding !== binding || session.descriptor.expiresAt <= this.now()) { this.clear(); return { state: 'absent' }; }
    return { state: 'ready', descriptor: { ...session.descriptor } };
  }
  cancel(providerId: string, owner: string, requestId: string): void {
    this.validateRequestId(requestId); this.pruneCancelled();
    const key = this.requestKey(providerId, owner, requestId);
    if (!this.cancelled.has(key) && this.cancelled.size >= 128) throw new Error('取消请求过多，请稍后重试。');
    this.cancelled.set(key, this.now() + TTL);
    if (this.pending?.providerId === providerId && this.pending.owner === owner && this.pending.requestId === requestId
      || this.session?.providerId === providerId && this.session.owner === owner && this.requestId === requestId) this.clear();
  }
  async read(providerId: string, owner: string, handle: string, offset: number): Promise<RecoveryDownloadChunk> {
    const session = this.owned(providerId, owner, handle);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= session.bytes.length) throw new Error('恢复副本下载偏移无效。');
    try {
      const binding = await this.authorize(providerId);
      if (this.session !== session || session.descriptor.expiresAt <= this.now() || binding !== session.binding) throw new Error('恢复副本下载已过期，请重新导出。');
      const nextOffset = Math.min(offset + RECOVERY_DOWNLOAD_CHUNK_BYTES, session.bytes.length);
      return { downloadHandle: handle, offset, nextOffset, eof: nextOffset === session.bytes.length,
        dataBase64: bytesToBase64(session.bytes.subarray(offset, nextOffset)) };
    } catch (cause) { if (this.session === session) this.clear(); throw cause; }
  }
  release(providerId: string, owner: string, handle: string): boolean {
    if (!this.session) return false;
    this.owned(providerId, owner, handle); this.clear(); return true;
  }
  clear(): void {
    this.epoch++;
    this.requestId = undefined;
    if (this.session) { clearTimeout(this.session.timer); this.session.bytes.fill(0); this.session = undefined; }
  }
  private requestKey(providerId: string, owner: string, requestId: string) { return JSON.stringify([providerId, owner, requestId]); }
  private validateRequestId(value: string) { if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error('恢复副本下载请求无效。'); }
  private pruneCancelled() { for (const [key, expires] of this.cancelled) if (expires <= this.now()) this.cancelled.delete(key); }
  private owned(providerId: string, owner: string, handle: string): Session {
    if (!this.session || this.session.descriptor.downloadHandle !== handle) throw new Error('恢复副本下载已过期或后台已重启，请重新导出。');
    if (this.session.providerId !== providerId || this.session.owner !== owner) throw new Error('恢复副本下载不属于当前页面或密码源。');
    return this.session;
  }
}
