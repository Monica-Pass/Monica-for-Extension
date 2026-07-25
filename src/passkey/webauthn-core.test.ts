import { describe, expect, it } from "vitest";
import { createAssertion, createPasskey, fromBase64Url, validateRpId } from "./webauthn-core";

const challenge = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

describe("WebAuthn passkey core", () => {
  it("validates RP IDs against secure page origins", () => {
    expect(validateRpId("https://login.example.com", "example.com")).toBe("example.com");
    expect(validateRpId("https://login.example.co.uk", "example.co.uk")).toBe("example.co.uk");
    expect(() => validateRpId("https://evil.example.net", "example.com")).toThrow("RP ID");
    expect(() => validateRpId("https://login.example.co.uk", "co.uk")).toThrow("公共后缀");
    expect(() => validateRpId("https://example.com", "example.com:443")).toThrow("RP ID");
    expect(() => validateRpId("https://example.com", "name@example.com")).toThrow("RP ID");
    expect(() => validateRpId("https://example.com", "example.com/path")).toThrow("RP ID");
    expect(validateRpId("https://EXAMPLE.com.", "example.com.")).toBe("example.com");
    expect(() => validateRpId("http://example.com", "example.com")).toThrow("HTTPS");
  });

  it("creates ES256 registration material and signs an assertion", async () => {
    const created = await createPasskey({ origin: "https://login.example.com", challenge, rpId: "example.com", rpName: "Example", userId: "dXNlcg", userName: "joy@example.com", userDisplayName: "Joy", algorithms: [-7], excludeCredentialIds: [] });
    expect(fromBase64Url(created.credentialId)).toHaveLength(32);
    expect(fromBase64Url(created.response.attestationObject).length).toBeGreaterThan(100);
    const registrationAuthData = fromBase64Url(created.response.authenticatorData);
    expect(registrationAuthData[32]).toBe(0x59);
    expect(Array.from(registrationAuthData.slice(37, 53))).toEqual([0x6d, 0x6f, 0x6e, 0x69, 0x63, 0x61, 0x4d, 0x33, 0xa0, 0x01, 0x70, 0x61, 0x73, 0x73, 0x6b, 0x79]);
    const assertion = await createAssertion({ origin: "https://login.example.com", challenge, rpId: "example.com", credentialId: created.credentialId, userHandle: "dXNlcg", privateKeyPkcs8: created.privateKeyPkcs8, signCount: 0 });
    expect(assertion.signCount).toBe(0);
    expect(fromBase64Url(assertion.response.signature)[0]).toBe(0x30);
    expect(fromBase64Url(assertion.response.authenticatorData)).toHaveLength(37);
    expect(fromBase64Url(assertion.response.authenticatorData)[32]).toBe(0x19);
    const verified = await createAssertion({ origin: "https://login.example.com", challenge, rpId: "example.com", credentialId: created.credentialId, userHandle: "dXNlcg", privateKeyPkcs8: created.privateKeyPkcs8, signCount: 0, userVerified: true });
    expect(fromBase64Url(verified.response.authenticatorData)[32]).toBe(0x1d);
  });

  it("rejects unsupported algorithms and short challenges", async () => {
    await expect(createPasskey({ origin: "https://example.com", challenge, rpName: "Example", userId: "dXNlcg", userName: "joy", userDisplayName: "Joy", algorithms: [-257], excludeCredentialIds: [] })).rejects.toThrow("ES256");
    await expect(createPasskey({ origin: "https://example.com", challenge: "AQ", rpName: "Example", userId: "dXNlcg", userName: "joy", userDisplayName: "Joy", algorithms: [-7], excludeCredentialIds: [] })).rejects.toThrow("challenge");
  });
});
