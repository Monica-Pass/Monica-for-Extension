export const MDBX2_NATIVE_HOST_NAME = "com.monica_pass.mdbx2";
export const MDBX2_NATIVE_PROTOCOL_VERSION = 1;
export const MDBX2_CORE_REVISION = "aafa22f195c626a8d8288d712bf42bccea134847";
export const MDBX2_ENGINE_VERSION = "0.2.0";
export const MDBX2_FORMAT_VERSION = "MDBX-2";
export const MDBX2_SYNC_PROTOCOL_VERSION = 2;
export const MDBX2_MAX_BINARY_CHUNK_BYTES = 256 * 1024;

export type Mdbx2NativeMethod = "host.hello";

export interface Mdbx2NativeRequest<M extends Mdbx2NativeMethod = Mdbx2NativeMethod> {
  protocol: typeof MDBX2_NATIVE_PROTOCOL_VERSION;
  requestId: string;
  method: M;
  params: Record<string, unknown>;
}

export interface Mdbx2NativeErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
}

export type Mdbx2NativeResponse<T = unknown> =
  | { protocol: typeof MDBX2_NATIVE_PROTOCOL_VERSION; requestId: string; ok: true; result: T }
  | { protocol: typeof MDBX2_NATIVE_PROTOCOL_VERSION; requestId: string; ok: false; error: Mdbx2NativeErrorPayload };

export interface Mdbx2HostCapabilities {
  hostName: typeof MDBX2_NATIVE_HOST_NAME;
  hostVersion: string;
  protocolVersion: typeof MDBX2_NATIVE_PROTOCOL_VERSION;
  mdbxCoreRevision: typeof MDBX2_CORE_REVISION;
  mdbxEngineVersion: typeof MDBX2_ENGINE_VERSION;
  mdbxFormatVersion: typeof MDBX2_FORMAT_VERSION;
  supportsMdbx1: false;
  maxBinaryChunkBytes: typeof MDBX2_MAX_BINARY_CHUNK_BYTES;
  storageProfile: string;
  syncProfile: string;
  syncProtocolVersion: typeof MDBX2_SYNC_PROTOCOL_VERSION;
  enabledStorageCapabilityIds: string[];
  enabledSyncCapabilityIds: string[];
}

export type Mdbx2HostAvailability = "ready" | "not-installed" | "incompatible" | "unavailable";

export interface Mdbx2HostStatus {
  availability: Mdbx2HostAvailability;
  hostName: typeof MDBX2_NATIVE_HOST_NAME;
  message: string;
  capabilities?: Mdbx2HostCapabilities;
}

export class Mdbx2NativeHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "Mdbx2NativeHostError";
  }
}

export function parseMdbx2NativeResponse(input: unknown): Mdbx2NativeResponse {
  const response = objectValue(input, "Native Host 返回了无效响应。");
  if (response.protocol !== MDBX2_NATIVE_PROTOCOL_VERSION) {
    throw incompatible("Native Host 协议版本与插件不一致。");
  }
  const requestId = boundedIdentifier(response.requestId, 128, "Native Host 响应缺少有效请求 ID。");
  if (response.ok === true) {
    if (!("result" in response)) throw incompatible("Native Host 成功响应缺少结果。");
    return { protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId, ok: true, result: response.result };
  }
  if (response.ok !== false) throw incompatible("Native Host 响应状态无效。");
  const error = objectValue(response.error, "Native Host 错误响应格式无效。");
  return {
    protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
    requestId,
    ok: false,
    error: {
      code: boundedIdentifier(error.code, 128, "Native Host 错误代码无效。"),
      message: boundedString(error.message, 512, "Native Host 错误消息无效。"),
      retryable: booleanValue(error.retryable, "Native Host 错误重试标记无效。")
    }
  };
}

