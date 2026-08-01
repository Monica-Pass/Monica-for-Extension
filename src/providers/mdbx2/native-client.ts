import {
  MDBX2_FORMAT_VERSION,
  MDBX2_MAX_BINARY_CHUNK_BYTES,
  MDBX2_MAX_INBOUND_FILE_BYTES,
  MDBX2_NATIVE_HOST_NAME,
  MDBX2_NATIVE_PROTOCOL_VERSION,
  Mdbx2NativeHostError,
  mdbx2NativeConnectionError,
  parseMdbx2NativeResponse,
  validateMdbx2HostCapabilities,
  type Mdbx2HostCapabilities,
  type Mdbx2HostStatus,
  type Mdbx2NativeMethod,
  type Mdbx2NativeRequest,
  type Mdbx2TransferBeginResult,
  type Mdbx2TransferChunkResult,
  type Mdbx2TransferFinishResult,
  type Mdbx2VaultCredential,
  type Mdbx2VaultInspection,
  type Mdbx2VaultRuntimeStatus,
  type Mdbx2VaultSessionSummary,
  type Mdbx2VaultSource
} from "./native-contract";
import { bytesToBase64 } from "../../security/encoding";

interface NativeEvent<Listener extends (...args: never[]) => void> {
  addListener(listener: Listener): void;
  removeListener(listener: Listener): void;
}

export interface Mdbx2NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: NativeEvent<(message: never) => void>;
  onDisconnect: NativeEvent<() => void>;
}

export interface Mdbx2NativeRuntime {
  connectNative(hostName: string): Mdbx2NativePort;
  disconnectErrorMessage(): string | undefined;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class Mdbx2NativeClient {
  private port?: Mdbx2NativePort;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly runtime: Mdbx2NativeRuntime,
    private readonly createRequestId: () => string = () => crypto.randomUUID()
  ) {}

  async hello(timeoutMs = 5_000): Promise<Mdbx2HostCapabilities> {
    return validateMdbx2HostCapabilities(await this.request("host.hello", {}, timeoutMs));
  }

