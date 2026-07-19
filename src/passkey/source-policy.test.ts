import { describe, expect, it } from "vitest";
import type { PasskeyItem } from "../core/model";
import { isUsablePasskey, normalizeCredentialId, passkeyAvailability, passkeyAvailabilityLabel } from "./source-policy";

const base: PasskeyItem = {
  id: "passkey-1",
  kind: "passkey",
  title: "Example",
  favorite: false,
  notes: "",
  createdAt: "2026-07-19T00:00:00.000Z",
  updatedAt: "2026-07-19T00:00:00.000Z",
  providerRefs: [],
  credentialId: "AQID",
  rpId: "example.com",
  rpName: "Example",
  userHandle: "dXNlcg",
  userName: "joy@example.com",
  userDisplayName: "Joy",
  algorithm: -7,
  publicKey: "public",
  privateKeyPkcs8: "private",
  signCount: 0,
  discoverable: true,
  sourceMode: "browser-local"
};

describe("Passkey source policy", () => {
  it("keeps Android metadata records out of authentication", () => {
    const metadata = { ...base, sourceMode: "android-metadata-only" as const };
    expect(passkeyAvailability(metadata, "example.com")).toBe("android-metadata-only");
    expect(isUsablePasskey(metadata, "example.com")).toBe(false);
    expect(passkeyAvailabilityLabel("android-metadata-only")).toContain("仅可查看");
  });

  it("requires a private key and exact RP ID", () => {
    expect(passkeyAvailability({ ...base, privateKeyPkcs8: undefined }, "example.com")).toBe("missing-private-key");
    expect(passkeyAvailability(base, "login.example.com")).toBe("rp-mismatch");
    expect(isUsablePasskey(base, "example.com", "AQID")).toBe(true);
    expect(isUsablePasskey(base, "example.com", "BAUG")).toBe(false);
  });

  it("normalizes base64url and UUID-like credential IDs consistently", () => {
    expect(normalizeCredentialId("AQID=")).toBe("aqid");
    expect(normalizeCredentialId("AQID")).toBe("aqid");
  });
});