export function validateMdbx2HostCapabilities(input: unknown): Mdbx2HostCapabilities {
  const value = objectValue(input, "Native Host 能力清单无效。");
  if (value.hostName !== MDBX2_NATIVE_HOST_NAME) throw incompatible("Native Host 名称与 Monica MDBX2 不匹配。");
  if (value.protocolVersion !== MDBX2_NATIVE_PROTOCOL_VERSION) throw incompatible("Native Host 协议版本与插件不一致。");
  if (value.mdbxCoreRevision !== MDBX2_CORE_REVISION) throw incompatible("Native Host 使用了未经审核的 MDBX2 核心版本。");
  if (value.mdbxEngineVersion !== MDBX2_ENGINE_VERSION) throw incompatible("Native Host MDBX2 引擎版本与插件不一致。");
  if (value.mdbxFormatVersion !== MDBX2_FORMAT_VERSION) throw incompatible("Native Host 未声明 MDBX-2 格式支持。");
  if (value.supportsMdbx1 !== false) throw incompatible("Native Host 错误声明了 MDBX1 支持。");
  if (value.maxBinaryChunkBytes !== MDBX2_MAX_BINARY_CHUNK_BYTES) throw incompatible("Native Host 二进制分块限制与插件不一致。");
  if (value.syncProtocolVersion !== MDBX2_SYNC_PROTOCOL_VERSION) throw incompatible("Native Host 同步协议版本与插件不一致。");
  return {
    hostName: MDBX2_NATIVE_HOST_NAME,
    hostVersion: boundedString(value.hostVersion, 64, "Native Host 版本无效。"),
    protocolVersion: MDBX2_NATIVE_PROTOCOL_VERSION,
    mdbxCoreRevision: MDBX2_CORE_REVISION,
    mdbxEngineVersion: MDBX2_ENGINE_VERSION,
    mdbxFormatVersion: MDBX2_FORMAT_VERSION,
    supportsMdbx1: false,
    maxBinaryChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES,
    storageProfile: boundedString(value.storageProfile, 128, "Native Host 存储能力配置无效。"),
    syncProfile: boundedString(value.syncProfile, 128, "Native Host 同步能力配置无效。"),
    syncProtocolVersion: MDBX2_SYNC_PROTOCOL_VERSION,
    enabledStorageCapabilityIds: capabilityIds(value.enabledStorageCapabilityIds, "存储"),
    enabledSyncCapabilityIds: capabilityIds(value.enabledSyncCapabilityIds, "同步")
  };
}

export function mdbx2NativeConnectionError(error: unknown): Mdbx2NativeHostError {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Native Host 连接失败。";
  const normalized = message.toLocaleLowerCase();
  if (normalized.includes("native messaging host not found") || normalized.includes("specified native messaging host not found")) {
    return new Mdbx2NativeHostError("native-host-not-installed", "尚未安装 Monica MDBX2 Native Host。", false);
  }
  if (normalized.includes("forbidden") || normalized.includes("not allowed")) {
    return new Mdbx2NativeHostError("native-host-forbidden", "Native Host 未授权当前 Monica 插件 ID。", false);
  }
  return new Mdbx2NativeHostError("native-host-disconnected", "Native Host 连接已断开。", true);
}

function incompatible(message: string): Mdbx2NativeHostError {
  return new Mdbx2NativeHostError("native-host-incompatible", message, false);
}

function objectValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw incompatible(message);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maxBytes: number, message: string): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > maxBytes) throw incompatible(message);
  return value;
}

function boundedIdentifier(value: unknown, maxBytes: number, message: string): string {
  const text = boundedString(value, maxBytes, message);
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) throw incompatible(message);
  return text;
}

function booleanValue(value: unknown, message: string): boolean {
  if (typeof value !== "boolean") throw incompatible(message);
  return value;
}

function capabilityIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 128) throw incompatible(`Native Host ${label}能力列表无效。`);
  return value.map((entry) => boundedIdentifier(entry, 128, `Native Host ${label}能力标识无效。`));
}
