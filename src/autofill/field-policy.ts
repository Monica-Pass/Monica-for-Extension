export type AutofillFieldRole = "username" | "current-password" | "new-password" | "totp" | "wallet";
export type AutofillFrameScope = "top-level" | "frame";

export interface BlockedFieldSignatureRecord {
  signature: string;
  hostname: string;
  frameScope: AutofillFrameScope;
  role: AutofillFieldRole;
  hints: AutofillFieldRole[];
  blockedAt: string;
}

export const MAX_BLOCKED_FIELD_SIGNATURES = 256;
const SIGNATURE = /^[0-9a-f]{64}$/;
const ROLES = new Set<AutofillFieldRole>(["username", "current-password", "new-password", "totp", "wallet"]);

export function normalizeBlockedFieldSignatures(input: unknown): BlockedFieldSignatureRecord[] {
  if (!Array.isArray(input)) throw new Error("字段级自动填充排除项格式无效。");
  if (input.length > MAX_BLOCKED_FIELD_SIGNATURES) throw new Error("字段级自动填充排除项不能超过 256 条。");
  const bySignature = new Map<string, BlockedFieldSignatureRecord>();
  for (const value of input) {
    const record = normalizeBlockedFieldSignature(value);
    const existing = bySignature.get(record.signature);
    if (!existing || record.blockedAt >= existing.blockedAt) bySignature.set(record.signature, record);
  }
  return [...bySignature.values()].sort((left, right) => right.blockedAt.localeCompare(left.blockedAt) || left.signature.localeCompare(right.signature));
}

export function normalizeBlockedFieldSignature(value: unknown): BlockedFieldSignatureRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("字段级自动填充排除项格式无效。");
  const record = value as Record<string, unknown>;
  if (typeof record.signature !== "string" || !SIGNATURE.test(record.signature)) throw new Error("字段签名格式无效。");
  if (record.frameScope !== "top-level" && record.frameScope !== "frame") throw new Error("字段所在页面范围无效。");
  if (typeof record.role !== "string" || !ROLES.has(record.role as AutofillFieldRole)) throw new Error("字段类型无效。");
  if (!Array.isArray(record.hints) || record.hints.length > 8 || !record.hints.every((hint) => typeof hint === "string" && ROLES.has(hint as AutofillFieldRole))) {
    throw new Error("字段提示格式无效。");
  }
  if (typeof record.blockedAt !== "string" || record.blockedAt.length > 64 || !Number.isFinite(Date.parse(record.blockedAt))) throw new Error("字段排除时间无效。");
  return {
    signature: record.signature,
    hostname: normalizeFieldPolicyHostname(record.hostname),
    frameScope: record.frameScope,
    role: record.role as AutofillFieldRole,
    hints: [...new Set(record.hints as AutofillFieldRole[])],
    blockedAt: new Date(record.blockedAt).toISOString()
  };
}

export function normalizeFieldPolicyHostname(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 253 || /[\s/@?#]/.test(value)) throw new Error("字段所属域名无效。");
  try {
    const hostname = new URL(`https://${value.toLowerCase().replace(/\.+$/, "")}`).hostname;
    if (!hostname || hostname.length > 253) throw new Error("invalid hostname");
    return hostname;
  } catch {
    throw new Error("字段所属域名无效。");
  }
}

export function addBlockedFieldSignature(records: BlockedFieldSignatureRecord[], input: BlockedFieldSignatureRecord): BlockedFieldSignatureRecord[] {
  const record = normalizeBlockedFieldSignature(input);
  return normalizeBlockedFieldSignatures([record, ...records.filter((candidate) => candidate.signature !== record.signature)].slice(0, MAX_BLOCKED_FIELD_SIGNATURES));
}
