import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../../security/encoding";
import {
  decryptBitwardenString,
  decryptBitwardenRsaBytes,
  deriveBitwardenMasterKey,
  deriveBitwardenMasterPasswordHash,
  encryptBitwardenString,
  parseBitwardenCipherString,
  stretchBitwardenMasterKey,
  type BitwardenSymmetricKey
} from "./bitwarden-crypto";

const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery staple";

describe("Bitwarden cryptography", () => {
  it("matches independent Python PBKDF2 and master-password-hash vectors", async () => {
    const masterKey = await deriveBitwardenMasterKey(PASSWORD, `  ALICE@EXAMPLE.COM `, { type: 0, iterations: 100_000 });
    expect(bytesToBase64(masterKey)).toBe("yyNf0SM+zSddHcJ0TqZU9/iKPsCXmxvKDExYARL2TmM=");
    await expect(deriveBitwardenMasterPasswordHash(masterKey, PASSWORD)).resolves.toBe("ij4bpg+9sHwyc9ipLMipC5BiUug2hc9KWk8nXWxhz2o=");
    const stretched = await stretchBitwardenMasterKey(masterKey);
    expect(bytesToBase64(stretched.encKey)).toBe("pbZmao2B5azDvA+Kk4hTswj6gZVLL1nygZKtmA/Mql8=");
    expect(bytesToBase64(stretched.macKey)).toBe("I0rttTQyvxSy+G/GLXcsJZM4Fb2olGLWWHmeEZXhHy8=");
  });

  it("matches an independent Argon2id v1.3 vector using Bitwarden's hashed email salt", async () => {
    const masterKey = await deriveBitwardenMasterKey(PASSWORD, EMAIL, { type: 1, iterations: 3, memoryMb: 64, parallelism: 4 });
    expect(bytesToBase64(masterKey)).toBe("nr0yQbvfjo6pjGGgb0bWQKGX04OMrA0kM2l7aXQVBHk=");
  });

  it("decrypts an independent AES-CBC-HMAC vector and emits the same deterministic CipherString", async () => {
    const key: BitwardenSymmetricKey = { encKey: Uint8Array.from({ length: 32 }, (_, index) => index), macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 32) };
    const vector = "2.QEFCQ0RFRkdISUpLTE1OTw==|lcCAvrsTM4NpNoS0mMkKZM7cIEKWe5pOvTtdrfDSqvA=|RDhDIlSvSE98/5acvdCVpNf4Kx5AO4gaIkRjKf0lluk=";
    await expect(decryptBitwardenString(vector, key)).resolves.toBe("Bitwarden fixture 中文");
    const iv = base64ToBytes("QEFCQ0RFRkdISUpLTE1OTw==");
    await expect(encryptBitwardenString("Bitwarden fixture 中文", key, () => iv)).resolves.toBe(vector);
  });

  it("rejects unsupported types and a modified MAC before decryption", async () => {
    expect(() => parseBitwardenCipherString("1.bad|bad")).toThrow("不支持");
    const key: BitwardenSymmetricKey = { encKey: new Uint8Array(32), macKey: new Uint8Array(32) };
    const cipher = await encryptBitwardenString("secret", key, () => new Uint8Array(16));
    const parts = cipher.split("|");
    const mac = base64ToBytes(parts[2]);
    mac[0] ^= 1;
    const tampered = `${parts[0]}|${parts[1]}|${bytesToBase64(mac)}`;
    await expect(decryptBitwardenString(tampered, key)).rejects.toThrow("MAC");
  });

  it("decrypts Bitwarden RSA-OAEP organization-key CipherStrings", async () => {
    const plaintext = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
    for (const [type, hash] of [[3, "SHA-256"], [4, "SHA-1"]] as const) {
      const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash }, true, ["encrypt", "decrypt"]);
      const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, plaintext));
      await expect(decryptBitwardenRsaBytes(`${type}.${bytesToBase64(encrypted)}`, privateKey)).resolves.toEqual(plaintext);
    }
  });

  it("rejects malformed or unsupported RSA CipherStrings", async () => {
    const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
    const privateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    await expect(decryptBitwardenRsaBytes("2.invalid", privateKey)).rejects.toThrow("RSA");
    await expect(decryptBitwardenRsaBytes("3.AA==", privateKey)).rejects.toThrow("RSA");
  });
});
