import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../../security/encoding";
import {
  assertMdbxCredentialShape,
  bytesEqual,
  decryptMdbxField,
  deriveMdbxCredentialKey,
  encryptMdbxField,
  generateMdbxKeyFile,
  isMdbxEncryptedField,
  isMdbxKeyFile,
  mdbxIterationsFrom,
  mdbxKdfProfileFor,
  mdbxUnlockMethodFrom,
  mdbxVerifier,
  unwrapMdbxEpochKey,
  wrapMdbxEpochKey
} from "./mdbx-crypto";

const SALT = base64ToBytes("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=");
const PASSWORD = "mdbx golden vector password";
const KEY_FILE = new Uint8Array([...new TextEncoder().encode("MONICA-MDBX-KEY-FILE-V1\n"), ...new Uint8Array(64).fill(7)]);

describe("mdbx credential derivation", () => {
  it("matches independent vectors for every unlock method", async () => {
    const password = await deriveMdbxCredentialKey({ unlockMethod: "password", password: PASSWORD }, SALT, 90_000);
    const combined = await deriveMdbxCredentialKey({ unlockMethod: "password+key_file", password: PASSWORD, keyFile: KEY_FILE }, SALT, 90_000);
    const device = await deriveMdbxCredentialKey({ unlockMethod: "device_key" }, SALT, 90_000);

    expect(bytesToBase64(password)).toBe("jOniDcPXyv53viY1z+N9npHzukHMEn1UkKn5a0v7KVQ=");
    expect(bytesToBase64(combined)).toBe("JAXiaippy+0rIlphc31oHKKGZtYrC03qFlAxvZeTKDY=");
    expect(bytesToBase64(device)).toBe("yYTHKifgfsvSU6Y1Cs4kNTxTd+iWEOO+aZ8rvmLZmxU=");
  });

  it("derives a different key when only the unlock method changes", async () => {
    const asPassword = await deriveMdbxCredentialKey({ unlockMethod: "password", password: PASSWORD }, SALT, 90_000);
    const asDevice = await deriveMdbxCredentialKey({ unlockMethod: "device_key", password: PASSWORD }, SALT, 90_000);

    expect(bytesEqual(asPassword, asDevice)).toBe(false);
  });

  it("produces the documented HMAC verifier", async () => {
    const key = await deriveMdbxCredentialKey({ unlockMethod: "password", password: PASSWORD }, SALT, 90_000);

    expect(bytesToBase64(await mdbxVerifier(key, "vault-golden"))).toBe("yRlrAMwBHHzgHbJut8egNbEELpypjGDvyZzt8NF+lDw=");
  });

  it("requires the inputs its unlock method declares", () => {
    expect(() => assertMdbxCredentialShape({ unlockMethod: "password" })).toThrow("主密码");
    expect(() => assertMdbxCredentialShape({ unlockMethod: "key_file" })).toThrow("密钥文件");
    expect(() => assertMdbxCredentialShape({ unlockMethod: "password+key_file", password: PASSWORD })).toThrow("密钥文件");
    expect(() => assertMdbxCredentialShape({ unlockMethod: "device_key" })).not.toThrow();
  });

  it("reads unlock methods case-insensitively and falls back like Android", () => {
    expect(mdbxUnlockMethodFrom("KEY_FILE")).toBe("key_file");
    expect(mdbxUnlockMethodFrom("password+key_file")).toBe("password+key_file");
    expect(mdbxUnlockMethodFrom("DEVICE_KEY")).toBe("device_key");
    expect(mdbxUnlockMethodFrom("something-new")).toBe("password");
    expect(mdbxUnlockMethodFrom(undefined)).toBe("password");
  });
});

describe("mdbx kdf profile", () => {
  it("reads the iteration count from the file rather than the Tiga mode", () => {
    expect(mdbxKdfProfileFor("POWER")).toBe("pbkdf2-sha256:360000");
    expect(mdbxIterationsFrom("pbkdf2-sha256:123456")).toBe(123_456);
  });

  it("clamps a hostile or malformed profile instead of running unbounded PBKDF2", () => {
    expect(mdbxIterationsFrom("pbkdf2-sha256:1")).toBe(50_000);
    expect(mdbxIterationsFrom("pbkdf2-sha256:999999999")).toBe(1_000_000);
    expect(mdbxIterationsFrom("argon2id:3")).toBe(210_000);
    expect(mdbxIterationsFrom(null)).toBe(210_000);
  });
});

describe("mdbx envelopes", () => {
  it("round-trips an epoch key through the nonce/ct envelope", async () => {
    const credentialKey = await deriveMdbxCredentialKey({ unlockMethod: "device_key" }, SALT, 50_000);
    const epochKey = new Uint8Array(32).fill(3);

    const wrapped = await wrapMdbxEpochKey(credentialKey, epochKey);

    expect(JSON.parse(new TextDecoder().decode(wrapped))).toMatchObject({ v: 1, alg: "AES-256-GCM" });
    expect(await unwrapMdbxEpochKey(credentialKey, wrapped)).toEqual(epochKey);
  });

  it("round-trips a field through the n/c envelope under the mdbx:v1: prefix", async () => {
    const epochKey = new Uint8Array(32).fill(9);

    const encrypted = await encryptMdbxField(epochKey, "https://example.test");

    expect(new TextDecoder().decode(encrypted).startsWith("mdbx:v1:")).toBe(true);
    expect(isMdbxEncryptedField(encrypted)).toBe(true);
    expect(await decryptMdbxField(epochKey, encrypted)).toBe("https://example.test");
  });

  it("reads a plaintext column value that Android wrote without an epoch key", async () => {
    const plaintext = new TextEncoder().encode("未加密的标题");

    expect(isMdbxEncryptedField(plaintext)).toBe(false);
    expect(await decryptMdbxField(undefined, plaintext)).toBe("未加密的标题");
    expect(await encryptMdbxField(undefined, "未加密的标题")).toEqual(plaintext);
  });

  it("refuses to silently return ciphertext as plaintext when the vault is locked", async () => {
    const encrypted = await encryptMdbxField(new Uint8Array(32).fill(9), "secret");

    await expect(decryptMdbxField(undefined, encrypted)).rejects.toThrow("已解锁");
  });
});

describe("mdbx key file", () => {
  it("generates and recognises the Monica key file magic", () => {
    const generated = generateMdbxKeyFile();

    expect(generated.length).toBe(24 + 64);
    expect(isMdbxKeyFile(generated)).toBe(true);
    expect(isMdbxKeyFile(new TextEncoder().encode("not a key file"))).toBe(false);
  });
});
