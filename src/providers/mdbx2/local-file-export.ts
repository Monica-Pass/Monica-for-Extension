import { base64ToBytes } from "../../security/encoding";
import { MDBX2_MAX_BINARY_CHUNK_BYTES, type Mdbx2CompleteBackupDescriptor, type Mdbx2CompleteBackupChunk } from "./native-contract";

export const MDBX2_FILE_EXPORT_MAX_BYTES = 512 * 1024 * 1024;
export const MDBX2_FILE_EXPORT_TTL_MS = 5 * 60_000;
export interface Mdbx2FileExportBegin {
  downloadHandle: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  maxChunkBytes: number;
  expiresAt: number;
  format: "mdbx" | "zip";
  blobCount: number;
}
export interface Mdbx2FileExportChunk {
  downloadHandle: string;
  sizeBytes: number;
  sha256: string;
  offset: number;
  nextOffset: number;
  eof: boolean;
  dataBase64: string;
}
interface ExportNative {
  prepareCompleteBackup(vaultHandle: string): Promise<Mdbx2CompleteBackupDescriptor>;
  readCompleteBackup(vaultHandle: string, fileHandle: string, offset: number, maxBytes: number): Promise<Mdbx2CompleteBackupChunk>;
  releaseCompleteBackup(fileHandle: string): Promise<boolean>;
}
interface Session extends Mdbx2FileExportBegin {
  providerId: string;
  owner: string;
  vaultHandle: string;
  fileHandle: string;
  epoch: number;
}

/** Complete encrypted snapshot. Never repurpose a configured WebDAV sync state. */
export class Mdbx2LocalFileExports {
  private readonly sessions = new Map<string, Session>();
  private epoch = 0;
  private pending = 0;
  constructor(private readonly native: ExportNative, private readonly authorize: (providerId: string) => Promise<{ vaultHandle: string; fileName: string }>, private readonly now = () => Date.now()) {}

  async begin(providerId: string, owner: string): Promise<Mdbx2FileExportBegin> {
    await this.prune();
    if (this.sessions.size + this.pending >= 4) throw new Error("导出会话过多，请先关闭已有下载。");
    this.pending++;
    let fileHandle: string | undefined;
    const epoch = this.epoch;
    const expiresAt = this.now() + MDBX2_FILE_EXPORT_TTL_MS;
    try {
      const account = await this.authorize(providerId);
      const check = () => this.check(providerId, account.vaultHandle, epoch, expiresAt);
      await check();
      const prepared = await this.native.prepareCompleteBackup(account.vaultHandle);
      fileHandle = prepared.fileHandle; await check();
      const { sizeBytes, sha256, format, blobCount } = prepared;
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MDBX2_FILE_EXPORT_MAX_BYTES) throw new Error("本地 MDBX 导出上限为 512 MiB。");
      if (prepared.purpose !== "vault-backup" || !/^[a-f0-9]{64}$/.test(sha256) ||
        !Number.isSafeInteger(blobCount) || blobCount < 0 || (format !== "mdbx" && format !== "zip") ||
        (format === "mdbx") !== (blobCount === 0)) throw new Error("MDBX 导出描述校验失败。");
      const fileName = format === "zip" ? account.fileName.replace(/\.mdbx$/i, "") + ".mdbx-backup.zip" : account.fileName;
      const result: Mdbx2FileExportBegin = { downloadHandle: crypto.randomUUID(), fileName, sizeBytes, sha256, format, blobCount, maxChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES, expiresAt };
      this.sessions.set(result.downloadHandle, { ...result, providerId, owner, vaultHandle: account.vaultHandle, fileHandle, epoch });
      fileHandle = undefined;
      return result;
    } finally {
      this.pending--;
      if (fileHandle) await this.native.releaseCompleteBackup(fileHandle).catch(() => undefined);
    }
  }

  async read(providerId: string, owner: string, downloadHandle: string, offset: number): Promise<Mdbx2FileExportChunk> {
    const session = this.session(providerId, owner, downloadHandle);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= session.sizeBytes) throw new Error("MDBX 导出偏移无效。");
    try {
      await this.check(providerId, session.vaultHandle, session.epoch, session.expiresAt);
      const chunk = await this.native.readCompleteBackup(session.vaultHandle, session.fileHandle, offset, MDBX2_MAX_BINARY_CHUNK_BYTES);
      await this.check(providerId, session.vaultHandle, session.epoch, session.expiresAt);
      if (this.sessions.get(downloadHandle) !== session) throw new Error("MDBX 导出会话已过期。");
      const bytes = base64ToBytes(chunk.dataBase64);
      const length = bytes.length; bytes.fill(0);
      if (chunk.fileHandle !== session.fileHandle || chunk.purpose !== "vault-backup" || chunk.format !== session.format || chunk.blobCount !== session.blobCount || chunk.sizeBytes !== session.sizeBytes || chunk.sha256 !== session.sha256 || chunk.offset !== offset || length < 1 || length > MDBX2_MAX_BINARY_CHUNK_BYTES || chunk.nextOffset !== offset + length || chunk.nextOffset > session.sizeBytes || chunk.eof !== (chunk.nextOffset === session.sizeBytes)) throw new Error("MDBX 导出分段校验失败。");
      return { downloadHandle, sizeBytes: chunk.sizeBytes, sha256: chunk.sha256, offset, nextOffset: chunk.nextOffset, eof: chunk.eof, dataBase64: chunk.dataBase64 };
    } catch (error) {
      await this.release(providerId, owner, downloadHandle);
      throw error;
    }
  }

  async release(providerId: string, owner: string, downloadHandle: string): Promise<boolean> {
    const session = this.sessions.get(downloadHandle);
    if (!session) return false;
    this.session(providerId, owner, downloadHandle);
    this.sessions.delete(downloadHandle);
    await this.native.releaseCompleteBackup(session.fileHandle).catch(() => undefined);
    return true;
  }

  async clear(): Promise<void> {
    this.epoch++;
    const sessions = [...this.sessions.values()]; this.sessions.clear();
    await Promise.all(sessions.map(session => this.native.releaseCompleteBackup(session.fileHandle).catch(() => undefined)));
  }

  private session(providerId: string, owner: string, handle: string): Session {
    const session = this.sessions.get(handle);
    if (!session) throw new Error("MDBX 导出会话已过期或后台已重启，请重新导出。");
    if (session.providerId !== providerId || session.owner !== owner) throw new Error("MDBX 导出会话不属于当前页面或密码源。");
    return session;
  }
  private async check(providerId: string, vaultHandle: string, epoch: number, expiresAt: number): Promise<void> {
    const current = await this.authorize(providerId);
    if (epoch !== this.epoch || current.vaultHandle !== vaultHandle) throw new Error("密码库已锁定或连接已变化，请重新导出。");
    if (expiresAt <= this.now()) throw new Error("MDBX 导出会话已过期，请重新导出。");
  }
  private async prune(): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(session => session.expiresAt <= this.now()).map(session => this.release(session.providerId, session.owner, session.downloadHandle)));
  }
}
