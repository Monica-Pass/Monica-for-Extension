import { describe, expect, it } from "vitest";
import { generateHotp, generateMobileOtp, generateOtpUri, generateOtpWithParameters, generateTotp, parseOtpUris, parseTotpParameters } from "./totp";

describe("Android-compatible OTP", () => {
  it("matches RFC 6238 TOTP vectors", async () => {
    await expect(generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).resolves.toBe("287082");
    await expect(generateTotp("otpauth://totp/RFC?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=30", 59_000)).resolves.toBe("94287082");
  });

  it("matches the RFC 4226 HOTP counter vectors", async () => {
    const base = { secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", algorithm: "SHA1" as const, digits: 6, period: 30, otpType: "HOTP" as const };
    await expect(generateHotp(base, 0)).resolves.toBe("755224");
    await expect(generateHotp(base, 1)).resolves.toBe("287082");
    await expect(generateOtpWithParameters({ ...base, counter: 2 })).resolves.toBe("359152");
  });

  it("matches Monica Android mOTP and treats Yandex as standard TOTP", async () => {
    await expect(generateMobileOtp("secret", "1234", 1_700_000_000_000)).resolves.toBe("500376");
    const yandex = parseTotpParameters("otpauth://yaotp/Yandex:user?secret=JBSWY3DPEHPK3PXP&issuer=Yandex");
    expect(yandex.otpType).toBe("YANDEX");
    await expect(generateOtpWithParameters(yandex, 0)).resolves.toMatch(/^\d{6}$/);
  });

  it("parses and exports Android OTP URI variants without losing parameters", () => {
    const hotp = parseTotpParameters("otpauth://hotp/Test:user?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=7&counter=42&issuer=Test");
    expect(hotp).toMatchObject({ otpType: "HOTP", algorithm: "SHA256", digits: 7, counter: 42, issuer: "Test", accountName: "user" });
    expect(parseTotpParameters(generateOtpUri(hotp, "Test:user"))).toMatchObject({ otpType: "HOTP", algorithm: "SHA256", digits: 7, counter: 42 });
    const motp = parseTotpParameters("motp://Example:alice?secret=plain-secret");
    expect(motp).toMatchObject({ otpType: "MOTP", secret: "plain-secret", issuer: "Example", accountName: "alice", period: 10 });
    expect(parseTotpParameters(generateOtpUri(motp))).toMatchObject({ otpType: "MOTP", secret: "plain-secret" });
  });

  it("parses Google Authenticator migration payloads", () => {
    const item = Uint8Array.from([0x0a, 0x02, 0x48, 0x69, 0x12, 0x05, 0x61, 0x6c, 0x69, 0x63, 0x65, 0x1a, 0x07, 0x45, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x20, 0x01, 0x28, 0x01, 0x30, 0x01, 0x38, 0x09]);
    const payload = Uint8Array.from([0x0a, item.length, ...item]);
    const data = btoa(String.fromCharCode(...payload));
    expect(parseOtpUris(`otpauth-migration://offline?data=${encodeURIComponent(data)}`)[0].parameters).toMatchObject({ secret: "JBUQ", issuer: "Example", accountName: "alice", otpType: "HOTP", counter: 9 });
  });
});
