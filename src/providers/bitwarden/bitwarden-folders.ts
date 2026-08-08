import { decryptBitwardenString, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { BitwardenClient, type BitwardenFolderRequest, type BitwardenSessionConfig } from "./bitwarden-client";
import { mergeBitwardenCipherProjection, routeBitwardenCipherToFolder } from "./bitwarden-cipher-codec";

export interface BitwardenFolderSummary {
  folderId: string;
  name: string;
  revision: string;
  cipherCount: number;
  readable: boolean;
}

export interface BitwardenFolderPage {
  items: BitwardenFolderSummary[];
  nextCursor?: string;
  total: number;
}

export interface BitwardenFolderMutationResult {
  changed: boolean;
  folder?: BitwardenFolderSummary;
  previousFolderId?: string;
  targetFolderId?: string;
  rawCipher?: Record<string, unknown>;
  movedCipherCount?: number;
  alreadyAbsent?: boolean;
}

export class BitwardenFolderError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BitwardenFolderError";
  }
}

const MAX_FOLDER_NAME_LENGTH = 256;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;

export class BitwardenFolderService {
  constructor(private readonly client: BitwardenClient) {}

  async list(
    session: BitwardenSessionConfig,
    input: { pageSize?: number; cursor?: string } = {},
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; page: BitwardenFolderPage }> {
    const synced = await this.client.sync(session, signal);
    const key = this.client.vaultKey(synced.session);
    try {
      const folders = await this.decodeFolders(synced.payload, key);
      const ciphers = recordArray(synced.payload, "Ciphers", "ciphers");
      const counts = new Map<string, number>();
      for (const cipher of ciphers) {
        if (stringValue(cipher, "DeletedDate", "deletedDate")) continue;
        const folderId = stringValue(cipher, "FolderId", "folderId");
        if (folderId) counts.set(folderId, (counts.get(folderId) || 0) + 1);
      }
      const items = folders.map((folder) => ({ ...folder, cipherCount: counts.get(folder.folderId) || 0 }));
      return { session: synced.session, page: paginate(items, input) };
    } finally {
      clearSymmetricKey(key);
    }
  }

  async create(
    session: BitwardenSessionConfig,
    name: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; result: BitwardenFolderMutationResult }> {
    const trimmed = validateFolderName(name);
    const synced = await this.client.sync(session, signal);
    const key = this.client.vaultKey(synced.session);
    try {
      const payload: BitwardenFolderRequest = { name: await encryptBitwardenString(trimmed, key) };
      const created = await this.client.createFolder(synced.session, payload, signal);
      const raw = unwrapFolderRecord(created.payload);
      const folder = await this.decodeFolder(raw, key, 0);
      if (!folder) throw new BitwardenFolderError("folder-response-invalid", "Bitwarden 创建文件夹响应缺少有效 ID 或名称。");
      return { session: created.session, result: { changed: true, folder } };
    } finally {
      clearSymmetricKey(key);
    }
  }

  async rename(
    session: BitwardenSessionConfig,
    folderId: string,
    name: string,
    expectedRevision?: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; result: BitwardenFolderMutationResult }> {
    assertFolderId(folderId);
    const trimmed = validateFolderName(name);
    const synced = await this.client.sync(session, signal);
    const key = this.client.vaultKey(synced.session);
    try {
      const current = await this.findFolder(synced.payload, key, folderId);
      assertFolderRevision(current, expectedRevision);
      const updated = await this.client.updateFolder(synced.session, folderId, { name: await encryptBitwardenString(trimmed, key) }, signal);
      const raw = unwrapFolderRecord(updated.payload);
      const folder = await this.decodeFolder(raw, key, current?.cipherCount || 0);
      if (!folder) throw new BitwardenFolderError("folder-response-invalid", "Bitwarden 重命名响应缺少有效文件夹信息。");
      return { session: updated.session, result: { changed: folder.name !== current?.name || folder.revision !== current?.revision, folder } };
    } finally {
      clearSymmetricKey(key);
    }
  }

