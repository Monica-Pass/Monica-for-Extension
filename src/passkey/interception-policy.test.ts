import { describe, expect, it } from "vitest";
import { requestedPasskeyExtensionNames, shouldInterceptPasskeyCreate, shouldInterceptPasskeyGet } from "./interception-policy";

it("ignores only the inert credential-protection default materialized by the browser JSON parser", () => {
  expect(requestedPasskeyExtensionNames()).toEqual([]);
  expect(requestedPasskeyExtensionNames({ credProps: true, enforceCredentialProtectionPolicy: false } as AuthenticationExtensionsClientInputs)).toEqual(["credProps"]);
  expect(requestedPasskeyExtensionNames({ enforceCredentialProtectionPolicy: true } as AuthenticationExtensionsClientInputs)).toEqual(["enforceCredentialProtectionPolicy"]);
  expect(requestedPasskeyExtensionNames({ enforceCredentialProtectionPolicy: false, credentialProtectionPolicy: "userVerificationRequired", unknown: false } as AuthenticationExtensionsClientInputs)).toEqual(["credentialProtectionPolicy", "unknown"]);
});

describe("Passkey interception policy", () => {
  it("keeps unsupported registration requests with the browser", () => {
    const base = { topLevel: true, authenticatorAttachment: "platform", userVerification: "preferred", extensionNames: [] as string[], algorithms: [-7] };
    expect(shouldInterceptPasskeyCreate(base)).toBe(true);
    expect(shouldInterceptPasskeyCreate({ ...base, userVerification: "required" })).toBe(true);
    expect(shouldInterceptPasskeyCreate({ ...base, algorithms: [-257] })).toBe(true);
    expect(shouldInterceptPasskeyCreate({ ...base, algorithms: [-37, -8] })).toBe(false);
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
