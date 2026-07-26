import { describe, expect, it } from "vitest";
import {
  isKeePassTotpField,
  isMonicaOwnedField,
  isPasskeyEntryOverlayField,
  isPasswordEntryOverlayField,
  isPasswordSecretFallbackCandidateField,
  isPreservedByDefault,
  isReservedPasswordProjectionField,
  isSecureItemOverlayField,
  keePassFieldRoleOf,
  normalizeKeePassFieldName
} from "./keepass-field-registry";

/** Assertion semantics translated from Android `KeePassFieldRegistryTest.kt`. */
describe("keePassFieldRoleOf", () => {
  it("classifies KeePass TOTP aliases case-insensitively", () => {
    expect(keePassFieldRoleOf("otp")).toBe("keepass-totp");
    expect(keePassFieldRoleOf("OTP")).toBe("keepass-totp");
    expect(keePassFieldRoleOf("TOTP Seed")).toBe("keepass-totp");
    expect(keePassFieldRoleOf("totpsettings")).toBe("keepass-totp");
    expect(keePassFieldRoleOf("OTP Type")).toBe("keepass-totp");
    expect(keePassFieldRoleOf("HOTP Counter")).toBe("keepass-totp");
    expect(isKeePassTotpField("TOTP Seed")).toBe(true);
    expect(isKeePassTotpField("HOTP Counter")).toBe(true);
  });

  it("separates Monica-owned fields from preserved fields", () => {
    expect(keePassFieldRoleOf("MonicaLocalId")).toBe("monica-password");
    expect(keePassFieldRoleOf("MonicaItemData")).toBe("monica-secure-item");
    expect(keePassFieldRoleOf("MonicaPasskeyData")).toBe("monica-passkey");

    expect(isMonicaOwnedField("MonicaItemData")).toBe(true);
    expect(isMonicaOwnedField("otp")).toBe(false);
    expect(isMonicaOwnedField("KPEX_PASSKEY_CREDENTIAL_ID")).toBe(false);
    expect(isPreservedByDefault("unknown-plugin-field")).toBe(true);
  });

  it("treats plugin and KeePassDX passkey fields as preserved", () => {
    expect(keePassFieldRoleOf("_etm_template")).toBe("keepass-plugin");
    expect(keePassFieldRoleOf("KPEX_PASSKEY_PRIVATE_KEY_PEM")).toBe("keepass-passkey");
    expect(keePassFieldRoleOf("Security question")).toBe("unknown");

    expect(isPreservedByDefault("_etm_template")).toBe(true);
    expect(isPreservedByDefault("KPEX_PASSKEY_PRIVATE_KEY_PEM")).toBe(true);
    expect(isPreservedByDefault("Security question")).toBe(true);
  });

  it("exposes the projection and fallback decisions the write path depends on", () => {
    expect(isReservedPasswordProjectionField("Title")).toBe(true);
    expect(isReservedPasswordProjectionField("otp")).toBe(true);
    expect(isReservedPasswordProjectionField("_etm_template")).toBe(true);
    expect(isReservedPasswordProjectionField("Security question")).toBe(false);

    expect(isPasswordEntryOverlayField("Title")).toBe(true);
    expect(isPasswordEntryOverlayField("MonicaSshPrivateKey")).toBe(true);
    expect(isPasswordEntryOverlayField("MonicaConflictCopy")).toBe(true);
    expect(isPasswordEntryOverlayField("otp")).toBe(false);
    expect(isPasswordEntryOverlayField("Security question")).toBe(false);

    expect(isSecureItemOverlayField("Title")).toBe(true);
    expect(isSecureItemOverlayField("Card Number")).toBe(true);
    expect(isSecureItemOverlayField("MonicaItemData")).toBe(true);
    expect(isSecureItemOverlayField("MonicaConflictCopy")).toBe(true);
    expect(isSecureItemOverlayField("otp")).toBe(false);
    expect(isSecureItemOverlayField("Security question")).toBe(false);

    expect(isPasskeyEntryOverlayField("Title")).toBe(true);
    expect(isPasskeyEntryOverlayField("MonicaPasskeyData")).toBe(true);
    expect(isPasskeyEntryOverlayField("KPEX_PASSKEY_PRIVATE_KEY_PEM")).toBe(true);
    expect(isPasskeyEntryOverlayField("MonicaConflictCopy")).toBe(true);
    expect(isPasskeyEntryOverlayField("otp")).toBe(false);
    expect(isPasskeyEntryOverlayField("Security question")).toBe(false);

    expect(isPasswordSecretFallbackCandidateField("Security question")).toBe(true);
    expect(isPasswordSecretFallbackCandidateField("Password")).toBe(false);
    expect(isPasswordSecretFallbackCandidateField("KPEX_PASSKEY_PRIVATE_KEY_PEM")).toBe(false);
  });

  it("treats a blank name as unknown rather than matching the empty key", () => {
    expect(normalizeKeePassFieldName("  Title  ")).toBe("title");
    expect(keePassFieldRoleOf("   ")).toBe("unknown");
    expect(isPasswordEntryOverlayField("   ")).toBe(false);
    expect(isSecureItemOverlayField("")).toBe(false);
    expect(isPasskeyEntryOverlayField("")).toBe(false);
  });
});
