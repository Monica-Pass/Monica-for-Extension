const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_IDENTITY_NAME_BYTES = 64 * 1024;

export function assertMdbx2TransferOperationId(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error("MDBX2 批量传输操作 ID 必须是标准小写 UUID。");
  return value;
}

/** Standard UUIDv5 derived from the transfer operation namespace. */
export async function mdbx2TransferUuid(operationId: string, name: string): Promise<string> {
  const namespace = uuidBytes(assertMdbx2TransferOperationId(operationId));
  const encoded = new TextEncoder().encode(name);
  if (!encoded.length || encoded.length > MAX_IDENTITY_NAME_BYTES) throw new Error("MDBX2 批量传输身份名称无效。");
  const input = new Uint8Array(namespace.length + encoded.length);
  input.set(namespace);
  input.set(encoded, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const result = digest.slice(0, 16);
  result[6] = (result[6] & 0x0f) | 0x50;
  result[8] = (result[8] & 0x3f) | 0x80;
  return formatUuid(result);
}

/** Canonical SHA-256 scope accepted by `object.batch`. */
export async function mdbx2TransferOperationScope(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(stableJson(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("MDBX2 批量传输操作范围包含无效数字。");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry, ancestors)).join(",")}]`;
  if (typeof value !== "object") throw new Error("MDBX2 批量传输操作范围包含无法序列化的值。");
  if (ancestors.has(value)) throw new Error("MDBX2 批量传输操作范围包含循环引用。");
  const nextAncestors = new Set(ancestors).add(value);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry, nextAncestors)}`);
  return `{${entries.join(",")}}`;
}

function uuidBytes(value: string): Uint8Array {
  const compact = value.replace(/-/g, "");
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16));
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
