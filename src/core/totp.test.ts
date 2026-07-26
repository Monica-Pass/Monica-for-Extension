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

  it("matches the mOTP fixed vector without stripping hexadecimal letters", async () => {
    await expect(generateMobileOtp("1234567890abcdef", "5555", 1_700_000_000_000)).resolves.toBe("e44b41");
  });

  it("matches the YAOTP fixed vector and preserves its required URI parameters", async () => {
    const yandex = parseTotpParameters("otpauth://yaotp/Yandex:user?secret=Q3GXYNZ7INQOWXTVKGKYBLKDU4&issuer=Yandex&pin=2452544424551078&pin_length=16");
    expect(yandex).toMatchObject({ otpType: "YANDEX", pin: "2452544424551078", pinLength: 16 });
    await expect(generateOtpWithParameters(yandex, 1_700_000_000_000)).resolves.toBe("dkpcmema");
    expect(parseTotpParameters(generateOtpUri(yandex))).toMatchObject({ otpType: "YANDEX", pin: "2452544424551078", pinLength: 16 });
  });

  it("rejects YAOTP without a valid PIN or matching pin_length", async () => {
    expect(() => parseTotpParameters("otpauth://yaotp/Yandex:user?secret=Q3GXYNZ7INQOWXTVKGKYBLKDU4&pin_length=4")).toThrow("YAOTP PIN");
    await expect(generateOtpWithParameters({ secret: "Q3GXYNZ7INQOWXTVKGKYBLKDU4", algorithm: "SHA1", digits: 6, period: 30, otpType: "YANDEX", pin: "0012", pinLength: 5 }, 0)).rejects.toThrow("pin_length");
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

  it("parses the Bitwarden steam:// payload Monica Android writes for Steam Guard", async () => {
    const parameters = parseTotpParameters("steam://QUJDREVGR0hJSktMTU5PUFFSU1Q=");
    expect(parameters).toMatchObject({ otpType: "STEAM", digits: 5, period: 30, algorithm: "SHA1", secret: "QUJDREVGR0hJSktMTU5PUFFSU1Q=", secretEncoding: "base64" });
    // Android's TotpDataResolverTest asserts this exact base32 projection of the shared secret.
    expect(generateOtpUri(parameters)).toContain("secret=IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U");
    const code = await generateOtpWithParameters(parameters, 1_700_000_000_000);
    expect(code).toHaveLength(5);
    expect([...code].every((character) => "23456789BCDFGHJKMNPQRTVWXY".includes(character))).toBe(true);
  });

  it("keeps a plus sign in a steam:// shared secret and falls back to base32 payloads", () => {
    expect(parseTotpParameters("steam://ABCDEFGHIJKLMNOPQRS+")).toMatchObject({ otpType: "STEAM", secret: "ABCDEFGHIJKLMNOPQRS+", secretEncoding: "base64" });
    expect(generateOtpUri(parseTotpParameters("steam://ABCDEFGHIJKLMNOPQRS+"))).toContain("secret=AAIIGECRQ4QJFCZQ2OHUCFF6");
    expect(parseTotpParameters("steam://IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U")).toMatchObject({ otpType: "STEAM", secret: "IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U", secretEncoding: "base32" });
  });
});
