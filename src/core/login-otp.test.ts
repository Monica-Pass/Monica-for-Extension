import { describe, expect, it } from "vitest";
import type { LoginItem, TotpItem } from "./model";
import { advanceHotpCounter, findBoundTotpItem, parametersFromItem, resolveLoginOtp } from "./login-otp";

const base = { title: "item", favorite: false, notes: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const login: LoginItem = { ...base, id: "login", kind: "login", username: "u", password: "p", uris: [], customFields: [], providerRefs: [{ providerId: "dav", remoteId: "folders/_root/passwords/password_42_1700000000000.json" }] };
const hotp: TotpItem = { ...base, id: "hotp", kind: "totp", secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", otpType: "HOTP", counter: 0, algorithm: "SHA1", digits: 6, period: 30, boundPasswordId: 42, providerRefs: [{ providerId: "dav" }] };

describe("login OTP binding", () => {
  it("keeps an explicit unlink separate from a legacy missing forward reference", async () => {
    expect(findBoundTotpItem(login, [hotp])).toBe(hotp);
    const unlinked = { ...login, boundTotpItemId: "" };
    expect(findBoundTotpItem(unlinked, [hotp])).toBeUndefined();
    expect(findBoundTotpItem({ ...login, boundTotpItemId: "removed-authenticator" }, [hotp])).toBeUndefined();
    expect(await resolveLoginOtp(unlinked, [hotp])).toBeUndefined();
    expect(await resolveLoginOtp({ ...unlinked, totpSecret: hotp.secret }, [hotp], 59_000)).toMatchObject({ code: "287082" });
  });

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

  it("prioritizes an explicit authenticator over Android reverse links and inline secrets", async () => {
    const explicit = { ...hotp, id: "explicit", counter: 1, boundPasswordId: undefined };
    const item = { ...login, boundTotpItemId: explicit.id, totpSecret: "invalid fallback" };
    expect(findBoundTotpItem(item, [hotp, explicit])).toBe(explicit);
    expect((await resolveLoginOtp(item, [hotp, explicit], 0))?.code).toBe("287082");
  });

  it("does not use deleted authenticators and keeps inline fallback behavior", async () => {
    const item = { ...login, providerRefs: [], boundTotpItemId: hotp.id, totpSecret: hotp.secret };
    const deleted = { ...hotp, deletedAt: base.updatedAt };
    expect(findBoundTotpItem(item, [deleted])).toBeUndefined();
    const resolution = await resolveLoginOtp(item, [deleted], 59_000);
    expect(resolution).toEqual({ code: "287082", updatedItem: undefined });
    expect(await resolveLoginOtp({ ...item, totpSecret: undefined }, [deleted])).toBeUndefined();
  });

  it("preserves inline OTP parameters for display and counter persistence", () => {
    const item = { ...login, totpSecret: `otpauth://hotp/Example:alice?secret=${hotp.secret}&counter=7&algorithm=SHA256&digits=8&issuer=Example` };
    const updated = advanceHotpCounter(item, 59_000)!;
    expect(parametersFromItem(updated)).toMatchObject({ otpType: "HOTP", counter: 8, algorithm: "SHA256", digits: 8, issuer: "Example", accountName: "alice" });
    expect(parametersFromItem(item).counter).toBe(7);
    expect(updated).toMatchObject({ id: item.id, kind: "login", password: item.password, updatedAt: "1970-01-01T00:00:59.000Z" });
    expect(advanceHotpCounter({ ...item, totpSecret: hotp.secret })).toBeUndefined();
  });

  it("retains Steam's secret encoding for a linked authenticator display", () => {
    expect(parametersFromItem({ ...hotp, otpType: "STEAM", steamSharedSecretBase64: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" })).toMatchObject({
      otpType: "STEAM", secretEncoding: "base64", secret: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA="
    });
  });
});
