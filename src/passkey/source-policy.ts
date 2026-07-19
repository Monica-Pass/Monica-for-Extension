import type { PasskeyItem } from "../core/model";

/**
 * Describes why a stored Passkey may or may not be used by the browser.
 * Android exports contain public metadata only; treating those records as
 * usable would make a WebAuthn request fail later and could encourage unsafe
 * fallback behaviour in callers.
 */
export type PasskeyAvailability =
  | "ready"
  | "android-metadata-only"
  | "missing-private-key"
  | "rp-mismatch";

export function passkeyAvailability(item: PasskeyItem, rpId?: string): PasskeyAvailability {
  if (item.sourceMode === "android-metadata-only") return "android-metadata-only";
  if (!item.privateKeyPkcs8) return "missing-private-key";
  if (rpId && item.rpId.toLowerCase() !== rpId.toLowerCase()) return "rp-mismatch";
  return "ready";
}

export function isUsablePasskey(item: PasskeyItem, rpId: string, credentialId?: string): boolean {
  if (credentialId && normalizeCredentialId(item.credentialId) !== normalizeCredentialId(credentialId)) return false;
  return passkeyAvailability(item, rpId) === "ready";
}

export function normalizeCredentialId(value: string): string {
  return value.trim().replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "").toLowerCase();
}

export function passkeyAvailabilityLabel(availability: PasskeyAvailability): string {
  return ({
    ready: "可用于浏览器认证",
    "android-metadata-only": "Android 元数据，仅可查看",
    "missing-private-key": "缺少私钥，仅可查看",
    "rp-mismatch": "与当前网站不匹配"
  } as const)[availability];
}
