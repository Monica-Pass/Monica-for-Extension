import { describe, expect, it } from "vitest";
import {
  KEEPASS_TOTP_FIELDS,
  keePassTotpFieldsFor,
  normalizeKeePassTotpSecret,
  parseKeePassTotpFields,
  type KeePassTotpData
} from "./keepass-totp-codec";

/** Assertion semantics translated from Android `KeePassTotpCodecTest.kt`. */
describe("parseKeePassTotpFields", () => {
  it("parses an otpauth URI, preferring it over the fallback issuer and account", () => {
    const data = parseKeePassTotpFields({
      otp: "otpauth://totp/GitHub:user%40example.com?secret=jbsw-y3dp%20ehpk3pxp&issuer=GitHub&algorithm=SHA256&digits=8&period=45",
      issuer: "Fallback",
      accountName: "fallback-user",
      link: "https://github.com"
    });

    expect(data).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "GitHub",
      accountName: "user@example.com",
      algorithm: "SHA256",
      digits: 8,
      period: 45,
      otpType: "TOTP",
      counter: 0,
      link: "https://github.com"
    });
  });

  it("parses a bare secret in the otp field alongside a settings string", () => {
    const data = parseKeePassTotpFields({
      otp: "jbsw-y3dp ehpk3pxp",
      settings: "period=60;digits=8;algorithm=sha512",
      issuer: "GitLab",
      accountName: "user"
    });

    expect(data).toMatchObject({ secret: "JBSWY3DPEHPK3PXP", issuer: "GitLab", accountName: "user", period: 60, digits: 8, algorithm: "SHA512" });
  });

  it("parses a TOTP Seed with the split period, digits and algorithm fields", () => {
    const data = parseKeePassTotpFields({
      seed: "abcd efgh ijkl mnop",
      period: "45",
      digits: "7",
      algorithm: "sha256",
      issuer: "KeePassDX",
      accountName: "alice"
    });

    expect(data).toMatchObject({ secret: "ABCDEFGHIJKLMNOP", period: 45, digits: 7, algorithm: "SHA256" });
  });

  it("recognises HOTP from either the settings string or the dedicated counter field", () => {
    expect(parseKeePassTotpFields({ seed: "JBSWY3DPEHPK3PXP", settings: "type=hotp counter=42" }))
      .toMatchObject({ otpType: "HOTP", counter: 42 });
    expect(parseKeePassTotpFields({ seed: "JBSWY3DPEHPK3PXP", counter: "99" }))
      .toMatchObject({ otpType: "HOTP", counter: 99 });
  });

  it("returns undefined when no secret exists anywhere", () => {
    expect(parseKeePassTotpFields({ settings: "period=60;digits=8", issuer: "No secret" })).toBeUndefined();
  });

  it("ignores an otpauth URI with no secret rather than treating the URI as the secret", () => {
    expect(parseKeePassTotpFields({ otp: "otpauth://totp/Example?issuer=Example" })).toBeUndefined();
  });

  it("lets the dedicated fields override the settings string, as Android does", () => {
    const data = parseKeePassTotpFields({ seed: "JBSWY3DPEHPK3PXP", settings: "period=60;digits=8", period: "15", digits: "7" });

    expect(data).toMatchObject({ period: 15, digits: 7 });
  });

  it("reads bare tokens positionally and by shape", () => {
    expect(parseKeePassTotpFields({ seed: "JBSWY3DPEHPK3PXP", settings: "60 8 sha512 hotp" }))
      .toMatchObject({ period: 60, digits: 8, algorithm: "SHA512", otpType: "HOTP" });
  });

  it("normalises a secret without stripping base32 padding", () => {
    expect(normalizeKeePassTotpSecret(" jbsw-y3dp ehpk3pxp= ")).toBe("JBSWY3DPEHPK3PXP=");
  });
});

function totp(overrides: Partial<KeePassTotpData> = {}): KeePassTotpData {
  return {
    secret: "JBSWY3DPEHPK3PXP",
    issuer: "",
    accountName: "",
    period: 30,
    digits: 6,
    algorithm: "SHA1",
    otpType: "TOTP",
    counter: 0,
    link: "",
    ...overrides
  };
}

describe("keePassTotpFieldsFor", () => {
  it("emits every field Android emits for a TOTP entry", () => {
    const fields = keePassTotpFieldsFor(
      totp({ secret: "jbsw-y3dp ehpk3pxp", issuer: "GitHub", accountName: "user@example.com", period: 45, digits: 8, algorithm: "sha256" }),
      "GitHub"
    );

    expect(fields).toEqual({
      otp: "otpauth://totp/GitHub%3Auser%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA256&digits=8&period=45",
      "TOTP Seed": "JBSWY3DPEHPK3PXP",
      "TOTP Settings": "period=45;digits=8;algorithm=SHA256",
      "TOTP Period": "45",
      "TOTP Digits": "8",
      "TOTP Algorithm": "SHA256",
      "OTP Type": "TOTP"
    });
  });

  it("emits the HOTP counter in both the settings string and its own field", () => {
    const fields = keePassTotpFieldsFor(totp({ issuer: "Example", accountName: "alice", otpType: "HOTP", counter: 12 }), "Example");

    expect(fields[KEEPASS_TOTP_FIELDS.otpType]).toBe("HOTP");
    expect(fields[KEEPASS_TOTP_FIELDS.hotpCounter]).toBe("12");
    expect(fields[KEEPASS_TOTP_FIELDS.settings]).toBe("period=30;digits=6;algorithm=SHA1;type=hotp;counter=12");
    expect(fields[KEEPASS_TOTP_FIELDS.otp]).toBe("otpauth://hotp/Example%3Aalice?secret=JBSWY3DPEHPK3PXP&issuer=Example&counter=12");
  });

  it("falls back to the entry title when there is neither issuer nor account name", () => {
    expect(keePassTotpFieldsFor(totp(), "My Router")[KEEPASS_TOTP_FIELDS.otp])
      .toBe("otpauth://totp/My%20Router?secret=JBSWY3DPEHPK3PXP");
  });

  it("emits nothing at all when there is no secret, so no stale TOTP field is written", () => {
    expect(keePassTotpFieldsFor(totp({ secret: "  " }), "GitHub")).toEqual({});
  });

  it("round-trips through parse without drifting", () => {
    const original = totp({ issuer: "GitHub", accountName: "alice", period: 45, digits: 8, algorithm: "SHA256" });
    const fields = keePassTotpFieldsFor(original, "GitHub");

    const parsed = parseKeePassTotpFields({
      otp: fields[KEEPASS_TOTP_FIELDS.otp],
      seed: fields[KEEPASS_TOTP_FIELDS.seed],
      settings: fields[KEEPASS_TOTP_FIELDS.settings],
      period: fields[KEEPASS_TOTP_FIELDS.period],
      digits: fields[KEEPASS_TOTP_FIELDS.digits],
      algorithm: fields[KEEPASS_TOTP_FIELDS.algorithm],
      type: fields[KEEPASS_TOTP_FIELDS.otpType]
    });

    expect(parsed).toEqual(original);
  });
});
