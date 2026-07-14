import { describe, expect, it } from "vitest";
import { generateTotp, parseTotpParameters } from "./totp";

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 vector", async () => {
    await expect(generateTotp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).resolves.toBe("287082");
    await expect(generateTotp("otpauth://totp/RFC?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8&period=30", 59_000)).resolves.toBe("94287082");
  });

  it("parses URI parameters and rejects HOTP", () => {
    expect(parseTotpParameters("otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=7&period=45")).toEqual({ secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA256", digits: 7, period: 45 });
    expect(() => parseTotpParameters("otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP")).toThrow("TOTP");
  });
});
