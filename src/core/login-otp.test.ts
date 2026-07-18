import { describe, expect, it } from "vitest";
import type { LoginItem, TotpItem } from "./model";
import { findBoundTotpItem, resolveLoginOtp } from "./login-otp";

const base = { title: "item", favorite: false, notes: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const login: LoginItem = { ...base, id: "login", kind: "login", username: "u", password: "p", uris: [], customFields: [], providerRefs: [{ providerId: "dav", remoteId: "folders/_root/passwords/password_42_1700000000000.json" }] };
const hotp: TotpItem = { ...base, id: "hotp", kind: "totp", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", otpType: "HOTP", counter: 0, algorithm: "SHA1", digits: 6, period: 30, boundPasswordId: 42, providerRefs: [{ providerId: "dav" }] };

describe("login OTP binding", () => {
  it("resolves Android boundPasswordId within the same provider", () => {
    expect(findBoundTotpItem(login, [login, hotp])?.id).toBe("hotp");
    expect(findBoundTotpItem({ ...login, providerRefs: [{ providerId: "other", remoteId: login.providerRefs[0].remoteId }] }, [hotp])).toBeUndefined();
  });

  it("returns a HOTP counter update without mutating before successful use", async () => {
    const result = await resolveLoginOtp(login, [login, hotp], 1_700_000_000_000);
    expect(result?.code).toBe("755224");
    expect(hotp.counter).toBe(0);
    expect(result?.updatedItem).toMatchObject({ id: "hotp", counter: 1 });
  });

  it("advances inline HOTP URIs while leaving TOTP unchanged", async () => {
    const inline = { ...login, boundTotpItemId: undefined, providerRefs: [], totpSecret: "otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=4" };
    const result = await resolveLoginOtp(inline, [inline], 0);
    expect(result?.code).toBe("338314");
    expect((result?.updatedItem as LoginItem).totpSecret).toContain("counter=5");
  });
});
