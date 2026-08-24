export const SSH_RSA_ALLOWED_KEY_SIZES: readonly number[] = [2048, 3072, 4096];
export const SSH_DEFAULT_ALGORITHM = "ED25519";
export const SSH_DEFAULT_RSA_KEY_SIZE = 3072;
const OPENSSH_MAGIC = "openssh-key-v1\0";

export type SshKeyAlgorithm = "ED25519" | "RSA";

export interface SshKeyPairData {
  algorithm: SshKeyAlgorithm;
  keySize: number;
  publicKeyOpenSsh: string;
  privateKeyOpenSsh: string;
  fingerprintSha256: string;
  comment: string;
  format: "OPENSSH";
}

export interface GenerateSshKeyPairOptions {
  algorithm?: SshKeyAlgorithm;
  rsaKeySize?: number;
  comment?: string;
}

class SshBuffer {
  private readonly chunks: number[] = [];

  uint32(value: number): this {
    this.chunks.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
    return this;
  }

  string(value: Uint8Array | string): this {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    return this.uint32(bytes.length).push(bytes);
  }

  push(bytes: Uint8Array): this {
    for (const byte of bytes) this.chunks.push(byte);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

export function encodeSshMpint(value: Uint8Array): Uint8Array {
  let start = 0;
  while (start < value.length && value[start] === 0) start += 1;
  const stripped = value.subarray(start);
  if (!stripped.length) return new Uint8Array(0);
  return stripped[0] & 0x80 ? Uint8Array.from([0, ...stripped]) : stripped;
}

function randomUint32(): number {
  const values = new Uint32Array(1);
  do crypto.getRandomValues(values); while (values[0] === 0);
  return values[0];
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  return btoa(binary);
}

function formatOpenSshPublicKeyLine(prefix: string, publicBlob: Uint8Array, comment: string): string {
  return comment ? `${prefix} ${toBase64(publicBlob)} ${comment}` : `${prefix} ${toBase64(publicBlob)}`;
}

function formatPemPrivateKey(container: Uint8Array): string {
  const base64 = toBase64(container);
  const lines: string[] = [];
  for (let index = 0; index < base64.length; index += 70) lines.push(base64.slice(index, index + 70));
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function buildContainer(publicPrefix: string, publicFields: Uint8Array[], privateKeyType: string, privateFields: Uint8Array[], comment: string): { publicBlob: Uint8Array; container: Uint8Array } {
  const publicBlob = new SshBuffer().string(publicPrefix);
  for (const field of publicFields) publicBlob.string(field);

  const check = randomUint32();
  const privateSection = new SshBuffer().uint32(check).uint32(check).string(privateKeyType);
  for (const field of privateFields) privateSection.string(field);
  privateSection.string(comment);
  const built = privateSection.build();
  const paddingLength = (8 - (built.length % 8)) % 8;
  const padded = concatenate(built, Uint8Array.from({ length: paddingLength }, (_, index) => index + 1));

  const container = new SshBuffer()
    .push(new TextEncoder().encode(OPENSSH_MAGIC))
    .string("none")
    .string("none")
    .string(new Uint8Array(0))
    .uint32(1)
    .string(publicBlob.build())
    .string(padded);
  return { publicBlob: publicBlob.build(), container: container.build() };
}

async function generateEd25519(comment: string): Promise<SshKeyPairData> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" } as AlgorithmIdentifier, true, ["sign", "verify"]) as CryptoKeyPair;
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const seed = pkcs8.subarray(pkcs8.length - 32);
  const privateKeyMaterial = concatenate(seed, rawPublic);
  const { publicBlob, container } = buildContainer("ssh-ed25519", [rawPublic], "ssh-ed25519", [rawPublic, privateKeyMaterial], comment);
  const fingerprint = await sha256Fingerprint(publicBlob);
  return { algorithm: "ED25519", keySize: 256, publicKeyOpenSsh: formatOpenSshPublicKeyLine("ssh-ed25519", publicBlob, comment), privateKeyOpenSsh: formatPemPrivateKey(container), fingerprintSha256: fingerprint, comment, format: "OPENSSH" };
}

async function generateRsa(modulusLength: number, comment: string): Promise<SshKeyPairData> {
  if (!SSH_RSA_ALLOWED_KEY_SIZES.includes(modulusLength)) throw new Error(`RSA key size must be one of ${SSH_RSA_ALLOWED_KEY_SIZES.join(", ")}, got ${modulusLength}`);
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const modulus = sshBytes(jwk.n!);
  const exponent = sshBytes(jwk.e!);
  const d = sshBytes(jwk.d!);
  const iqmp = sshBytes(jwk.qi!);
  const p = sshBytes(jwk.p!);
  const q = sshBytes(jwk.q!);
  const { publicBlob, container } = buildContainer("ssh-rsa", [encodeSshMpint(exponent), encodeSshMpint(modulus)], "ssh-rsa", [encodeSshMpint(modulus), encodeSshMpint(exponent), encodeSshMpint(d), encodeSshMpint(iqmp), encodeSshMpint(p), encodeSshMpint(q)], comment);
  const fingerprint = await sha256Fingerprint(publicBlob);
  return { algorithm: "RSA", keySize: modulusLength, publicKeyOpenSsh: formatOpenSshPublicKeyLine("ssh-rsa", publicBlob, comment), privateKeyOpenSsh: formatPemPrivateKey(container), fingerprintSha256: fingerprint, comment, format: "OPENSSH" };
}

export async function generateSshKeyPair(options: GenerateSshKeyPairOptions = {}): Promise<SshKeyPairData> {
  const comment = (options.comment ?? "").trim();
  return options.algorithm === "RSA" ? generateRsa(options.rsaKeySize ?? SSH_DEFAULT_RSA_KEY_SIZE, comment) : generateEd25519(comment);
}

async function sha256Fingerprint(publicBlob: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(publicBlob);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return "SHA256:" + toBase64(digest).replace(/=+$/, "");
}

function sshBytes(base64Url: string): Uint8Array {
  const normalized = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
}
