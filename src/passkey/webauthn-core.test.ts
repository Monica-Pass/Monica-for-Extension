import { describe, expect, it } from "vitest";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createAssertion, createPasskey, fromBase64Url, validateRpId } from "./webauthn-core";

it("keeps UUID storage and WebAuthn credential bytes identical for Bitwarden-compatible registration", async () => {
  const created = await createPasskey({ origin: "https://example.com", challenge: Buffer.alloc(32, 71).toString("base64url"), rpName: "Synthetic",
    userId: "AAECA_8", userName: "synthetic", userDisplayName: "Synthetic", algorithms: [-7], excludeCredentialIds: [], credentialIdFormat: "uuid" });
  expect(created.credentialIdUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const bytes = Buffer.from(created.credentialIdUuid!.replace(/-/g, ""), "hex");
  expect(Buffer.from(fromBase64Url(created.credentialId))).toEqual(bytes);
  expect(bytes).toHaveLength(16);
  const auth = Buffer.from(fromBase64Url(created.response.authenticatorData));
  expect(auth.readUInt16BE(53)).toBe(16);
  expect(auth.subarray(55, 71)).toEqual(bytes);
});

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
    await expect(createPasskey({ origin: "https://example.com", challenge, rpName: "Example", userId: "dXNlcg", userName: "joy", userDisplayName: "Joy", algorithms: [-37], excludeCredentialIds: [] })).rejects.toThrow("不支持");
    await expect(createPasskey({ origin: "https://example.com", challenge: "AQ", rpName: "Example", userId: "dXNlcg", userName: "joy", userDisplayName: "Joy", algorithms: [-7], excludeCredentialIds: [] })).rejects.toThrow("challenge");
  });

  it("registers RSA with a canonical COSE key matching SPKI and verifies an assertion with that COSE key", async () => {
    const created = await createPasskey({ origin: "https://example.com", challenge, rpName: "Example", userId: "dXNlcg", userName: "synthetic", userDisplayName: "Synthetic", algorithms: [-257, -7], excludeCredentialIds: [], userVerified: true });
    expect(created.response.publicKeyAlgorithm).toBe(-257);
    const auth = Buffer.from(created.response.authenticatorData, "base64url");
    expect(auth[32]).toBe(0x5d);
    expect(auth.readUInt32BE(33)).toBe(0);
    const cose = auth.subarray(55 + auth.readUInt16BE(53));
    // RFC 9052 RSA: map(4), kty=3, alg=-257, n=256 bytes, e=010001.
    expect(cose.subarray(0, 11)).toEqual(Buffer.from("a401030339010020590100", "hex"));
    expect(cose.subarray(267)).toEqual(Buffer.from("2143010001", "hex"));
    const publicKey = createPublicKey({ format: "jwk", key: { kty: "RSA", n: cose.subarray(11, 267).toString("base64url"), e: "AQAB" } });
    expect(publicKey.export({ format: "der", type: "spki" }).toString("base64")).toBe(created.publicKeySpki);
    const assertion = await createAssertion({ origin: "https://example.com", challenge, credentialId: created.credentialId, userHandle: "dXNlcg", privateKeyPkcs8: created.privateKeyPkcs8, algorithm: -257, signCount: 0, userVerified: true });
    const client = Buffer.from(assertion.response.clientDataJSON, "base64url");
    const signed = Buffer.concat([Buffer.from(assertion.response.authenticatorData, "base64url"), createHash("sha256").update(client).digest()]);
    expect(verify("sha256", signed, publicKey, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
  });

  it("retains an imported credential's backup eligibility rather than changing its registration identity", async () => {
    const created = await createPasskey({ origin: "https://example.com", challenge, rpName: "Example", userId: "dXNlcg", userName: "synthetic", userDisplayName: "Synthetic", algorithms: [-7], excludeCredentialIds: [] });
    const assertion = await createAssertion({ origin: "https://example.com", challenge, credentialId: created.credentialId, userHandle: "dXNlcg", privateKeyPkcs8: created.privateKeyPkcs8, signCount: 0, userVerified: true, backupEligible: false, backupState: false });
    expect(fromBase64Url(assertion.response.authenticatorData)[32]).toBe(0x05);
  });

  it("verifies alternating signatures from independent synced copies without advancing the RP counter", async () => {
    const created = await createPasskey({ origin: "https://github.com", challenge, rpId: "github.com", rpName: "GitHub", userId: "dXNlcg", userName: "synthetic", userDisplayName: "Synthetic", algorithms: [-7], excludeCredentialIds: [] });
    const publicKey = createPublicKey({ key: Buffer.from(created.publicKeySpki, "base64"), format: "der", type: "spki" });
    const copies = [0, 0, 0].map(signCount => ({ ...created, signCount }));
    let serverCounter = 0;
    for (const [attempt, device] of [0, 1, 0, 2, 1, 2].entries()) {
      const currentChallenge = Buffer.alloc(32, attempt + 1).toString("base64url");
      const copy = copies[device];
      // All copies have a zero-counter registration. Positive history is tested
      // through its durable counter policy, not reset by the signing primitive.
      const assertion = await createAssertion({ origin: "https://github.com", challenge: currentChallenge, rpId: "github.com", credentialId: copy.credentialId, userHandle: "dXNlcg", privateKeyPkcs8: copy.privateKeyPkcs8, signCount: 0, userVerified: true });
      const authData = Buffer.from(assertion.response.authenticatorData, "base64url");
      const clientData = Buffer.from(assertion.response.clientDataJSON, "base64url");
      expect(JSON.parse(clientData.toString())).toMatchObject({ type: "webauthn.get", challenge: currentChallenge, origin: "https://github.com", crossOrigin: false });
      expect(authData.subarray(0, 32)).toEqual(createHash("sha256").update("github.com").digest());
      expect(authData[32] & 5).toBe(5);
      const signed = Buffer.concat([authData, createHash("sha256").update(clientData).digest()]);
      expect(verify("sha256", signed, publicKey, Buffer.from(assertion.response.signature, "base64url"))).toBe(true);
      const newCounter = authData.readUInt32BE(33);
      expect(serverCounter === 0 && newCounter === 0 || newCounter > serverCounter).toBe(true);
      serverCounter = newCounter;
      copy.signCount = assertion.signCount;
      expect(copy.signCount).toBe(0);
    }
    expect(serverCounter).toBe(0);
  });
});
