import type { ProviderAccount } from "../../core/model";
import { base64ToBytes, bytesToBase64 } from "../../security/encoding";
import { normalizeServerUrl } from "../webdav/webdav-client";
import {
  KeePassWebDavClient,
  normalizeKeePassRemotePath,
  type KeePassWebDavConfig,
  type KeePassWebDavFileStat,
  type KeePassWebDavSnapshot
} from "./keepass-webdav-client";
import { KeePassProvider, type KeePassSessionSummary } from "./keepass-provider";
import type { KeePassWorkingCopyStorage } from "./keepass-working-copy-store";

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

export type KeePassRemoteSessionErrorCode =
  | "remote-provider-invalid"
  | "remote-working-copy-missing"
  | "remote-credential-missing"
  | "remote-key-file-invalid";

export class KeePassRemoteSessionError extends Error {
  constructor(readonly code: KeePassRemoteSessionErrorCode, message: string) {
    super(message);
    this.name = "KeePassRemoteSessionError";
  }
}

export interface KeePassRemoteFileClient {
  testConnection(signal?: AbortSignal): Promise<void>;
  stat(signal?: AbortSignal): Promise<KeePassWebDavFileStat | undefined>;
  read(signal?: AbortSignal): Promise<KeePassWebDavSnapshot>;
}

export type KeePassRemoteFileClientFactory = (config: KeePassWebDavConfig) => KeePassRemoteFileClient;

export class KeePassRemoteSessionService {
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
      return {
        session,
        accountConfig: remoteAccountConfig(account, remote, input.databasePassword, keyFile, snapshot, record.revision)
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
        accountConfig: {
          ...account.config,
          sourceMode: "webdav",
          workingCopyRevision: record.revision,
          remoteEtag: record.baseEtag,
          remoteLastModified: record.baseLastModified,
          remoteSha256: record.baseSha256,
          workingSha256: record.workingSha256
        }
      };
    } finally {
      keyFile?.fill(0);
      record.baseBytes.fill(0);
      record.workingBytes.fill(0);
    }
  }

  async remove(providerId: string): Promise<void> {
    this.provider.lockAccount(providerId);
    await this.storage.delete(providerId);
  }
}

function normalizeRemoteConfig(input: Pick<KeePassWebDavOpenInput, "baseUrl" | "username" | "webDavPassword" | "remotePath">): KeePassWebDavConfig {
  return {
    baseUrl: normalizeServerUrl(input.baseUrl),
    username: input.username.trim(),
    password: input.webDavPassword,
    remotePath: normalizeKeePassRemotePath(input.remotePath)
  };
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
