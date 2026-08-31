import { describe, expect, it } from "vitest";
import type { PasskeyItem } from "../core/model";
import { decodeBitwardenCredentialId, duplicatePasskeyCredentialIds, hasExcludedUsablePasskey, isUsablePasskey, normalizeCredentialId, passkeyAvailability, passkeyAvailabilityLabel, passkeyMatchesPageHost, passkeyRpIdsEqual, selectPasskeyCandidates, toBitwardenCredentialId } from "./source-policy";

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

  it("does not offer algorithms that the browser signer cannot use", () => {
    const unsupported = { ...base, sourceMode: "bitwarden" as const, algorithm: -257 as const };
    expect(passkeyAvailability({ ...base, algorithm: -257 }, "example.com")).toBe("unsupported-algorithm");
    expect(isUsablePasskey({ ...base, algorithm: -257 }, "example.com")).toBe(false);
    expect(passkeyAvailability(unsupported, "example.com")).toBe("unsupported-algorithm");
    expect(isUsablePasskey(unsupported, "example.com")).toBe(false);
    expect(passkeyAvailabilityLabel("unsupported-algorithm")).toContain("ES256");
  });

  it("normalizes base64url and UUID-like credential IDs consistently", () => {
    expect(normalizeCredentialId("AQID=")).toBe("AQID");
    expect(normalizeCredentialId("AQID")).toBe("AQID");
    expect(normalizeCredentialId("aqid")).not.toBe(normalizeCredentialId("AQID"));
  });

  it("normalizes IDN and trailing dots while allowing a parent RP on subdomains", () => {
    expect(passkeyRpIdsEqual("EXAMPLE.com.", "example.com")).toBe(true);
    expect(passkeyMatchesPageHost(base, "login.example.com")).toBe(true);
    expect(passkeyMatchesPageHost(base, "example.net")).toBe(false);
  });

  it("requires discoverable credentials only when allowCredentials is empty", () => {
    const nonDiscoverable = { ...base, id: "non-discoverable", credentialId: "BAUG", discoverable: false };
    expect(selectPasskeyCandidates([base, nonDiscoverable], "example.com", [])).toEqual([base]);
    expect(selectPasskeyCandidates([base, nonDiscoverable], "example.com", ["BAUG"])).toEqual([nonDiscoverable]);
  });

  it("does not let Android metadata or unsupported keys block registration", () => {
    const metadata = { ...base, sourceMode: "android-metadata-only" as const };
    const unsupported = { ...base, algorithm: -257 };
    expect(hasExcludedUsablePasskey([metadata, unsupported], "example.com", ["AQID"])).toBe(false);
    expect(hasExcludedUsablePasskey([base], "example.com", ["AQID"])).toBe(true);
  });

  it("decodes only explicitly tagged Bitwarden byte IDs", () => {
    expect(decodeBitwardenCredentialId("b64.AAECAwQFBgcICQoLDA0ODw")).toBe("AAECAwQFBgcICQoLDA0ODw");
    expect(decodeBitwardenCredentialId("android-id")).toBe("android-id");
    expect(toBitwardenCredentialId("b64.AAECAwQFBgcICQoLDA0ODw")).toBe("b64.AAECAwQFBgcICQoLDA0ODw");
  });

  it("detects normalized duplicate credential IDs across provider-owned records", () => {
    const bitwarden = { ...base, id: "bitwarden", credentialId: "AQID=", sourceMode: "bitwarden" as const, providerRefs: [{ providerId: "bw-work" }] };
    const keepass = { ...base, id: "keepass", credentialId: "AQID", providerRefs: [{ providerId: "kp-family" }] };
    const distinct = { ...base, id: "distinct", credentialId: "BAUG", providerRefs: [{ providerId: "local" }] };

    expect([...duplicatePasskeyCredentialIds([bitwarden, keepass, distinct])]).toEqual(["AQID"]);
    expect(duplicatePasskeyCredentialIds([bitwarden, { ...bitwarden }])).toEqual(new Set());
  });
});
