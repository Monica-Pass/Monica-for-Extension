import { describe, expect, it } from "vitest";
import { createAssertion, createPasskey, fromBase64Url, validateRpId } from "./webauthn-core";

const challenge = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

describe("WebAuthn passkey core", () => {
  it("validates RP IDs against secure page origins", () => {
    expect(validateRpId("https://login.example.com", "example.com")).toBe("example.com");
    expect(() => validateRpId("https://evil.example.net", "example.com")).toThrow("RP ID");
    expect(() => validateRpId("http://example.com", "example.com")).toThrow("HTTPS");
  });

  it("creates ES256 registration material and signs an assertion", async () => {
    const created = await createPasskey({ origin: "https://login.example.com", challenge, rpId: "example.com", rpName: "Example", userId: "dXNlcg", userName: "joy@example.com", userDisplayName: "Joy", algorithms: [-7], excludeCredentialIds: [] });
    expect(fromBase64Url(created.credentialId)).toHaveLength(32);
    expect(fromBase64Url(created.response.attestationObject).length).toBeGreaterThan(100);
    const assertion = await createAssertion({ origin: "https://login.example.com", challenge, rpId: "example.com", credentialId: created.credentialId, userHandle: "dXNlcg", privateKeyPkcs8: created.privateKeyPkcs8, signCount: 0 });
    expect(assertion.signCount).toBe(1);
    expect(fromBase64Url(assertion.response.signature)[0]).toBe(0x30);
    expect(fromBase64Url(assertion.response.authenticatorData)).toHaveLength(37);
  });

  it("rejects unsupported algorithms and short challenges", async () => {
    await expect(createPasskey({ origin: "https://example.com", challenge, rpName: "Example", userId: "dXNlcg", userName: "joy", userDisplayName: "Joy", algorithms: [-257], excludeCredentialIds: [] })).rejects.toThrow("ES256");
    await expect(createPasskey({ origin: "https://example.com", challenge: "AQ", rpName: "Example", userId: "dXNlcg", userName: "joy", userDisplayName: "Joy", algorithms: [-7], excludeCredentialIds: [] })).rejects.toThrow("challenge");
  });
});
