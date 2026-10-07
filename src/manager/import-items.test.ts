import { describe, expect, it } from "vitest";
import { normalizeImportedVaultItem } from "./import-items";

describe("manager vault import", () => {
  it("retains stable SSO account identity in extension snapshots", () => {
    expect(normalizeImportedVaultItem({ kind: "login", id: "sso", ssoRefLogicalId: "password:account" })).toMatchObject({ ssoRefLogicalId: "password:account" });
  });
  it("preserves an explicit OTP unlink through extension JSON without changing legacy records", () => {
    expect(normalizeImportedVaultItem({ kind: "login", id: "unlinked", boundTotpItemId: "" })).toMatchObject({ boundTotpItemId: "" });
    expect(normalizeImportedVaultItem({ kind: "login", id: "legacy" })).toMatchObject({ boundTotpItemId: undefined });
  });

  it("accepts and normalizes non-login records", () => {
    expect(normalizeImportedVaultItem({ kind: "card", id: "card", title: "Visa", number: 4111, securityCode: 123 })).toMatchObject({ kind: "card", number: "4111", securityCode: "123", providerRefs: [] });
    expect(normalizeImportedVaultItem({ kind: "passkey", id: "pk", title: "Example", rpId: "example.com", sourceMode: "android-metadata-only", algorithm: -7 })).toMatchObject({ kind: "passkey", rpId: "example.com", sourceMode: "android-metadata-only" });
    expect(normalizeImportedVaultItem({ kind: "totp", id: "yaotp", title: "Yandex", secret: "Q3GXYNZ7INQOWXTVKGKYBLKDU4", otpType: "YANDEX", pin: "0012", pinLength: "4" })).toMatchObject({ kind: "totp", otpType: "YANDEX", pin: "0012", pinLength: 4 });
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

  it("shows unknown kinds readonly and rejects malformed roots", () => {
    expect(normalizeImportedVaultItem({ kind: "future-key", payloadSchemaVersion: 31501 })).toMatchObject({ kind: "opaque", payloadSchemaVersion: 31501 });
    expect(normalizeImportedVaultItem({ kind: "unknown" })).toMatchObject({ kind: "opaque", nativeType: "unknown", originalPayload: '{"kind":"unknown"}' });
    expect(normalizeImportedVaultItem(null)).toBeNull();
  });

  it.each(["GPG_KEY", "API_KEY", "STEAM_MAFILE"])("preserves the %s login subtype and all known extended fields", (loginType) => {
    const fields = { loginType, creditCardNumber: "000123", creditCardHolder: "合成", creditCardExpiry: "01/30", creditCardCVV: "007", steamAccountName: "account", steamDisplayName: "display", steamDeviceId: "device", steamSharedSecretBase64: " AQID== ", steamId: "76561198000000001", steamAccessToken: " token ", steamRefreshToken: "refresh", steamLoginSecure: "cookie", steamRevocationCode: "recovery", steamIdentitySecret: "identity", steamTokenGid: "gid", steamRawJson: ' {"future":null} ', passwordHistory: [{ password: " old ", lastUsedAt: "2026-09-29T00:00:00Z", future: true }] };
    expect(normalizeImportedVaultItem({ kind: "login", ...fields })).toMatchObject(fields);
  });

  it("retains notes fields, complete card faces, document title, optional nulls and ordinary unknown data", () => {
    const cardFace = { imageAttachmentName: "wallet-test", displayMode: "HIDDEN", showBrandIcon: false, future: { enabled: false, value: null } };
    const customFields = [{ name: "Boolean", value: "false", protected: false, fieldType: "BOOLEAN", future: "preserved" }];
    expect(normalizeImportedVaultItem({ kind: "secure-note", content: "body", customFields, future: [null, 0, false, ""] })).toMatchObject({ customFields, future: [null, 0, false, ""] });
    expect(normalizeImportedVaultItem({ kind: "card", cardFace, iban: null })).toMatchObject({ cardFace, iban: null });
    expect(normalizeImportedVaultItem({ kind: "identity", cardFace, documentTitle: "Dr.", address: { future: "kept" } })).toMatchObject({ cardFace, documentTitle: "Dr.", address: { future: "kept" } });
    expect(normalizeImportedVaultItem({ kind: "billing-address", cardFace: null })).toMatchObject({ cardFace: null });
    expect(normalizeImportedVaultItem({ kind: "passkey", signCountHighWaterMark: 27 })).toMatchObject({ signCountHighWaterMark: 27 });
  });

  it("retains unfamiliar login subtypes and incompatible shapes as readonly instead of PASSWORD", () => {
    for (const raw of [{ kind: "login", loginType: "FUTURE_KEY" }, { kind: "login", sshKeyData: { future: true } }, { kind: "totp", otpType: "FUTURE_OTP" },
      { kind: "login", uris: [{ uri: "unsupported shape" }] }, { kind: "login", uriRules: [{ uri: "example.invalid", matchType: "future-rule" }] },
      { kind: "passkey", signCount: "9007199254740993" }]) {
      expect(normalizeImportedVaultItem(raw)).toMatchObject({ kind: "opaque", originalPayload: JSON.stringify(raw) });
    }
  });

  it("does not convert unknown exact numbers into rounded cache values", async () => {
    const { parseLosslessJson } = await import("../core/lossless-json");
    const raw = parseLosslessJson('{"kind":"login","future":{"counter":9007199254740993,"precise":0.1234567890123456789}}');
    const item = normalizeImportedVaultItem(raw);
    expect(item?.kind).toBe("opaque");
    if (item?.kind !== "opaque") throw new Error("Expected readonly item");
    expect(item.originalPayload).toContain('"counter":9007199254740993');
    expect(item.originalPayload).toContain('"precise":0.1234567890123456789');
    const hotp = normalizeImportedVaultItem(parseLosslessJson('{"kind":"totp","otpType":"HOTP","counter":9007199254740993}'));
    expect(hotp).toMatchObject({ kind: "totp", counter: "9007199254740993" });
  });
});