  async beginInboundTransfer(sizeBytes: number, sha256: string, timeoutMs = 15_000): Promise<Mdbx2TransferBeginResult> {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MDBX2_MAX_INBOUND_FILE_BYTES) {
      throw new Mdbx2NativeHostError("transfer-size-invalid", "MDBX2 文件大小超出允许范围。", false);
    }
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Mdbx2NativeHostError("transfer-digest-invalid", "MDBX2 文件摘要无效。", false);
    return transferBeginResult(await this.request("transfer.begin", {
      direction: "extension-to-host",
      purpose: "vault-bootstrap",
      sizeBytes,
      sha256
    }, timeoutMs));
  }

  async sendInboundChunk(transferId: string, offset: number, bytes: Uint8Array, timeoutMs = 30_000): Promise<Mdbx2TransferChunkResult> {
    if (!bytes.length || bytes.length > MDBX2_MAX_BINARY_CHUNK_BYTES) {
      throw new Mdbx2NativeHostError("transfer-chunk-invalid", "MDBX2 文件分块大小无效。", false);
    }
    return transferChunkResult(await this.request("transfer.chunk", {
      transferId: opaqueHandle(transferId, "传输"),
      offset: safeInteger(offset, "传输偏移"),
      dataBase64: bytesToBase64(bytes)
    }, timeoutMs));
  }

  async finishInboundTransfer(transferId: string, timeoutMs = 60_000): Promise<Mdbx2TransferFinishResult> {
    return transferFinishResult(await this.request("transfer.finish", { transferId: opaqueHandle(transferId, "传输") }, timeoutMs));
  }

  async abortInboundTransfer(transferId: string, timeoutMs = 15_000): Promise<boolean> {
    const result = objectResult(await this.request("transfer.abort", { transferId: opaqueHandle(transferId, "传输") }, timeoutMs), "Native Host 中止传输响应无效。");
    return booleanResult(result.aborted, "Native Host 中止传输状态无效。");
  }

  async inspectVault(source: Mdbx2VaultSource, timeoutMs = 15_000): Promise<Mdbx2VaultInspection> {
    return vaultInspection(await this.request("vault.inspect", { source: vaultSource(source) }, timeoutMs));
  }

  async openVault(source: Mdbx2VaultSource, credential: Mdbx2VaultCredential, timeoutMs = 5 * 60_000): Promise<Mdbx2VaultSessionSummary> {
    return vaultSessionSummary(await this.request("vault.open", { source: vaultSource(source), credential }, timeoutMs));
  }

  async vaultStatus(vaultHandle: string, timeoutMs = 15_000): Promise<Mdbx2VaultRuntimeStatus> {
    const result = objectResult(await this.request("vault.status", { vaultHandle: opaqueHandle(vaultHandle, "保险库") }, timeoutMs), "Native Host 保险库状态响应无效。");
    return {
      vaultHandle: opaqueHandle(result.vaultHandle, "保险库"),
      open: booleanResult(result.open, "Native Host 保险库打开状态无效。"),
      available: booleanResult(result.available, "Native Host 保险库可用状态无效。")
    };
  }

  async lockVault(vaultHandle: string, timeoutMs = 15_000): Promise<boolean> {
    const result = objectResult(await this.request("vault.lock", { vaultHandle: opaqueHandle(vaultHandle, "保险库") }, timeoutMs), "Native Host 锁定响应无效。");
    return booleanResult(result.locked, "Native Host 锁定状态无效。");
  }

  async probe(timeoutMs = 5_000): Promise<Mdbx2HostStatus> {
    try {
      const capabilities = await this.hello(timeoutMs);
      return {
        availability: "ready",
        hostName: MDBX2_NATIVE_HOST_NAME,
        message: "Monica MDBX2 Native Host 已安装并通过版本检查。",
        capabilities
      };
    } catch (error) {
      const nativeError = error instanceof Mdbx2NativeHostError ? error : mdbx2NativeConnectionError(error);
      return {
        availability: nativeError.code === "native-host-not-installed"
          ? "not-installed"
          : nativeError.code === "native-host-incompatible" || nativeError.code === "native-host-forbidden"
            ? "incompatible"
            : "unavailable",
        hostName: MDBX2_NATIVE_HOST_NAME,
        message: nativeError.message
      };
    } finally {
      this.close();
    }
  }

  async request(method: Mdbx2NativeMethod, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 5 * 60_000) {
      throw new Mdbx2NativeHostError("native-timeout-invalid", "Native Host 请求超时设置无效。", false);
    }
    const port = this.ensurePort();
    const requestId = this.createRequestId();
    const request: Mdbx2NativeRequest = { protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId, method, params };
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Mdbx2NativeHostError("native-request-timeout", "Native Host 请求超时。", true));
        this.close();
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeoutId });
      try {
        port.postMessage(request);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(requestId);
        reject(mdbx2NativeConnectionError(error));
        this.close();
      }
    });
  }

  close(): void {
    const port = this.port;
    this.port = undefined;
    if (port) {
      port.onMessage.removeListener(this.onMessage);
      port.onDisconnect.removeListener(this.onDisconnect);
      try { port.disconnect(); } catch { /* Port may already be closed. */ }
    }
    this.rejectPending(new Mdbx2NativeHostError("native-host-closed", "Native Host 会话已关闭。", true));
  }

  private ensurePort(): Mdbx2NativePort {
    if (this.port) return this.port;
    try {
      const port = this.runtime.connectNative(MDBX2_NATIVE_HOST_NAME);
      port.onMessage.addListener(this.onMessage);
      port.onDisconnect.addListener(this.onDisconnect);
      this.port = port;
      return port;
    } catch (error) {
      throw mdbx2NativeConnectionError(error);
    }
  }

  private readonly onMessage = (message: never): void => {
    let response;
    try {
      response = parseMdbx2NativeResponse(message);
    } catch (error) {
      this.rejectPending(error instanceof Error ? error : new Error("Native Host 响应无效。"));
      this.close();
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timeoutId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Mdbx2NativeHostError(response.error.code, response.error.message, response.error.retryable));
  };

  private readonly onDisconnect = (): void => {
    const message = this.runtime.disconnectErrorMessage();
    const port = this.port;
    this.port = undefined;
    if (port) {
      port.onMessage.removeListener(this.onMessage);
      port.onDisconnect.removeListener(this.onDisconnect);
    }
    this.rejectPending(mdbx2NativeConnectionError(message || "Native Host 连接已断开。"));
  };

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function createChromeMdbx2NativeRuntime(): Mdbx2NativeRuntime {
  return {
    connectNative: (hostName) => chrome.runtime.connectNative(hostName) as unknown as Mdbx2NativePort,
    disconnectErrorMessage: () => chrome.runtime.lastError?.message
  };
}

function transferBeginResult(input: unknown): Mdbx2TransferBeginResult {
  const value = objectResult(input, "Native Host 传输开始响应无效。");
  const maxChunkBytes = safeInteger(value.maxChunkBytes, "分块上限");
  if (maxChunkBytes !== MDBX2_MAX_BINARY_CHUNK_BYTES) throw incompatibleResult("Native Host 分块上限发生变化。");
  return {
    transferId: opaqueHandle(value.transferId, "传输"),
    nextOffset: safeInteger(value.nextOffset, "传输偏移"),
    maxChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES
  };
}

function transferChunkResult(input: unknown): Mdbx2TransferChunkResult {
  const value = objectResult(input, "Native Host 传输分块响应无效。");
  return {
    nextOffset: safeInteger(value.nextOffset, "传输偏移"),
    acceptedBytes: safeInteger(value.acceptedBytes, "已接收字节数"),
    repeated: booleanResult(value.repeated, "Native Host 分块重试状态无效。")
  };
}

function transferFinishResult(input: unknown): Mdbx2TransferFinishResult {
  const value = objectResult(input, "Native Host 传输完成响应无效。");
  const sha256 = stringResult(value.sha256, 64, "Native Host 文件摘要无效。");
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw incompatibleResult("Native Host 文件摘要无效。");
  return {
    fileHandle: opaqueHandle(value.fileHandle, "文件"),
    sizeBytes: safeInteger(value.sizeBytes, "文件大小"),
    sha256
  };
}

