import { describe, expect, it } from "vitest";
import type { TotpItem } from "./model";
import { exportSteamMaFile, parseSteamMaFile, parseSteamMaFileBundle } from "./steam-mafile";

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

  it("decrypts Android manifest.json AES-CBC maFiles", async () => {
    const plaintext = JSON.stringify({ account_name: "alice", steamid: "76561198000000000", shared_secret: "MTIzNDU2Nzg=" });
    const password = "test-password";
    const salt = Uint8Array.from({ length: 8 }, (_, index) => index + 1);
    const iv = Uint8Array.from({ length: 16 }, (_, index) => index + 2);
    const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 50_000, hash: "SHA-1" }, baseKey, { name: "AES-CBC", length: 256 }, false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(plaintext));
    const b64 = (bytes: Uint8Array) => { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };
    const entries = [
      { name: "alice.maFile", content: b64(new Uint8Array(encrypted)) },
      { name: "manifest.json", content: JSON.stringify({ entries: [{ filename: "alice.maFile", encryption_salt: b64(salt), encryption_iv: b64(iv) }] }) }
    ];
    await expect(parseSteamMaFileBundle(entries, password)).resolves.toMatchObject({ accountName: "alice", steamId: "76561198000000000" });
    await expect(parseSteamMaFileBundle(entries, "wrong")).rejects.toThrow("无法解密");
  });
});
