import { describe, expect, it } from "vitest";
import type { LoginItem } from "../../core/model";
import { isSteamMaFileLogin, parseSteamMaFile } from "./bitwarden-steam-mafile";

describe("Android Bitwarden Steam maFile contract", () => {
  it("recognizes Monica.Type instead of treating every Steam TOTP as an external account", () => {
    const base = { customFields: [{ name: "Monica.Type", value: "steam_mafile_v1", protected: false }] } as LoginItem;
    expect(isSteamMaFileLogin(base)).toBe(true);
    expect(isSteamMaFileLogin({ ...base, customFields: [{ name: "Monica.Type", value: "steam_mafile_pending_v1", protected: false }] })).toBe(false);
  });

  it("parses Monica's attachment fields and nested Steam session", async () => {
    const raw = JSON.stringify({
      steamid: "76561199871008657",
      account_name: "joy",
      device_id: "android:device",
      shared_secret: "QUJDREVGR0hJSktMTU5PUFFSU1Q=",
      identity_secret: "identity",
      revocation_code: "R1234",
      token_gid: "42",
      Session: {
        AccessToken: "access",
        RefreshToken: "refresh",
        SteamLoginSecure: "76561199871008657||access"
      }
    });
    await expect(parseSteamMaFile(raw, "joy.maFile")).resolves.toMatchObject({
      steamAccountName: "joy",
      steamId: "76561199871008657",
      steamDeviceId: "android:device",
      steamSharedSecretBase64: "QUJDREVGR0hJSktMTU5PUFFSU1Q=",
      steamIdentitySecret: "identity",
      steamRevocationCode: "R1234",
      steamTokenGid: "42",
      steamAccessToken: "access",
      steamRefreshToken: "refresh",
      steamLoginSecure: "76561199871008657||access"
    });
  });

  it("accepts Android's URI fallback for shared_secret", async () => {
    const parsed = await parseSteamMaFile(JSON.stringify({
      steamid: "76561199871008657",
      account_name: "joy",
      uri: "steam://QUJDREVGR0hJSktMTU5PUFFSU1Q%3D"
    }));
    expect(parsed.steamSharedSecretBase64).toBe("QUJDREVGR0hJSktMTU5PUFFSU1Q=");
  });

  it("matches Android's missing SteamID marker and stable local identifier", async () => {
    const parsed = await parseSteamMaFile(JSON.stringify({
      account_name: "missing-id",
      monica_display_name: "显示名称",
      monica_missing_steamid: true,
      shared_secret: "QUJDREVGR0hJSktMTU5PUFFSU1Q=",
      identity_secret: "identity",
      token_gid: "42",
      revocation_code: "R1234"
    }));

    expect(parsed.steamAccountName).toBe("missing-id");
    expect(parsed.steamDisplayName).toBe("显示名称");
    expect(parsed.steamId).toBe("monica-missing-steamid-6c401bfc940d37c6d4aa4827");
  });

  it("rejects missing or malformed SteamID unless Monica explicitly marked it", async () => {
    const base = { account_name: "invalid", shared_secret: "QUJDREVGR0hJSktMTU5PUFFSU1Q=" };
    await expect(parseSteamMaFile(JSON.stringify(base))).rejects.toThrow("缺少 SteamID");
    await expect(parseSteamMaFile(JSON.stringify({ ...base, steamid: "not-a-steamid" }))).rejects.toThrow("缺少 SteamID");
  });
});
