import { describe, expect, it } from "vitest";
import { createOtpQrDataUrl } from "./otp-qr";

describe("OTP QR export", () => {
  it("creates a PNG data URL without remote services", async () => {
    const output = await createOtpQrDataUrl("otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP");
    expect(output).toMatch(/^data:image\/png;base64,/);
    expect(output.length).toBeGreaterThan(500);
  });
});
