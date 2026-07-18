import { describe, expect, it } from "vitest";
import type { TotpItem } from "./model";
import { exportSteamMaFile, parseSteamMaFile } from "./steam-mafile";

describe("Steam maFile codec", () => {
  it("parses aliases and preserves unknown fields for export", () => {
    const raw = JSON.stringify({ account_name: "alice", steamid: "76561198000000000", shared_secret: "MTIzNDU2Nzg=", identity_secret: "identity", future_field: { keep: true }, Session: { SteamLoginSecure: "76561198000000000||token" } });
    const parsed = parseSteamMaFile(raw, "alice.maFile");
    expect(parsed).toMatchObject({ accountName: "alice", steamId: "76561198000000000", sharedSecretBase64: "MTIzNDU2Nzg=", identitySecret: "identity", accessToken: "token" });
    const base = { id: "steam", kind: "totp", title: "Alice", favorite: false, notes: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", providerRefs: [], secret: parsed.sharedSecretBase64, otpType: "STEAM", algorithm: "SHA1", digits: 5, period: 30, steamRawJson: parsed.rawJson } satisfies TotpItem;
    expect(JSON.parse(exportSteamMaFile(base))).toMatchObject({ future_field: { keep: true }, account_name: "Alice" });
  });

  it("rejects encrypted or malformed maFile text explicitly", () => {
    expect(() => parseSteamMaFile("not-json")).toThrow("解密");
  });
});
