import { describe, expect, it } from "vitest";
import { androidEncryptedBackupFromBase64, androidEncryptedBackupToBase64, decryptAndroidBackup, encryptAndroidBackup, isAndroidEncryptedBackup } from "./android-backup-crypto";

const DOTNET_ANDROID_VECTOR = "TU9OSUNBX0VOQ19WMQABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorf92VPsTf5jc1z/90TyR4z1A4Mkss0qToLbmxbfD94e30aHe+uEA=";

describe("Monica Android backup encryption", () => {
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
});
