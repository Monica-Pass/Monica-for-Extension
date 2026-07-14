import { describe, expect, it } from "vitest";
import { normalizeImportedVaultItem } from "./import-items";

describe("manager vault import", () => {
  it("accepts and normalizes non-login records", () => {
    expect(normalizeImportedVaultItem({ kind: "card", id: "card", title: "Visa", number: 4111, securityCode: 123 })).toMatchObject({ kind: "card", number: "4111", securityCode: "123", providerRefs: [] });
    expect(normalizeImportedVaultItem({ kind: "passkey", id: "pk", title: "Example", rpId: "example.com", sourceMode: "android-metadata-only", algorithm: -7 })).toMatchObject({ kind: "passkey", rpId: "example.com", sourceMode: "android-metadata-only" });
  });

  it("rejects unknown kinds and malformed roots", () => {
    expect(normalizeImportedVaultItem({ kind: "unknown" })).toBeNull();
    expect(normalizeImportedVaultItem(null)).toBeNull();
  });
});
