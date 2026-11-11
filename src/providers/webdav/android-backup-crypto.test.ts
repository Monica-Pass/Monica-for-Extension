import { afterEach, describe, expect, it, vi } from "vitest";
import { androidEncryptedBackupFromBase64, androidEncryptedBackupToBase64, decryptAndroidBackup, encryptAndroidBackup, getAndroidBackupEncryptionFormat, isAndroidEncryptedBackup } from "./android-backup-crypto";
import vectors from "../../../tests/fixtures/portable-backup-encryption-vectors.json";

const DOTNET_ANDROID_VECTOR = "TU9OSUNBX0VOQ19WMQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorf92VPsTf5jc1z/90TyR4z1A4Mkss0qToLbmxbfD94e30aHe+uEA=";

describe("Monica Android backup encryption", () => {
  afterEach(() => vi.restoreAllMocks());
  const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
  for (const vector of vectors.vectors) {
    it(`matches the independent Python/Java ${vector.id} envelope in both directions`, async () => {
      const envelope = hex(vector.envelopeHex), plaintext = hex(vector.plaintextHex);
      expect(getAndroidBackupEncryptionFormat(envelope)).toBe(`v${vector.version}`);
      await expect(decryptAndroidBackup(envelope, vector.password)).resolves.toEqual(plaintext);
      await expect(encryptAndroidBackup(plaintext, vector.password,
        length => hex(length === 32 ? vector.saltHex : vector.nonceHex), undefined, vector.version === 2 ? "v2" : "v1"))
        .resolves.toEqual(envelope);
    });
  }

  it("rejects every unsupported V2 profile byte before deriving a key", async () => {
    const derive = vi.spyOn(crypto.subtle, "importKey");
    const original = hex(vectors.vectors.find(vector => vector.id === "ascii-v2")!.envelopeHex);
    for (let offset = 13; offset < 24; offset++) {
      const mutated = original.slice(); mutated[offset] ^= 1;
      await expect(decryptAndroidBackup(mutated, "Synthetic backup password")).rejects.toThrow("加密参数");
    }
    expect(derive).not.toHaveBeenCalled();
  });

  it("rejects unknown family versions, truncation, and invalid costs before cryptography", async () => {
    const derive = vi.spyOn(crypto.subtle, "importKey");
    for (const version of ["MONICA_ENC_V", "MONICA_ENC_V0", "MONICA_ENC_V3", "MONICA_ENC_V9"]) {
      const bytes = new TextEncoder().encode(version);
      expect(isAndroidEncryptedBackup(bytes)).toBe(true);
      await expect(decryptAndroidBackup(bytes, "synthetic")).rejects.toThrow("加密版本");
    }
    const envelope = hex(vectors.vectors.find(vector => vector.id === "ascii-v2")!.envelopeHex);
    for (const length of [13, 23, 67, 68, 83]) await expect(decryptAndroidBackup(envelope.slice(0, length), "synthetic")).rejects.toThrow("不完整");
    for (const cost of [0, 100000, 599999, 600001, 0xffffffff]) {
      const changed = envelope.slice(); new DataView(changed.buffer).setUint32(16, cost, false);
      await expect(decryptAndroidBackup(changed, "synthetic")).rejects.toThrow("加密参数");
    }
    expect(derive).not.toHaveBeenCalled();
  });

  it("authenticates salt, nonce, ciphertext and tag without falling back to V1", async () => {
    const vector = vectors.vectors.find(vector => vector.id === "ascii-v2")!;
    const bytes = hex(vector.envelopeHex);
    for (const offset of [24, 55, 56, 67, 68, bytes.length - 1]) {
      const changed = bytes.slice(); changed[offset] ^= 1;
      await expect(decryptAndroidBackup(changed, vector.password)).rejects.toThrow("密码错误或文件已损坏");
    }
    await expect(decryptAndroidBackup(bytes, "wrong")).rejects.toThrow("密码错误");
    const changed = bytes.slice(); changed[12] = 0x31;
    await expect(decryptAndroidBackup(changed, vector.password)).rejects.toThrow("密码错误");
    expect(bytes).toEqual(hex(vector.envelopeHex));
  });

  it("preserves Unicode normalization and whitespace and rejects unpaired V2 surrogates", async () => {
    const vector = vectors.vectors.find(vector => vector.id === "unicode-v2")!;
    const envelope = hex(vector.envelopeHex);
    for (const password of [vector.password.trim(), vector.password.normalize("NFC")]) {
      await expect(decryptAndroidBackup(envelope, password)).rejects.toThrow("密码错误");
    }
    const derive = vi.spyOn(crypto.subtle, "importKey");
    for (const password of ["\ud800", "\udc00", "\ud800a", "a\udc00"]) {
      await expect(decryptAndroidBackup(envelope, password)).rejects.toThrow("Unicode");
      await expect(encryptAndroidBackup(Uint8Array.of(1), password, undefined, undefined, "v2")).rejects.toThrow("Unicode");
    }
    expect(derive).not.toHaveBeenCalled();
  });

  it("bounds V2 using its exact overhead and uses fresh salt and nonce", async () => {
    const plain = Uint8Array.of(1, 2, 3, 4);
    const first = await encryptAndroidBackup(plain, "synthetic", undefined, 4, "v2");
    const second = await encryptAndroidBackup(plain, "synthetic", undefined, 4, "v2");
    expect(first.length).toBe(plain.length + 84);
    expect(first.slice(24, 56)).not.toEqual(second.slice(24, 56));
    expect(first.slice(56, 68)).not.toEqual(second.slice(56, 68));
    await expect(decryptAndroidBackup(first, "synthetic", 4)).resolves.toEqual(plain);
    const derive = vi.spyOn(crypto.subtle, "importKey");
    await expect(decryptAndroidBackup(first, "synthetic", 3)).rejects.toThrow("安全上限");
    await expect(encryptAndroidBackup(plain, "synthetic", undefined, 3, "v2")).rejects.toThrow("安全上限");
    expect(derive).not.toHaveBeenCalled();
  });
  it("matches an independently generated Java-compatible AES-GCM vector", async () => {
    const salt = Uint8Array.from({ length: 32 }, (_, index) => index);
    const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 32);
    const encrypted = await encryptAndroidBackup(
      new TextEncoder().encode("Monica Android fixture"),
      "android-compatible",
      (length) => (length === 32 ? salt : iv)
    );
    expect(androidEncryptedBackupToBase64(encrypted)).toBe(DOTNET_ANDROID_VECTOR);
    await expect(decryptAndroidBackup(androidEncryptedBackupFromBase64(DOTNET_ANDROID_VECTOR), "android-compatible")).resolves.toEqual(new TextEncoder().encode("Monica Android fixture"));
  });

  it("detects encrypted files and rejects a wrong password", async () => {
    const encrypted = androidEncryptedBackupFromBase64(DOTNET_ANDROID_VECTOR);
    expect(isAndroidEncryptedBackup(encrypted)).toBe(true);
    await expect(decryptAndroidBackup(encrypted, "wrong")).rejects.toThrow("密码错误");
  });

  it("passes plain ZIP bytes through unchanged", async () => {
    const plain = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
    await expect(decryptAndroidBackup(plain, "")).resolves.toEqual(plain);
  });

  it("rejects oversized plaintext and encrypted envelopes before expensive cryptography", async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    await expect(encryptAndroidBackup(bytes, "password", undefined, 3)).rejects.toThrow("明文超过安全上限");
    await expect(decryptAndroidBackup(bytes, "", 3)).rejects.toThrow("备份超过安全上限");
  });
});
