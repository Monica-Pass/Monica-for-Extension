import * as kdbxweb from "kdbxweb";
import { installKdbxCryptoEngine } from "./keepass-crypto";

/**
 * Port of Android `utils/KeePassCredentialSupport.kt` (SHA 9930d8d8).
 *
 * A KeePass key file is not one format. KeePassXC ships XML with base64 (v1) or hex (v2) inside a
 * `<Data>` element, KeePass 1.x accepted a bare 32-byte binary or a 64-character hex text file, and some
 * tooling hashes an arbitrary file. Android tries each interpretation in turn because there is no way to
 * tell from the file alone which one produced the database, and a wrong guess is indistinguishable from
 * a wrong password. The browser must try the same set or it will reject files Android opens.
 */

export interface KeePassCredentialCandidate {
  /** Diagnostic label, surfaced only in the failure message. Never contains key material. */
  label: string;
  credentials: kdbxweb.Credentials;
}

export async function buildKeePassCredentialCandidates(
  password: string,
  keyFileBytes: Uint8Array | undefined
): Promise<KeePassCredentialCandidate[]> {
  installKdbxCryptoEngine();
  if (!keyFileBytes) {
    return [{ label: "password-only", credentials: new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)) }];
  }

  const variants = await buildKeyMaterialVariants(keyFileBytes);
  const candidates: KeePassCredentialCandidate[] = [];
  const seen = new Set<string>();

  for (const [label, keyBytes] of variants) {
    const fingerprint = await sha256Hex(keyBytes);
    if (password) {
      if (seen.has(`password+key:${fingerprint}`)) continue;
      seen.add(`password+key:${fingerprint}`);
      candidates.push({ label: `${label}/password+key`, credentials: credentialsFor(password, keyBytes) });
      continue;
    }
    // A vault created with an empty password plus a key file may have been written either way; both
    // combinations have to be attempted or the file looks like it has the wrong credentials.
    if (!seen.has(`key-only:${fingerprint}`)) {
      seen.add(`key-only:${fingerprint}`);
      candidates.push({ label: `${label}/key-only`, credentials: credentialsFor(null, keyBytes) });
    }
    if (!seen.has(`empty-password+key:${fingerprint}`)) {
      seen.add(`empty-password+key:${fingerprint}`);
      candidates.push({ label: `${label}/empty-password+key`, credentials: credentialsFor("", keyBytes) });
    }
  }
  return candidates;
}

/**
 * The key material is installed directly instead of being handed to the `Credentials` constructor:
 * kdbxweb would run its own interpretation over the bytes, so a variant this module already decoded
 * would be decoded a second time — and a raw XML key file without a `<Meta>` element makes that second
 * pass reject outright, which would kill the whole candidate list rather than just that one variant.
 */
function credentialsFor(password: string | null, keyBytes: Uint8Array): kdbxweb.Credentials {
  const credentials = new kdbxweb.Credentials(password === null ? null : kdbxweb.ProtectedValue.fromString(password));
  // `fromBinary` takes ownership of the buffer, and a variant may back more than one candidate.
  credentials.keyFileHash = kdbxweb.ProtectedValue.fromBinary(keyBytes.slice().buffer);
  return credentials;
}

export function keePassInvalidCredentialMessage(attemptedLabels: string[]): string {
  const distinct = [...new Set(attemptedLabels)];
  if (!distinct.length) return "数据库密码或密钥文件不正确。";
  const concise = distinct.slice(0, 4).join(", ");
  const suffix = distinct.length > 4 ? ` 等${distinct.length}种组合` : "";
  return `数据库密码或密钥文件不正确（已尝试: ${concise}${suffix}）。`;
}

/** Deduplicated by content hash, so a hex text file whose raw bytes already decode is only tried once. */
async function buildKeyMaterialVariants(rawBytes: Uint8Array): Promise<[string, Uint8Array][]> {
  const byHash = new Map<string, [string, Uint8Array]>();
  const put = async (label: string, keyBytes: Uint8Array | undefined) => {
    if (!keyBytes?.length) return;
    const hash = await sha256Hex(keyBytes);
    if (!byHash.has(hash)) byHash.set(hash, [label, keyBytes]);
  };

  await put("raw", rawBytes);
  const text = decodeUtf8(rawBytes);
  if (text !== undefined) {
    await put("xml-data", extractXmlDataKey(text));
    await put("hex-text", extractHexTextKey(text));
  }
  await put("sha256(raw)", new Uint8Array(await crypto.subtle.digest("SHA-256", rawBytes as BufferSource)));

  return [...byHash.values()];
}

function extractXmlDataKey(content: string): Uint8Array | undefined {
  const match = /<Data[^>]*>([\s\S]*?)<\/Data>/i.exec(content);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  return decodeCompactKeyData(value.replace(/\s/g, ""));
}

function extractHexTextKey(content: string): Uint8Array | undefined {
  const compact = content.replace(/\s/g, "");
  if (compact.length !== 64 || !isHex(compact)) return undefined;
  return decodeHex(compact);
}

function decodeCompactKeyData(compact: string): Uint8Array | undefined {
  if (compact.length === 64 && isHex(compact)) return decodeHex(compact);
  try {
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

function isHex(value: string): boolean {
  return /^[0-9a-f]+$/i.test(value);
}

function decodeHex(value: string): Uint8Array | undefined {
  if (value.length % 2 !== 0) return undefined;
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    if (Number.isNaN(byte)) return undefined;
    out[index] = byte;
  }
  return out;
}

/** A binary key file is not valid UTF-8; `fatal` makes that a rejection instead of replacement chars. */
function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
