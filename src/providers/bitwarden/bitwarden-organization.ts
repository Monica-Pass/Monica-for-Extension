import { base64ToBytes } from "../../security/encoding";
import { decryptBitwardenRsaBytes, decryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";

export interface BitwardenOrganizationKeyResult {
  keys: Map<string, BitwardenSymmetricKey>;
  warnings: string[];
}

export async function resolveBitwardenOrganizationKeys(
  syncPayload: Record<string, unknown>,
  userVaultKey: BitwardenSymmetricKey
): Promise<BitwardenOrganizationKeyResult> {
  const profile = recordValue(syncPayload, "Profile", "profile") || {};
  const organizations = arrayValue(profile, "Organizations", "organizations").map(record);
  if (!organizations.length) return { keys: new Map(), warnings: [] };

  const protectedPrivateKey = stringValue(profile, "PrivateKey", "privateKey") || stringValue(syncPayload, "PrivateKey", "privateKey");
  if (!protectedPrivateKey) {
    return { keys: new Map(), warnings: ["Bitwarden 同步资料缺少用户 RSA 私钥，组织项目保持本地缓存且不会被覆盖。"] };
  }

  let privateKeyPkcs8: Uint8Array;
  try {
    privateKeyPkcs8 = base64ToBytes(await decryptBitwardenString(protectedPrivateKey, userVaultKey));
  } catch {
    return { keys: new Map(), warnings: ["Bitwarden 用户 RSA 私钥无法解密，组织项目保持本地缓存且不会被覆盖。"] };
  }

  const keys = new Map<string, BitwardenSymmetricKey>();
  const warnings: string[] = [];
  for (const organization of organizations) {
    const organizationId = stringValue(organization, "Id", "id");
    const protectedKey = stringValue(organization, "Key", "key");
    if (!organizationId || !protectedKey) {
      warnings.push(`Bitwarden 组织 ${organizationId || "unknown"} 缺少 ID 或密钥，相关项目已跳过。`);
      continue;
    }
    try {
      const rawKey = await decryptBitwardenRsaBytes(protectedKey, privateKeyPkcs8);
      if (rawKey.length !== 64) throw new Error("invalid organization key length");
      keys.set(organizationId, { encKey: rawKey.slice(0, 32), macKey: rawKey.slice(32) });
    } catch {
      warnings.push(`Bitwarden 组织 ${organizationId} 的密钥无法解密，相关项目保持本地缓存且不会被覆盖。`);
    }
  }
  return { keys, warnings };
}

function value(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (name in raw) return raw[name];
  return undefined;
}

function stringValue(raw: Record<string, unknown>, ...names: string[]): string {
  const result = value(raw, ...names);
  return typeof result === "string" ? result : "";
}

function arrayValue(raw: Record<string, unknown>, ...names: string[]): unknown[] {
  const result = value(raw, ...names);
  return Array.isArray(result) ? result : [];
}

function recordValue(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown> | undefined {
  const result = value(raw, ...names);
  return result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
}

function record(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
