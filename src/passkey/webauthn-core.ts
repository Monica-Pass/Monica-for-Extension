import { parse as parseDomain } from "tldts";

const MONICA_AAGUID = Uint8Array.of(
  0x6d, 0x6f, 0x6e, 0x69, 0x63, 0x61, 0x4d, 0x33,
  0xa0, 0x01, 0x70, 0x61, 0x73, 0x73, 0x6b, 0x79
);

export interface PasskeyCreateInput {
  origin: string;
  challenge: string;
  rpId?: string;
  rpName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  algorithms: number[];
  excludeCredentialIds: string[];
  userVerified?: boolean;
}

export interface PasskeyCreateOutput {
  credentialId: string;
  rpId: string;
  publicKeySpki: string;
  privateKeyPkcs8: string;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    authenticatorData: string;
    publicKey: string;
    publicKeyAlgorithm: -7;
  };
}

export interface PasskeyAssertionInput {
  origin: string;
  challenge: string;
  rpId?: string;
  credentialId: string;
  userHandle: string;
  privateKeyPkcs8: string;
  signCount: number;
  userVerified?: boolean;
}

export function validateRpId(origin: string, requestedRpId?: string): string {
  const page = new URL(origin);
  const pageHost = normalizeRpId(page.hostname);
  const local = isLoopbackRpId(pageHost);
  if (page.protocol !== "https:" && !(local && page.protocol === "http:")) throw new Error("Passkey 只允许安全 HTTPS 来源。");
  const rpId = normalizeRpId(requestedRpId || pageHost);
  if (!pageHost || !rpId || !(pageHost === rpId || pageHost.endsWith(`.${rpId}`))) throw new Error("RP ID 与当前页面来源不匹配。");
  const parsed = parseDomain(rpId, { allowPrivateDomains: true });
  if (!local && !parsed.isIp && !parsed.domain) throw new Error("RP ID 不能是公共后缀。");
  return rpId;
}

export async function createPasskey(input: PasskeyCreateInput): Promise<PasskeyCreateOutput> {
  const rpId = validateRpId(input.origin, input.rpId);
  assertChallenge(input.challenge);
  if (!input.algorithms.includes(-7)) throw new Error("当前仅支持 ES256 Passkey。");
  const credentialBytes = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = toBase64Url(credentialBytes);
  if (input.excludeCredentialIds.includes(credentialId)) throw new Error("此凭据已被网站排除。");
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const [jwk, spki, pkcs8] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("spki", pair.publicKey),
    crypto.subtle.exportKey("pkcs8", pair.privateKey)
  ]);
  if (!jwk.x || !jwk.y) throw new Error("无法导出 ES256 公钥。");
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  const coseKey = encodeCbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, fromBase64Url(jwk.x)], [-3, fromBase64Url(jwk.y)]]));
  const flags = 0x59 | (input.userVerified ? 0x04 : 0);
  const authenticatorData = concat(rpHash, Uint8Array.of(flags), uint32(0), MONICA_AAGUID, uint16(credentialBytes.length), credentialBytes, coseKey);
  const attestationObject = encodeCbor(new Map<unknown, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authenticatorData]]));
  const clientDataJSON = clientData("webauthn.create", input.challenge, input.origin);
  return {
    credentialId,
    rpId,
    publicKeySpki: toBase64(new Uint8Array(spki)),
    privateKeyPkcs8: toBase64(new Uint8Array(pkcs8)),
    response: {
      clientDataJSON: toBase64Url(clientDataJSON),
      attestationObject: toBase64Url(attestationObject),
      authenticatorData: toBase64Url(authenticatorData),
      publicKey: toBase64Url(new Uint8Array(spki)),
      publicKeyAlgorithm: -7
    }
  };
}

export async function createAssertion(input: PasskeyAssertionInput): Promise<{ response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string }; signCount: number }> {
  const rpId = validateRpId(input.origin, input.rpId);
  assertChallenge(input.challenge);
  const privateKey = await crypto.subtle.importKey("pkcs8", arrayBuffer(fromBase64(input.privateKeyPkcs8)), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // Monica Passkeys are portable and may be restored on multiple devices.
  // A constant zero counter is permitted by WebAuthn and avoids false clone
  // detection when restored copies would otherwise advance independently.
  const nextCount = 0;
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  const flags = 0x19 | (input.userVerified ? 0x04 : 0);
  const authenticatorData = concat(rpHash, Uint8Array.of(flags), uint32(nextCount));
  const clientDataJSON = clientData("webauthn.get", input.challenge, input.origin);
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer(clientDataJSON)));
  const rawSignature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, arrayBuffer(concat(authenticatorData, clientHash))));
  return {
    response: {
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(ecdsaRawToDer(rawSignature)),
      userHandle: input.userHandle
    },
    signCount: nextCount
  };
}

export function normalizeRpId(value: string): string {
  const trimmed = value.trim().replace(/\.+$/, "");
  if (!trimmed) return "";
  if (/[\/@?#%]/.test(trimmed)) return "";
  const ipv6 = /^\[[0-9a-f:.]+\]$/i.test(trimmed);
  if (trimmed.includes(":") && !ipv6) return "";
  try {
    const parsed = new URL(`https://${trimmed}/`);
    if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) return "";
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    if (isLoopbackRpId(hostname) || parseDomain(hostname).isIp) return hostname;
    return hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? hostname : "";
  } catch {
    return "";
  }
}

function isLoopbackRpId(value: string): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "[::1]";
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

function assertChallenge(value: string): void {
  if (fromBase64Url(value).length < 16) throw new Error("WebAuthn challenge 太短。");
}

function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error("ES256 签名长度无效。");
  const integer = (part: Uint8Array) => {
    let start = 0;
    while (start < part.length - 1 && part[start] === 0) start += 1;
    const body = part.slice(start);
    const positive = body[0] & 0x80 ? concat(Uint8Array.of(0), body) : body;
    return concat(Uint8Array.of(0x02, positive.length), positive);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

function encodeCbor(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  if (typeof value === "string") { const bytes = new TextEncoder().encode(value); return concat(cborHead(3, bytes.length), bytes); }
  if (typeof value === "number" && Number.isInteger(value)) return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (value instanceof Map) {
    const entries = [...value.entries()];
    return concat(cborHead(5, entries.length), ...entries.flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)]));
  }
  throw new Error("不支持的 CBOR 值。");
}

function cborHead(major: number, length: number): Uint8Array {
  if (length < 24) return Uint8Array.of((major << 5) | length);
  if (length < 256) return Uint8Array.of((major << 5) | 24, length);
  if (length < 65536) return concat(Uint8Array.of((major << 5) | 25), uint16(length));
  return concat(Uint8Array.of((major << 5) | 26), uint32(length));
}

function uint16(value: number): Uint8Array { return Uint8Array.of((value >>> 8) & 255, value & 255); }
function uint32(value: number): Uint8Array { return Uint8Array.of((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255); }
function concat(...arrays: Uint8Array[]): Uint8Array { const output = new Uint8Array(arrays.reduce((sum, item) => sum + item.length, 0)); let offset = 0; for (const item of arrays) { output.set(item, offset); offset += item.length; } return output; }
function arrayBuffer(bytes: Uint8Array): ArrayBuffer { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; }
export function toBase64Url(bytes: Uint8Array): string { return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
export function fromBase64Url(value: string): Uint8Array { return fromBase64(value.replace(/-/g, "+").replace(/_/g, "/")); }
function toBase64(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function fromBase64(value: string): Uint8Array { const normalized = value + "=".repeat((4 - value.length % 4) % 4); const binary = atob(normalized); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
