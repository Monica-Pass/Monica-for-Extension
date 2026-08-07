import type { ProviderAccount } from "../../core/model";
import { base64ToBytes, bytesToBase64 } from "../../security/encoding";
import { ProviderTransportError } from "../provider-transport";
import { normalizeServerUrl } from "../webdav/webdav-client";
import {
  KeePassWebDavClient,
  KeePassWebDavError,
  normalizeKeePassRemotePath,
  type KeePassWebDavConfig,
  type KeePassWebDavFileStat,
  type KeePassWebDavSnapshot,
  type KeePassWebDavWriteResult
} from "./keepass-webdav-client";
import { KeePassProvider, type KeePassSessionSummary } from "./keepass-provider";
import { openKeePassVault } from "./keepass-vault";
import { KeePassRemoteRebaseConflictError, rebaseKeePassDatabase, type KeePassRebaseConflict } from "./keepass-remote-rebase";
import {
  KeePassWorkingCopyStoreError,
  type KeePassDurableMutationKind,
  type KeePassDurableMutationReceipt,
  type KeePassRemoteWorkingCopyRecord,
  type KeePassWorkingCopyStorage
} from "./keepass-working-copy-store";
import {
  KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG,
  KeePassReceiptCryptoError,
  createKeePassCacheEncryptionKey,
  hasKeePassCacheEncryptionKey,
  openKeePassDurableReceipt,
  sealKeePassDurableReceipt
} from "./keepass-receipt-crypto";

export const KEEPASS_KEY_FILE_MAX_BYTES = 8 * 1024 * 1024;
const KEEPASS_KEY_FILE_MAX_BASE64_LENGTH = Math.ceil(KEEPASS_KEY_FILE_MAX_BYTES / 3) * 4 + 8;

export interface KeePassWebDavOpenInput {
  baseUrl: string;
  username: string;
  webDavPassword: string;
  remotePath: string;
  databasePassword: string;
  keyFile?: string;
}

export interface KeePassRemoteProbeResult {
  reachable: true;
  file?: KeePassWebDavFileStat;
}

export interface KeePassRemoteSessionResult {
  session: KeePassSessionSummary;
  accountConfig: Record<string, unknown>;
}

export interface KeePassRemotePersistenceResult {
  revision: number;
  workingSha256: string;
  accountConfig: Record<string, unknown>;
}

export type KeePassRemotePublishStatus = "unchanged" | "remote-refreshed" | "uploaded" | "rebased";

export interface KeePassRemotePublishResult extends KeePassRemotePersistenceResult {
  status: KeePassRemotePublishStatus;
}

export type KeePassRemoteSessionErrorCode =
  | "remote-provider-invalid"
  | "remote-working-copy-missing"
  | "remote-credential-missing"
  | "remote-key-file-invalid"
  | "remote-operation-reused"
  | "remote-cache-key-missing"
  | "remote-receipt-invalid"
  | "remote-rebase-conflict";

export class KeePassRemoteSessionError extends Error {
  constructor(readonly code: KeePassRemoteSessionErrorCode, message: string) {
    super(message);
    this.name = "KeePassRemoteSessionError";
  }
}

export class KeePassRemoteRebaseSessionError extends KeePassRemoteSessionError {
  constructor(readonly conflicts: readonly KeePassRebaseConflict[]) {
    super("remote-rebase-conflict", "KeePass 远端文件与本机修改存在字段或结构冲突，请处理后重试。");
    this.name = "KeePassRemoteRebaseSessionError";
  }
}

export interface KeePassRemoteFileClient {
  testConnection(signal?: AbortSignal): Promise<void>;
  stat(signal?: AbortSignal): Promise<KeePassWebDavFileStat | undefined>;
  read(signal?: AbortSignal): Promise<KeePassWebDavSnapshot>;
  write(bytes: Uint8Array, expectedEtag: string | null, signal?: AbortSignal): Promise<KeePassWebDavWriteResult>;
}

