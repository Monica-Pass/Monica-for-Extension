import { describe, expect, it, vi } from "vitest";
import { createOtpDisplayCache } from "./otp-display-cache";

describe("OTP display calculation lifetime", () => {
  const parameters = { secret: "JBSWY3DPEHPK3PXP", period: 30, digits: 6, algorithm: "SHA1" as const, otpType: "TOTP" as const };
  it("reuses a code within its time step and recalculates on rollover or secret changes", async () => {
    const generate = vi.fn(async () => "123456");
    const cache = createOtpDisplayCache(generate);
    await cache.get(parameters, 15000);
    await cache.get(parameters, 16000);
    await cache.get(parameters, 29000);
    expect(generate).toHaveBeenCalledTimes(1);
    await cache.get(parameters, 30000);
    await cache.get({ ...parameters, secret: "KRSXG5A" }, 30000);
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it.each([['MOTP', 10], ['STEAM', 30], ['YANDEX', 30]] as const)("uses the %s time step", async (otpType, seconds) => {
    const generate = vi.fn(async () => "123456");
    const cache = createOtpDisplayCache(generate);
    const input = { ...parameters, otpType, pin: '1234', pinLength: 4 };
    await cache.get(input, 1000);
    await cache.get(input, (seconds - 1) * 1000);
    expect(generate).toHaveBeenCalledTimes(1);
    await cache.get(input, seconds * 1000);
    expect(generate).toHaveBeenCalledTimes(2);
  });
  it("keeps HOTP stable until the counter changes and forgets its code on disposal", async () => {
    const generate = vi.fn(async () => "123456");
    const cache = createOtpDisplayCache(generate);
    await cache.get({ ...parameters, otpType: "HOTP", counter: 7 }, 0);
    await cache.get({ ...parameters, otpType: "HOTP", counter: 7 }, 90000);
    expect(generate).toHaveBeenCalledTimes(1);
    await cache.get({ ...parameters, otpType: "HOTP", counter: 8 }, 90000);
    cache.clear();
    await cache.get({ ...parameters, otpType: "HOTP", counter: 8 }, 90000);
    expect(generate).toHaveBeenCalledTimes(3);
  });
  it("retries a failed calculation instead of caching an error", async () => {
    const generate = vi.fn().mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue("123456");
    const cache = createOtpDisplayCache(generate);
    await expect(cache.get(parameters, 15000)).rejects.toThrow("temporary failure");
    await expect(cache.get(parameters, 16000)).resolves.toBe("123456");
  });
});
