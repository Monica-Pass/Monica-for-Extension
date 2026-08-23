import { describe, expect, it } from "vitest";
import { projectSteamItem } from "./steam-item";

describe("Steam Bitwarden projection", () => {
  it("projects an Android-compatible steam:// login without changing its id", () => {
    const item = {
      id: "bitwarden:provider:cipher",
      kind: "login" as const,
      title: "Steam",
      username: "joy",
      password: "",
      uris: [],
      totpSecret: "steam://QUJDREVGR0hJSktMTU5PUFFSU1Q=",
      customFields: [],
      favorite: false,
      notes: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      providerRefs: [{ providerId: "provider", remoteId: "cipher" }]
    };
    const projected = projectSteamItem(item);
    expect(projected?.kind).toBe("totp");
    expect(projected?.otpType).toBe("STEAM");
    expect(projected?.digits).toBe(5);
    expect(projected?.period).toBe(30);
    expect(projected?.secret).toBe("QUJDREVGR0hJSktMTU5PUFFSU1Q=");
    expect(projected?.id).toBe(item.id);
  });

  it("ignores ordinary Bitwarden login TOTP values", () => {
    const item = { kind: "login", totpSecret: "JBSWY3DPEHPK3PXP" } as never;
    expect(projectSteamItem(item)).toBeUndefined();
  });
});