export type KeePassRemoteFileClientFactory = (config: KeePassWebDavConfig) => KeePassRemoteFileClient;

export class KeePassRemoteSessionService {
  private readonly persistenceQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly provider: KeePassProvider,
    private readonly storage: KeePassWorkingCopyStorage,
    private readonly clientFactory: KeePassRemoteFileClientFactory = (config) => new KeePassWebDavClient(config)
  ) {}

  async probe(input: Pick<KeePassWebDavOpenInput, "baseUrl" | "username" | "webDavPassword" | "remotePath">, signal?: AbortSignal): Promise<KeePassRemoteProbeResult> {
    const config = normalizeRemoteConfig(input);
    const client = this.clientFactory(config);
    await client.testConnection(signal);
    return { reachable: true, file: await client.stat(signal) };
  }

  async open(account: ProviderAccount, input: KeePassWebDavOpenInput, signal?: AbortSignal): Promise<KeePassRemoteSessionResult> {
    if (account.kind !== "keepass") throw invalidProvider();
    const remote = normalizeRemoteConfig(input);
    const keyFile = decodeKeyFile(input.keyFile);
    let snapshot: KeePassWebDavSnapshot | undefined;
    let existing: Awaited<ReturnType<KeePassWorkingCopyStorage["read"]>>;
    try {
      snapshot = await this.clientFactory(remote).read(signal);
      const session = await this.provider.unlock(account, snapshot.bytes, {
        password: input.databasePassword,
        keyFile,
        sourceName: snapshot.fileName,
        sourceMode: "webdav",
        dirty: false
      });
      existing = await this.storage.read(account.id);
      const record = await this.storage.save({
        providerId: account.id,
        baseBytes: snapshot.bytes,
        workingBytes: snapshot.bytes,
        baseEtag: snapshot.etag,
        baseLastModified: snapshot.lastModified,
        baseSha256: snapshot.sha256,
        workingSha256: snapshot.sha256,
        updatedAt: new Date().toISOString()
      }, existing?.revision || 0);
      const accountConfig = remoteAccountConfig(account, remote, input.databasePassword, keyFile, snapshot, record.revision);
      record.baseBytes.fill(0);
      record.workingBytes.fill(0);
      return {
        session,
        accountConfig
      };
    } catch (cause) {
      this.provider.lockAccount(account.id);
      throw cause;
    } finally {
      keyFile?.fill(0);
      snapshot?.bytes.fill(0);
      existing?.baseBytes.fill(0);
      existing?.workingBytes.fill(0);
    }
  }

  async restore(account: ProviderAccount): Promise<KeePassRemoteSessionResult> {
    if (account.kind !== "keepass" || account.config.sourceMode !== "webdav") throw invalidProvider();
    const record = await this.storage.read(account.id);
    if (!record) {
      throw new KeePassRemoteSessionError("remote-working-copy-missing", "远端 KeePass 本机工作副本不存在，请重新连接 WebDAV 文件。");
    }
    let keyFile: Uint8Array | undefined;
    try {
      const password = stringConfig(account, "databasePassword");
      keyFile = decodeKeyFile(optionalStringConfig(account, "keyFile"));
      if (!("databasePassword" in account.config) && !keyFile) {
        throw new KeePassRemoteSessionError("remote-credential-missing", "远端 KeePass 解锁凭据不存在，请重新连接。");
      }
      const session = await this.provider.unlock(account, record.workingBytes, {
        password,
        keyFile,
        sourceName: stringConfig(account, "fileName") || "remote.kdbx",
        sourceMode: "webdav",
        dirty: record.workingSha256 !== record.baseSha256
      });
      return {
        session,
        accountConfig: await this.accountConfigForRecord(account, record)
      };
    } finally {
      keyFile?.fill(0);
      record.baseBytes.fill(0);
      record.workingBytes.fill(0);
    }
  }

  async readDurableReceipt(
    account: ProviderAccount,
    operationId: string,
    kind: KeePassDurableMutationKind,
    intentSha256: string
  ): Promise<KeePassDurableMutationReceipt | undefined> {
    if (account.kind !== "keepass" || account.config.sourceMode !== "webdav") return undefined;
    const envelope = await this.storage.readReceipt(account.id, operationId);
    if (!envelope) return undefined;
    const receipt = await this.openReceipt(account, envelope);
    if (receipt.kind !== kind || receipt.intentSha256 !== intentSha256) {
      throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 操作标识已经用于其他持久操作。");
    }
    return receipt;
  }

  async readAnyDurableReceipt(account: ProviderAccount, operationId: string): Promise<KeePassDurableMutationReceipt | undefined> {
    if (account.kind !== "keepass" || account.config.sourceMode !== "webdav") return undefined;
    const envelope = await this.storage.readReceipt(account.id, operationId);
    return envelope ? this.openReceipt(account, envelope) : undefined;
  }

  async deleteDurableReceipt(account: ProviderAccount, operationId: string): Promise<void> {
    if (account.kind !== "keepass" || account.config.sourceMode !== "webdav") return;
    await this.storage.deleteReceipt(account.id, operationId);
  }

  async reconcileAccountConfig(account: ProviderAccount): Promise<Record<string, unknown>> {
    if (account.kind !== "keepass" || account.config.sourceMode !== "webdav") throw invalidProvider();
    const record = await this.storage.read(account.id);
    if (!record) throw new KeePassRemoteSessionError("remote-working-copy-missing", "远端 KeePass 本机工作副本不存在，请重新连接 WebDAV 文件。");
    try {
      return await this.accountConfigForRecord(account, record);
    } finally {
      record.baseBytes.fill(0);
      record.workingBytes.fill(0);
    }
  }

  async persistWorkingCopy(
    account: ProviderAccount,
    receipt?: KeePassDurableMutationReceipt
  ): Promise<KeePassRemotePersistenceResult | undefined> {
    if (account.kind !== "keepass" || account.config.sourceMode !== "webdav") return undefined;
    if (receipt && receipt.providerId !== account.id) {
      throw new KeePassRemoteSessionError("remote-provider-invalid", "KeePass 持久操作与密码源不一致。");
    }
    return this.runPersistenceExclusive(account.id, async () => {
      const record = await this.storage.read(account.id);
      if (!record) {
        throw new KeePassRemoteSessionError("remote-working-copy-missing", "远端 KeePass 本机工作副本不存在，请重新连接 WebDAV 文件。");
      }
      let bytes: Uint8Array | undefined;
      try {
        bytes = await this.provider.snapshotFile(account.id);
        const workingSha256 = await sha256Hex(bytes);
        const encryptedReceipt = receipt ? await sealKeePassDurableReceipt(account, receipt) : undefined;
        const saved = await this.storage.save({
          providerId: account.id,
          baseBytes: record.baseBytes,
          workingBytes: bytes,
          baseEtag: record.baseEtag,
          baseLastModified: record.baseLastModified,
          baseSha256: record.baseSha256,
          workingSha256,
          updatedAt: new Date().toISOString()
        }, record.revision, encryptedReceipt);
        const accountConfig = await this.accountConfigForRecord(account, saved);
        const result = {
          revision: saved.revision,
          workingSha256,
          accountConfig
        };
        saved.baseBytes.fill(0);
        saved.workingBytes.fill(0);
        return result;
      } catch (cause) {
        if (cause instanceof KeePassWorkingCopyStoreError && cause.code === "operation-reused") {
          throw new KeePassRemoteSessionError("remote-operation-reused", cause.message);
        }
        if (cause instanceof KeePassReceiptCryptoError) throw this.receiptError(cause);
        throw cause;
      } finally {
        bytes?.fill(0);
        record.baseBytes.fill(0);
        record.workingBytes.fill(0);
      }
    });
  }

  /**
   * Publishes the encrypted working copy with an atomic WebDAV ETag precondition. A changed remote
   * file is rebased from the stored base KDBX; only independent fields/categories are applied. The
   * working copy is replaced with the verified remote bytes before the provider session is reloaded.
   */
  async publishWorkingCopy(account: ProviderAccount, signal?: AbortSignal): Promise<KeePassRemotePublishResult | undefined> {
    if (account.kind !== "keepass" || account.config.sourceMode !== "webdav") return undefined;
    return this.runPersistenceExclusive(account.id, async () => {
      const record = await this.storage.read(account.id);
      if (!record) throw new KeePassRemoteSessionError("remote-working-copy-missing", "远端 KeePass 本机工作副本不存在，请重新连接 WebDAV 文件。");
      let keyFile: Uint8Array | undefined;
      let remoteSnapshot: KeePassWebDavSnapshot | undefined;
      let outputBytes: Uint8Array | undefined;
      let writeResult: KeePassWebDavWriteResult | undefined;
      try {
        keyFile = decodeKeyFile(optionalStringConfig(account, "keyFile"));
        const password = stringConfig(account, "databasePassword");
        const client = this.clientFactory(remoteConfigFromAccount(account));
        const remoteStat = await client.stat(signal);
        if (!remoteStat) throw new KeePassRemoteSessionError("remote-working-copy-missing", "远端 KeePass 文件不存在。");

        if (record.workingSha256 === record.baseSha256) {
          const sameRemote = Boolean(record.baseEtag && remoteStat.etag && record.baseEtag === remoteStat.etag &&
            (record.baseLastModified === undefined || remoteStat.lastModified === undefined || record.baseLastModified === remoteStat.lastModified));
          if (sameRemote) {
            return {
              status: "unchanged",
              revision: record.revision,
              workingSha256: record.workingSha256,
              accountConfig: await this.accountConfigForRecord(account, record)
            };
          }
          remoteSnapshot = await client.read(signal);
          const refreshed = await this.replaceWorkingCopyWithRemote(account, record, remoteSnapshot, password, keyFile);
          return {
            status: "remote-refreshed",
            ...refreshed
          };
        }

        const configuredEtag = typeof account.config.remoteEtag === "string" ? account.config.remoteEtag : undefined;
        const expectedEtag = record.baseEtag || configuredEtag;
        if (!expectedEtag) throw new KeePassWebDavError("remote-etag-required", "KeePass 远端基线缺少 ETag，已拒绝覆盖写入。");
        let status: KeePassRemotePublishStatus = "uploaded";
        try {
          writeResult = await client.write(record.workingBytes, expectedEtag, signal);
        } catch (cause) {
          if (!(cause instanceof ProviderTransportError) || cause.code !== "conflict") throw cause;
          remoteSnapshot = await client.read(signal);
          const baseVault = await openRemoteVault(record.baseBytes, password, keyFile, account);
          const workingVault = await openRemoteVault(record.workingBytes, password, keyFile, account);
          const remoteVault = await openRemoteVault(remoteSnapshot.bytes, password, keyFile, account);
          try {
            rebaseKeePassDatabase(baseVault.database, workingVault.database, remoteVault.database);
          } catch (rebaseCause) {
            if (rebaseCause instanceof KeePassRemoteRebaseConflictError) {
              throw new KeePassRemoteRebaseSessionError(rebaseCause.conflicts);
            }
            throw rebaseCause;
          }
          outputBytes = new Uint8Array(await remoteVault.database.save());
          writeResult = await client.write(outputBytes, remoteSnapshot.etag || expectedEtag, signal);
          status = "rebased";
        }

        const saved = await this.storage.save({
          providerId: account.id,
          baseBytes: writeResult.bytes,
          workingBytes: writeResult.bytes,
          baseEtag: writeResult.etag,
          baseLastModified: writeResult.lastModified,
          baseSha256: writeResult.sha256,
          workingSha256: writeResult.sha256,
          updatedAt: new Date().toISOString()
        }, record.revision);
        await this.unlockWithBytes(account, writeResult.bytes, password, keyFile, false);
        const accountConfig = await this.accountConfigForRecord(account, saved);
        const result = {
          status,
          revision: saved.revision,
          workingSha256: saved.workingSha256,
          accountConfig
        };
        saved.baseBytes.fill(0);
        saved.workingBytes.fill(0);
        return result;
      } finally {
        keyFile?.fill(0);
        remoteSnapshot?.bytes.fill(0);
        outputBytes?.fill(0);
        writeResult?.bytes.fill(0);
        record.baseBytes.fill(0);
        record.workingBytes.fill(0);
      }
    });
  }

  async remove(providerId: string): Promise<void> {
    this.provider.lockAccount(providerId);
    await this.storage.delete(providerId);
  }

  private async runPersistenceExclusive<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.persistenceQueues.get(providerId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.persistenceQueues.set(providerId, queued);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.persistenceQueues.get(providerId) === queued) this.persistenceQueues.delete(providerId);
    }
  }

  private async replaceWorkingCopyWithRemote(
    account: ProviderAccount,
    record: KeePassRemoteWorkingCopyRecord,
    snapshot: KeePassWebDavSnapshot,
    password: string,
    keyFile: Uint8Array | undefined
  ): Promise<KeePassRemotePersistenceResult> {
    const saved = await this.storage.save({
      providerId: account.id,
      baseBytes: snapshot.bytes,
      workingBytes: snapshot.bytes,
      baseEtag: snapshot.etag,
      baseLastModified: snapshot.lastModified,
      baseSha256: snapshot.sha256,
      workingSha256: snapshot.sha256,
      updatedAt: new Date().toISOString()
    }, record.revision);
    await this.unlockWithBytes(account, snapshot.bytes, password, keyFile, false);
    const accountConfig = await this.accountConfigForRecord(account, saved);
    const result = { revision: saved.revision, workingSha256: saved.workingSha256, accountConfig };
    saved.baseBytes.fill(0);
    saved.workingBytes.fill(0);
    return result;
  }

  private async unlockWithBytes(
    account: ProviderAccount,
    bytes: Uint8Array,
    password: string,
    keyFile: Uint8Array | undefined,
    dirty: boolean
  ): Promise<void> {
    await this.provider.unlock(account, bytes, {
      password,
      keyFile,
      sourceName: stringConfig(account, "fileName") || "remote.kdbx",
      sourceMode: "webdav",
      dirty
    });
  }

  private async accountConfigForRecord(account: ProviderAccount, record: { revision: number; baseEtag?: string; baseLastModified?: string; baseSha256: string; workingSha256: string }): Promise<Record<string, unknown>> {
    let cacheEncryptionKey = hasKeePassCacheEncryptionKey(account)
      ? String(account.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG])
      : undefined;
    if (!cacheEncryptionKey) {
      if (await this.storage.hasReceipts(account.id)) {
        throw new KeePassRemoteSessionError("remote-cache-key-missing", "KeePass 本机缓存加密密钥缺失，无法安全读取已有持久操作。");
      }
      cacheEncryptionKey = createKeePassCacheEncryptionKey();
    }
    return {
      ...account.config,
      sourceMode: "webdav",
      [KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]: cacheEncryptionKey,
      workingCopyRevision: record.revision,
      remoteEtag: record.baseEtag,
      remoteLastModified: record.baseLastModified,
      remoteSha256: record.baseSha256,
      workingSha256: record.workingSha256
    };
  }

  private async openReceipt(account: ProviderAccount, envelope: Awaited<ReturnType<KeePassWorkingCopyStorage["readReceipt"]>> & {}): Promise<KeePassDurableMutationReceipt> {
    try {
      return await openKeePassDurableReceipt(account, envelope);
    } catch (cause) {
      if (cause instanceof KeePassReceiptCryptoError) throw this.receiptError(cause);
      throw cause;
    }
  }

  private receiptError(cause: KeePassReceiptCryptoError): KeePassRemoteSessionError {
    return cause.code === "cache-key-missing"
      ? new KeePassRemoteSessionError("remote-cache-key-missing", cause.message)
      : new KeePassRemoteSessionError("remote-receipt-invalid", cause.message);
  }
}

