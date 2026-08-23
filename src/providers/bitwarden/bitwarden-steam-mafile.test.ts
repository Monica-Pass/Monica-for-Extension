import { describe, expect, it } from "vitest";
import type { LoginItem } from "../../core/model";
import { isSteamMaFileLogin, parseSteamMaFile } from "./bitwarden-steam-mafile";

describe("Android Bitwarden Steam maFile contract", () => {
  it("recognizes Monica.Type instead of treating every Steam TOTP as an external account", () => {
    const base = { customFields: [{ name: "Monica.Type", value: "steam_mafile_v1", protected: false }] } as LoginItem;
    expect(isSteamMaFileLogin(base)).toBe(true);
    expect(isSteamMaFileLogin({ ...base, customFields: [{ name: "Monica.Type", value: "steam_mafile_pending_v1", protected: false }] })).toBe(false);
  });

  it("parses Monica's attachment fields and nested Steam session", () => {
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
    expect(parseSteamMaFile(raw, "joy.maFile")).toMatchObject({
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

  it("accepts Android's URI fallback for shared_secret", () => {
    const parsed = parseSteamMaFile(JSON.stringify({
      steamid: "76561199871008657",
      account_name: "joy",
      uri: "steam://QUJDREVGR0hJSktMTU5PUFFSU1Q%3D"
    }));
    expect(parsed.steamSharedSecretBase64).toBe("QUJDREVGR0hJSktMTU5PUFFSU1Q=");
  });
});