  async remove(
    session: BitwardenSessionConfig,
    folderId: string,
    expectedRevision?: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; result: BitwardenFolderMutationResult }> {
    assertFolderId(folderId);
    const synced = await this.client.sync(session, signal);
    const key = this.client.vaultKey(synced.session);
    let current: BitwardenFolderSummary | undefined;
    try {
      current = await this.findFolder(synced.payload, key, folderId);
      assertFolderRevision(current, expectedRevision);
    } finally {
      clearSymmetricKey(key);
    }
    if (!current && expectedRevision) throw new BitwardenFolderError("folder-conflict", "文件夹已在其他设备删除，请刷新列表。");
    const deleted = await this.client.deleteFolder(synced.session, folderId, signal);
    return { session: deleted.session, result: { changed: !deleted.alreadyAbsent, alreadyAbsent: deleted.alreadyAbsent, targetFolderId: folderId } };
  }

  async moveCipher(
    session: BitwardenSessionConfig,
    cipherId: string,
    targetFolderId: string | undefined,
    expectedCipherRevision?: string,
    expectedTargetFolderRevision?: string,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; result: BitwardenFolderMutationResult }> {
    assertCipherId(cipherId);
    const synced = await this.client.sync(session, signal);
    const key = this.client.vaultKey(synced.session);
    try {
      const ciphers = recordArray(synced.payload, "Ciphers", "ciphers");
      const raw = ciphers.find((candidate) => stringValue(candidate, "Id", "id") === cipherId);
      if (!raw) throw new BitwardenFolderError("cipher-not-found", "Bitwarden 项目不存在或已被删除，请先同步密码源。");
      if (stringValue(raw, "DeletedDate", "deletedDate")) throw new BitwardenFolderError("cipher-deleted", "回收站项目不能移动文件夹。");
      if (stringValue(raw, "OrganizationId", "organizationId")) throw new BitwardenFolderError("folder-organization-cipher", "组织项目不能使用个人文件夹，请在 Collection 中管理。");
      const currentRevision = stringValue(raw, "RevisionDate", "revisionDate");
      if (expectedCipherRevision && expectedCipherRevision !== currentRevision) throw new BitwardenFolderError("cipher-conflict", "项目已在其他设备修改，请刷新后再移动。");
      const normalizedTarget = targetFolderId?.trim() || undefined;
      let target: BitwardenFolderSummary | undefined;
      if (normalizedTarget) {
        target = await this.findFolder(synced.payload, key, normalizedTarget);
        if (!target) throw new BitwardenFolderError("folder-not-found", "目标文件夹不存在或已被删除，请刷新列表。");
        if (!target.readable) throw new BitwardenFolderError("folder-unreadable", "目标文件夹名称无法解密，已停止移动以避免错误路由。");
        assertFolderRevision(target, expectedTargetFolderRevision);
      }
      const previousFolderId = stringValue(raw, "FolderId", "folderId") || undefined;
      if (previousFolderId === normalizedTarget) {
        return { session: synced.session, result: { changed: false, previousFolderId, targetFolderId: normalizedTarget, rawCipher: raw } };
      }
      const updated = await this.client.updateCipher(synced.session, cipherId, routeBitwardenCipherToFolder(raw, normalizedTarget), signal);
      const responseRaw = unwrapCipherRecord(updated.payload);
      const responseRevision = stringValue(responseRaw, "RevisionDate", "revisionDate");
      if (stringValue(responseRaw, "Id", "id") !== cipherId || !responseRevision || !Number.isFinite(Date.parse(responseRevision))) {
        throw new BitwardenFolderError("cipher-response-invalid", "Bitwarden 移动项目响应缺少可验证修订信息，已停止更新本地状态。");
      }
      const updatedRaw = mergeBitwardenCipherProjection(raw, responseRaw, { folderId: normalizedTarget });
      return {
        session: updated.session,
        result: { changed: true, previousFolderId, targetFolderId: normalizedTarget, rawCipher: updatedRaw, movedCipherCount: 1 }
      };
    } finally {
      clearSymmetricKey(key);
    }
  }

  private async decodeFolders(payload: Record<string, unknown>, key: BitwardenSymmetricKey): Promise<BitwardenFolderSummary[]> {
    const rawFolders = recordArray(payload, "Folders", "folders", "Data", "data");
    const decoded = await Promise.all(rawFolders.map((raw, index) => this.decodeFolder(raw, key, index)));
    return decoded.filter((folder): folder is BitwardenFolderSummary => Boolean(folder));
  }

