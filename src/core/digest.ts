/** Shared canonical-JSON / SHA-256 digest kernel for the removal flows.
 * Extracted byte-for-byte from the former per-module copies: persisted
 * digests, idempotency keys and snapshot hashes must never change. */

/** Recursively sort object keys (localeCompare, the comparator every former
 * in-tree copy used); arrays keep their order. */
function canonicalValue(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonicalValue)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonicalValue(entry)])) : value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Hex(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Deterministic version-5 shaped UUID from the digest of the given parts.
 * The Bitwarden attachment copyId template keeps its own slice form: it
 * forces the fourth group's high nibble to '8' instead of masking the
 * digest byte, so the two derivations are NOT interchangeable. */
export async function digestUuid(parts: string[]): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
