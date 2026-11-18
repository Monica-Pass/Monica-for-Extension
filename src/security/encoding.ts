// Older supported browsers do not expose the typed-array Base64 APIs yet.
interface Base64Array extends Uint8Array { toBase64?: () => string }
interface Base64Constructor { fromBase64?: (value: string) => Uint8Array }

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (Uint8Array.prototype as Base64Array).toBase64;
  if (native) return native.call(bytes);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const native = (Uint8Array as Base64Constructor).fromBase64;
  if (native) {
    try { return native.call(Uint8Array, String(value)); }
    catch { /* Preserve atob's legacy validation and DOMException behavior. */ }
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
