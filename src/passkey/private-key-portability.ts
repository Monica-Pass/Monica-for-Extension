const PEM_BEGIN = "-----BEGIN PRIVATE KEY-----";
const PEM_END = "-----END PRIVATE KEY-----";

export interface PortablePasskeyPrivateKey {
  pkcs8Base64: string;
  algorithm: -7 | -257 | -8;
}

/** Normalizes Android/KeePass portable material and rejects aliases or malformed DER. */
export function parsePortablePasskeyPrivateKey(value: unknown): PortablePasskeyPrivateKey | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("monica-passkey-key-ref-v1:")) return undefined;
  const begin = trimmed.indexOf(PEM_BEGIN);
  const body = begin >= 0 ? trimmed.slice(begin + PEM_BEGIN.length).split(PEM_END)[0] : trimmed;
  const standard = body.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "=");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) return undefined;
  const info = pkcs8AlgorithmInfo(padded);
  // WebAuthn ES256 is specifically P-256. Do not make a P-384 key look
  // usable merely because its outer algorithm OID is id-ecPublicKey.
  if (info?.oid === "1.2.840.10045.2.1" && info.parametersOid !== "1.2.840.10045.3.1.7") return undefined;
  const algorithm = info?.oid === "1.2.840.10045.2.1" ? -7 : info?.oid === "1.2.840.113549.1.1.1" ? -257 : info?.oid === "1.3.101.112" ? -8 : undefined;
  return algorithm ? { pkcs8Base64: padded, algorithm } : undefined;
}

function pkcs8AlgorithmInfo(value: string): { oid: string; parametersOid?: string } | undefined {
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0)); } catch { return undefined; }
  let offset = 0;
  const readHeader = (tag: number): number | undefined => {
    if (offset >= bytes.length || bytes[offset++] !== tag || offset >= bytes.length) return undefined;
    let length = bytes[offset++];
    if (length & 0x80) {
      const count = length & 0x7f;
      if (!count || count > 4 || offset + count > bytes.length) return undefined;
      length = 0;
      for (let index = 0; index < count; index += 1) length = length * 256 + bytes[offset++];
    }
    return offset + length <= bytes.length ? length : undefined;
  };
  const outerLength = readHeader(0x30);
  if (outerLength === undefined) return undefined;
  const outerEnd = offset + outerLength;
  const version = readHeader(0x02);
  if (version === undefined) return undefined;
  offset += version;
  const algorithmLength = readHeader(0x30);
  if (algorithmLength === undefined) return undefined;
  const algorithmEnd = offset + algorithmLength;
  const oidLength = readHeader(0x06);
  if (oidLength === undefined) return undefined;
  const oid = decodeOid(bytes.subarray(offset, offset + oidLength));
  offset += oidLength;
  let parametersOid: string | undefined;
  if (offset < algorithmEnd && bytes[offset] === 0x06) {
    const parametersLength = readHeader(0x06);
    if (parametersLength === undefined) return undefined;
    parametersOid = decodeOid(bytes.subarray(offset, offset + parametersLength));
  }
  offset = algorithmEnd;
  const privateKeyLength = readHeader(0x04);
  if (!oid || privateKeyLength === undefined || privateKeyLength === 0 || offset + privateKeyLength > outerEnd) return undefined;
  return oid ? { oid, parametersOid } : undefined;
}

function decodeOid(content: Uint8Array): string | undefined {
  if (!content.length) return undefined;
  const parts = [Math.floor(content[0] / 40), content[0] % 40];
  let value = 0;
  for (let index = 1; index < content.length; index += 1) {
    value = value * 128 + (content[index] & 0x7f);
    if (!(content[index] & 0x80)) { parts.push(value); value = 0; }
  }
  return value === 0 ? parts.join(".") : undefined;
}
