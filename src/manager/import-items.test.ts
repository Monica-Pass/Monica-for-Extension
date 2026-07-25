import { describe, expect, it } from "vitest";
import { normalizeImportedVaultItem } from "./import-items";

describe("manager vault import", () => {
  it("accepts and normalizes non-login records", () => {
    expect(normalizeImportedVaultItem({ kind: "card", id: "card", title: "Visa", number: 4111, securityCode: 123 })).toMatchObject({ kind: "card", number: "4111", securityCode: "123", providerRefs: [] });
    expect(normalizeImportedVaultItem({ kind: "passkey", id: "pk", title: "Example", rpId: "example.com", sourceMode: "android-metadata-only", algorithm: -7 })).toMatchObject({ kind: "passkey", rpId: "example.com", sourceMode: "android-metadata-only" });
  });

  it("preserves all Passkey compatibility metadata from extension JSON", () => {
    expect(normalizeImportedVaultItem({
      kind: "passkey", id: "pk-meta", title: "Example", rpId: "example.com", algorithm: -257, keyAlgorithm: "RS256",
      userVerificationRequired: true, transports: ["internal", "hybrid"], aaguid: "aaguid", lastUsedAt: "2026-07-20T01:02:03.000Z",
      useCount: 9, iconUrl: "https://example.com/icon.png", boundPasswordId: 42, passkeyMode: "KEEPASS_COMPAT", sourceMode: "android-metadata-only"
    })).toMatchObject({ algorithm: -257, keyAlgorithm: "RS256", userVerificationRequired: true, transports: ["internal", "hybrid"], aaguid: "aaguid", useCount: 9, boundPasswordId: 42, passkeyMode: "KEEPASS_COMPAT" });
  });

  it("restores Android login extensions and URI rules from plain JSON", () => {
    expect(normalizeImportedVaultItem({
      kind: "login", id: "wifi", title: "Lab Wi-Fi", username: "joy", password: "secret", urls: ["example.com"],
      uriRules: [{ uri: "example.com", matchType: "domain" }], loginType: "SSH", ssoProvider: "GOOGLE", ssoRefEntryId: 42,
      wifiMetadata: '{"ssid":"Lab"}', sshKeyData: '{"algorithm":"ED25519"}', customFields: [{ title: "mode", value: "x", isProtected: true }]
    })).toMatchObject({ loginType: "SSH_KEY", uris: ["example.com"], uriRules: [{ uri: "example.com", matchType: "domain" }], ssoProvider: "GOOGLE", ssoRefEntryId: 42, wifiMetadata: '{"ssid":"Lab"}', sshKeyData: '{"algorithm":"ED25519"}', customFields: [{ name: "mode", value: "x", protected: true, fieldType: "HIDDEN" }] });
  });

  it("rejects unknown kinds and malformed roots", () => {
    expect(normalizeImportedVaultItem({ kind: "unknown" })).toBeNull();
    expect(normalizeImportedVaultItem(null)).toBeNull();
  });
});
