import { describe, expect, it } from "vitest";
import { normalizeImportedVaultItem } from "./import-items";

describe("manager vault import", () => {
  it("accepts and normalizes non-login records", () => {
    expect(normalizeImportedVaultItem({ kind: "card", id: "card", title: "Visa", number: 4111, securityCode: 123 })).toMatchObject({ kind: "card", number: "4111", securityCode: "123", providerRefs: [] });
    expect(normalizeImportedVaultItem({ kind: "passkey", id: "pk", title: "Example", rpId: "example.com", sourceMode: "android-metadata-only", algorithm: -7 })).toMatchObject({ kind: "passkey", rpId: "example.com", sourceMode: "android-metadata-only" });
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
