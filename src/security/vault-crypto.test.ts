import { describe, expect, it } from "vitest";
import { deriveVaultKey, exportVaultKey, vaultKdfNeedsUpgrade, type Argon2idVaultKdfParameters, type Pbkdf2VaultKdfParameters } from "./vault-crypto";

const ARGON_VECTOR: Argon2idVaultKdfParameters = {
  name: "ARGON2ID",
  iterations: 3,
  memoryKiB: 64 * 1024,
  parallelism: 1,
  salt: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
};

describe("vault key derivation", () => {
  it("matches an independent Python Argon2id v1.3 vector", async () => {
    const { key, kdf } = await deriveVaultKey("vault argon2 vector password", ARGON_VECTOR);
    expect(await exportVaultKey(key)).toBe("C7IPm6/h7sf+kCLfEmjU2YLn7bCneJerT8jAEkl6cq0=");
    expect(kdf).toEqual(ARGON_VECTOR);
    expect(vaultKdfNeedsUpgrade(kdf)).toBe(false);
  });

  it("keeps bounded PBKDF2 parameters readable only as a legacy migration source", async () => {
    const legacy: Pbkdf2VaultKdfParameters = {
      name: "PBKDF2-SHA256",
      iterations: 600_000,
      salt: ARGON_VECTOR.salt
    };
    await expect(deriveVaultKey("legacy vault password", legacy)).resolves.toMatchObject({ kdf: legacy });
    expect(vaultKdfNeedsUpgrade(legacy)).toBe(true);
  });

  it("rejects attacker-controlled Argon2 resource parameters before derivation", async () => {
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, memoryKiB: 18 * 1024 })).rejects.toThrow("KDF parameters");
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, memoryKiB: 129 * 1024 })).rejects.toThrow("KDF parameters");
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, iterations: 7 })).rejects.toThrow("KDF parameters");
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, parallelism: 5 })).rejects.toThrow("KDF parameters");
    await expect(deriveVaultKey("password", { ...ARGON_VECTOR, memoryKiB: 128 * 1024, iterations: 4 })).rejects.toThrow("KDF parameters");
    expect(vaultKdfNeedsUpgrade({ ...ARGON_VECTOR, memoryKiB: 19 * 1024, iterations: 1 })).toBe(true);
  });
});