export async function keePassMutationIntentSha256(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(canonicalize(value))));
}

function normalizeRemoteConfig(input: Pick<KeePassWebDavOpenInput, "baseUrl" | "username" | "webDavPassword" | "remotePath">): KeePassWebDavConfig {
  return {
    baseUrl: normalizeServerUrl(input.baseUrl),
    username: input.username.trim(),
    password: input.webDavPassword,
    remotePath: normalizeKeePassRemotePath(input.remotePath)
  };
}

function remoteConfigFromAccount(account: ProviderAccount): KeePassWebDavConfig {
  return normalizeRemoteConfig({
    baseUrl: stringConfig(account, "webDavBaseUrl"),
    username: stringConfig(account, "webDavUsername"),
    webDavPassword: stringConfig(account, "webDavPassword"),
    remotePath: stringConfig(account, "remotePath")
  });
}

async function openRemoteVault(
  bytes: Uint8Array,
  password: string,
  keyFile: Uint8Array | undefined,
  account: ProviderAccount
): Promise<Awaited<ReturnType<typeof openKeePassVault>>> {
  const databaseId = Number(account.config.databaseId);
  return openKeePassVault(bytes, {
    password,
    keyFile,
    sourceName: stringConfig(account, "fileName") || "remote.kdbx",
    databaseId: Number.isSafeInteger(databaseId) && databaseId > 0 ? databaseId : 1,
    providerId: account.id
  });
}

