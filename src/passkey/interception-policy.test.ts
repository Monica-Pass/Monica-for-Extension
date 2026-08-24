import { describe, expect, it } from "vitest";
import { shouldInterceptPasskeyCreate, shouldInterceptPasskeyGet } from "./interception-policy";

describe("Passkey interception policy", () => {
  it("keeps unsupported registration requests with the browser", () => {
    const base = { topLevel: true, authenticatorAttachment: "platform", userVerification: "preferred", extensionNames: [] as string[], algorithms: [-7] };
    expect(shouldInterceptPasskeyCreate(base)).toBe(true);
    expect(shouldInterceptPasskeyCreate({ ...base, userVerification: "required" })).toBe(true);
    expect(shouldInterceptPasskeyCreate({ ...base, algorithms: [-257] })).toBe(false);
    expect(shouldInterceptPasskeyCreate({ ...base, extensionNames: ["largeBlob"] })).toBe(false);
    expect(shouldInterceptPasskeyCreate({ ...base, topLevel: false })).toBe(false);
  });

  it("keeps conditional, silent and external authentication native", () => {
    const base = { topLevel: true, mediation: "optional", userVerification: "preferred", extensionNames: [] as string[], externalOnly: false };
    expect(shouldInterceptPasskeyGet(base)).toBe(true);
    expect(shouldInterceptPasskeyGet({ ...base, mediation: "conditional" })).toBe(false);
    expect(shouldInterceptPasskeyGet({ ...base, mediation: "silent" })).toBe(false);
    expect(shouldInterceptPasskeyGet({ ...base, userVerification: "required" })).toBe(true);
    expect(shouldInterceptPasskeyGet({ ...base, externalOnly: true })).toBe(false);
    expect(shouldInterceptPasskeyGet({ ...base, topLevel: false })).toBe(false);
  });
});
