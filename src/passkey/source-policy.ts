import type { PasskeyItem } from "../core/model";
import { fromBase64Url, normalizeRpId, toBase64Url } from "./webauthn-core";

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
  | "unsupported-algorithm"
  | "rp-mismatch";

export function passkeyAvailability(item: PasskeyItem, rpId?: string): PasskeyAvailability {
  if (item.sourceMode === "android-metadata-only") return "android-metadata-only";
  if (!item.privateKeyPkcs8) return "missing-private-key";
  if (item.algorithm !== -7) return "unsupported-algorithm";
  if (rpId && !passkeyRpIdsEqual(item.rpId, rpId)) return "rp-mismatch";
  return "ready";
}

export function isUsablePasskey(item: PasskeyItem, rpId: string, credentialId?: string): boolean {
  if (credentialId && normalizeCredentialId(item.credentialId) !== normalizeCredentialId(credentialId)) return false;
  return passkeyAvailability(item, rpId) === "ready";
}

export function normalizeCredentialId(value: string): string {
  const trimmed = value.trim();
  const uuid = trimmed.match(/^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i);
  if (uuid) {
    const bytes = Uint8Array.from(uuid.slice(1).join("").match(/../g) || [], (part) => Number.parseInt(part, 16));
    return toBase64Url(bytes);
  }
  try {
    return toBase64Url(fromBase64Url(trimmed.replace(/=+$/, "")));
  } catch {
    return trimmed;
  }
}

export function passkeyRpIdsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeRpId(left);
  const normalizedRight = normalizeRpId(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

export function passkeyMatchesPageHost(item: PasskeyItem, pageHost: string): boolean {
  const host = normalizeRpId(pageHost);
  const rpId = normalizeRpId(item.rpId);
  return Boolean(host && rpId && (host === rpId || host.endsWith(`.${rpId}`)));
}

export function selectPasskeyCandidates(items: PasskeyItem[], rpId: string, allowedCredentialIds: string[]): PasskeyItem[] {
  const allowed = new Set(allowedCredentialIds.map(normalizeCredentialId));
  return items.filter((item) => passkeyAvailability(item, rpId) === "ready"
    && (allowed.size ? allowed.has(normalizeCredentialId(item.credentialId)) : item.discoverable));
}

export function hasExcludedUsablePasskey(items: PasskeyItem[], rpId: string, excludedCredentialIds: string[]): boolean {
  const excluded = new Set(excludedCredentialIds.map(normalizeCredentialId));
  return items.some((item) => passkeyAvailability(item, rpId) === "ready" && excluded.has(normalizeCredentialId(item.credentialId)));
}

export function passkeyAvailabilityLabel(availability: PasskeyAvailability): string {
  return ({
    ready: "可用于浏览器认证",
    "android-metadata-only": "Android 元数据，仅可查看",
    "missing-private-key": "缺少私钥，仅可查看",
    "unsupported-algorithm": "当前浏览器暂不支持此算法",
    "rp-mismatch": "与当前网站不匹配"
  } as const)[availability];
}