  private async findFolder(payload: Record<string, unknown>, key: BitwardenSymmetricKey, folderId: string): Promise<BitwardenFolderSummary | undefined> {
    const rawFolders = recordArray(payload, "Folders", "folders", "Data", "data");
    const raw = rawFolders.find((candidate) => stringValue(candidate, "Id", "id") === folderId);
    if (!raw) return undefined;
    return this.decodeFolder(raw, key, 0);
  }

  private async decodeFolder(raw: Record<string, unknown>, key: BitwardenSymmetricKey, cipherCount: number): Promise<BitwardenFolderSummary | undefined> {
    const folderId = stringValue(raw, "Id", "id");
    if (!folderId) return undefined;
    const revision = stringValue(raw, "RevisionDate", "revisionDate");
    const encryptedName = stringValue(raw, "Name", "name");
    if (!encryptedName) return { folderId, name: "（无名称）", revision, cipherCount, readable: false };
    try {
      const name = await decryptBitwardenString(encryptedName, key);
      return { folderId, name: name || "（空名称）", revision, cipherCount, readable: true };
    } catch {
      return { folderId, name: "（无法解密）", revision, cipherCount, readable: false };
    }
  }
}

function validateFolderName(value: string): string {
  const name = String(value || "").trim();
  if (!name) throw new BitwardenFolderError("folder-name-required", "文件夹名称不能为空。");
  if (name.length > MAX_FOLDER_NAME_LENGTH) throw new BitwardenFolderError("folder-name-too-long", `文件夹名称不能超过 ${MAX_FOLDER_NAME_LENGTH} 个字符。`);
  return name;
}

function assertFolderId(value: string): void {
  if (!String(value || "").trim() || value.length > 512) throw new BitwardenFolderError("folder-id-invalid", "文件夹标识无效。");
}

function assertCipherId(value: string): void {
  if (!String(value || "").trim() || value.length > 512) throw new BitwardenFolderError("cipher-id-invalid", "Cipher 标识无效。");
}

function assertFolderRevision(current: BitwardenFolderSummary | undefined, expected?: string): void {
  if (!current) {
    if (expected) throw new BitwardenFolderError("folder-conflict", "文件夹已在其他设备删除，请刷新列表。");
    return;
  }
  if (expected && expected !== current.revision) throw new BitwardenFolderError("folder-conflict", "文件夹已在其他设备修改，请刷新列表。");
}

function paginate(items: BitwardenFolderSummary[], input: { pageSize?: number; cursor?: string }): BitwardenFolderPage {
  const pageSize = clampPageSize(input.pageSize);
  const start = parseCursor(input.cursor);
  const page = items.slice(start, start + pageSize);
  return { items: page, total: items.length, ...(start + page.length < items.length ? { nextCursor: String(start + page.length) } : {}) };
}

function clampPageSize(value?: number): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) throw new BitwardenFolderError("folder-page-invalid", "文件夹分页大小无效。");
  return value;
}

function parseCursor(value?: string): number {
  if (value === undefined || value === "") return 0;
  if (!/^\d{1,9}$/.test(value)) throw new BitwardenFolderError("folder-cursor-invalid", "文件夹分页游标无效。");
  return Number(value);
}

function recordArray(payload: Record<string, unknown>, ...names: string[]): Record<string, unknown>[] {
  for (const name of names) {
    const value = payload[name];
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) {
      for (const nestedName of ["Data", "data", "Folders", "folders"]) {
        if (Array.isArray(value[nestedName])) return (value[nestedName] as unknown[]).filter(isRecord);
      }
    }
  }
  return [];
}

function unwrapFolderRecord(payload: Record<string, unknown>): Record<string, unknown> {
  if (stringValue(payload, "Id", "id")) return payload;
  for (const name of ["Data", "data", "Folder", "folder"]) if (isRecord(payload[name])) return payload[name] as Record<string, unknown>;
  return payload;
}

function unwrapCipherRecord(payload: Record<string, unknown>): Record<string, unknown> {
  if (stringValue(payload, "Id", "id")) return payload;
  for (const name of ["Cipher", "cipher", "Data", "data"]) if (isRecord(payload[name])) return payload[name] as Record<string, unknown>;
  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(raw: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) if (typeof raw[name] === "string") return raw[name] as string;
  return "";
}

function clearSymmetricKey(key: BitwardenSymmetricKey): void {
  key.encKey.fill(0);
  key.macKey.fill(0);
}
