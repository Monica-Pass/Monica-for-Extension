import { describe, expect, it } from "vitest";
import { MAX_BLOCKED_FIELD_SIGNATURES, normalizeBlockedFieldSignatures } from "./field-policy";

const record = (signature: string, hostname = "Login.Example.com.") => ({
  signature,
  hostname,
  frameScope: "top-level" as const,
  role: "username" as const,
  hints: ["username" as const],
  blockedAt: "2026-08-23T00:00:00.000Z"
});

describe("autofill field policy", () => {
  it("normalizes hosts and keeps the newest duplicate signature", () => {
    const signature = "a".repeat(64);
    expect(normalizeBlockedFieldSignatures([
      record(signature),
      { ...record(signature, "login.example.com"), blockedAt: "2026-08-23T01:00:00.000Z", role: "current-password" as const }
    ])).toEqual([{ ...record(signature, "login.example.com"), blockedAt: "2026-08-23T01:00:00.000Z", role: "current-password" }]);
  });

  it("rejects malformed or oversized records", () => {
    expect(() => normalizeBlockedFieldSignatures([record("A".repeat(64))])).toThrow("签名");
    expect(() => normalizeBlockedFieldSignatures([record("a".repeat(64), "bad host")])).toThrow("域名");
    expect(() => normalizeBlockedFieldSignatures(Array.from({ length: MAX_BLOCKED_FIELD_SIGNATURES + 1 }, (_, index) => record(index.toString(16).padStart(64, "0"))))).toThrow("256");
  });
});