function vaultInspection(input: unknown): Mdbx2VaultInspection {
  const value = objectResult(input, "Native Host 保险库检查响应无效。");
  const source = objectResult(value.source, "Native Host 保险库来源无效。");
  const kind = source.kind === "file" || source.kind === "vault" ? source.kind : undefined;
  if (!kind) throw incompatibleResult("Native Host 保险库来源类型无效。");
  if (value.initialized !== true || value.formatVersion !== MDBX2_FORMAT_VERSION || value.unknownCriticalExtensions !== false || value.targetFormatVersion !== MDBX2_FORMAT_VERSION) {
    throw incompatibleResult("Native Host 返回了非 MDBX2 保险库检查结果。");
  }
  return {
    source: { kind, handle: opaqueHandle(source.handle, "来源") },
    initialized: true,
    formatVersion: MDBX2_FORMAT_VERSION,
    schemaVersion: optionalInteger(value.schemaVersion, "Schema 版本"),
    minReaderVersion: optionalString(value.minReaderVersion, 64, "最低读取版本"),
    minWriterVersion: optionalString(value.minWriterVersion, 64, "最低写入版本"),
    requiresUpgrade: booleanResult(value.requiresUpgrade, "升级状态无效。"),
    unknownCriticalExtensions: false,
    targetFormatVersion: MDBX2_FORMAT_VERSION,
    targetSchemaVersion: safeInteger(value.targetSchemaVersion, "目标 Schema 版本")
  };
}

function vaultSessionSummary(input: unknown): Mdbx2VaultSessionSummary {
  const value = objectResult(input, "Native Host 保险库打开响应无效。");
  if (value.formatVersion !== MDBX2_FORMAT_VERSION) throw incompatibleResult("Native Host 返回了非 MDBX2 会话。");
  const health = objectResult(value.health, "Native Host 健康检查摘要无效。");
  const diagnostics = objectResult(value.diagnostics, "Native Host诊断摘要无效。");
  const count = (key: string) => safeInteger(diagnostics[key], `诊断字段 ${key}`);
  return {
    vaultHandle: opaqueHandle(value.vaultHandle, "保险库"),
    vaultId: stringResult(value.vaultId, 128, "Native Host vault ID 无效。"),
    deviceId: stringResult(value.deviceId, 128, "Native Host device ID 无效。"),
    formatVersion: MDBX2_FORMAT_VERSION,
    schemaVersion: safeInteger(value.schemaVersion, "Schema 版本"),
    migrated: booleanResult(value.migrated, "迁移状态无效。"),
    preUpgradeBackupCreated: booleanResult(value.preUpgradeBackupCreated, "升级备份状态无效。"),
    health: {
      healthy: booleanResult(health.healthy, "保险库健康状态无效。"),
      issueCount: safeInteger(health.issueCount, "健康问题数量")
    },
    diagnostics: {
      commitCount: count("commitCount"), tombstoneCount: count("tombstoneCount"), branchCount: count("branchCount"), deviceCount: count("deviceCount"),
      snapshotCount: count("snapshotCount"), unresolvedConflictCount: count("unresolvedConflictCount"), projectCount: count("projectCount"),
      deletedProjectCount: count("deletedProjectCount"), entryCount: count("entryCount"), deletedEntryCount: count("deletedEntryCount"),
      attachmentCount: count("attachmentCount"), deletedAttachmentCount: count("deletedAttachmentCount"), externalAttachmentCount: count("externalAttachmentCount"),
      originalAttachmentBytes: count("originalAttachmentBytes"), storedAttachmentBytes: count("storedAttachmentBytes")
    }
  };
}

function vaultSource(source: Mdbx2VaultSource): Mdbx2VaultSource {
  if (source.kind !== "file" && source.kind !== "vault") throw new Mdbx2NativeHostError("vault-source-invalid", "MDBX2 保险库来源无效。", false);
  return { kind: source.kind, handle: opaqueHandle(source.handle, "来源") };
}

function objectResult(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw incompatibleResult(message);
  return value as Record<string, unknown>;
}

function opaqueHandle(value: unknown, label: string): string {
  const handle = stringResult(value, 36, `${label}句柄无效。`);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(handle)) throw incompatibleResult(`${label}句柄无效。`);
  return handle;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw incompatibleResult(`${label}无效。`);
  return value;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  return value === null || value === undefined ? undefined : safeInteger(value, label);
}

function stringResult(value: unknown, maxBytes: number, message: string): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > maxBytes) throw incompatibleResult(message);
  return value;
}

function optionalString(value: unknown, maxBytes: number, label: string): string | undefined {
  return value === null || value === undefined ? undefined : stringResult(value, maxBytes, `${label}无效。`);
}

function booleanResult(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw incompatibleResult(message);
  return value;
}

function incompatibleResult(message: string): Mdbx2NativeHostError {
  return new Mdbx2NativeHostError("native-host-incompatible", message, false);
}