function remoteAccountConfig(
  account: ProviderAccount,
  remote: KeePassWebDavConfig,
  databasePassword: string,
  keyFile: Uint8Array | undefined,
  snapshot: KeePassWebDavSnapshot,
  revision: number
): Record<string, unknown> {
  const databaseId = Number(account.config.databaseId);
  return {
    databaseId: Number.isSafeInteger(databaseId) && databaseId > 0 ? databaseId : Date.now(),
    sourceMode: "webdav",
    fileName: snapshot.fileName,
    protectionMode: keyFile
      ? databasePassword ? "password-and-key-file" : "key-file"
      : databasePassword ? "password" : "empty",
    webDavBaseUrl: remote.baseUrl,
    webDavUsername: remote.username,
    webDavPassword: remote.password,
    remotePath: remote.remotePath,
    databasePassword,
    ...(keyFile ? { keyFile: bytesToBase64(keyFile) } : {}),
    [KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]: hasKeePassCacheEncryptionKey(account)
      ? account.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]
      : createKeePassCacheEncryptionKey(),
    workingCopyRevision: revision,
    remoteEtag: snapshot.etag,
    remoteLastModified: snapshot.lastModified,
    remoteSha256: snapshot.sha256,
    workingSha256: snapshot.sha256
  };
}

function decodeKeyFile(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > KEEPASS_KEY_FILE_MAX_BASE64_LENGTH) {
    throw new KeePassRemoteSessionError("remote-key-file-invalid", "KeePass 密钥文件超过安全上限或编码无效。");
  }
  try {
    const bytes = base64ToBytes(value);
    if (!bytes.length || bytes.length > KEEPASS_KEY_FILE_MAX_BYTES) throw new Error("invalid key file size");
    return bytes;
  } catch {
    throw new KeePassRemoteSessionError("remote-key-file-invalid", "KeePass 密钥文件超过安全上限或编码无效。");
  }
}

function stringConfig(account: ProviderAccount, key: string): string {
  return typeof account.config[key] === "string" ? account.config[key] as string : "";
}

function optionalStringConfig(account: ProviderAccount, key: string): string | undefined {
  return typeof account.config[key] === "string" ? account.config[key] as string : undefined;
}

function invalidProvider(): KeePassRemoteSessionError {
  return new KeePassRemoteSessionError("remote-provider-invalid", "所选密码源不是远端 KeePass 数据库。");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalize(entry)]));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}
