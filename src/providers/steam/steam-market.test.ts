import { afterEach, describe, expect, it, vi } from "vitest";
import type { TotpItem } from "../../core/model";
import { listSteamInventoryItems, parseSteamInventoryOverview, parseSteamInventoryPage, sanitizeSteamAssetUrl, steamCommunityLanguage } from "./steam-market";

const item: TotpItem = {
  id: "steam-item",
  kind: "totp",
  title: "Steam",
  favorite: false,
  notes: "",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
  providerRefs: [],
  secret: "MTIzNDU2Nzg=",
  steamId: "76561198000000000",
  steamAccessToken: jwt(4_102_444_800),
  otpType: "STEAM",
  algorithm: "SHA1",
  digits: 5,
  period: 30
};

afterEach(() => vi.unstubAllGlobals());

describe("Steam inventory", () => {
  it("parses Android-compatible inventory games and wallet settings", () => {
    const html = `<script>var g_rgAppContextData = {"730":{"appid":730,"name":"Counter-Strike 2","icon":"https://cdn.cloudflare.steamstatic.com/icon.png","rgContexts":{"2":{"name":"Backpack","asset_count":3}}}}; var g_rgWalletInfo = {"wallet_currency":23,"wallet_fee_percent":"0.05","wallet_publisher_fee_percent_default":"0.10","wallet_market_minimum":1,"wallet_currency_increment":1};</script>`;
    expect(parseSteamInventoryOverview(html)).toEqual({
      games: [expect.objectContaining({ appId: 730, contextId: "2", itemCount: 3, name: "Counter-Strike 2" })],
      wallet: { currency: 23, steamFeePercent: 0.05, publisherFeePercent: 0.1, marketMinimum: 1, currencyIncrement: 1 }
    });
  });

  it("parses paginated assets and description metadata", () => {
    const page = parseSteamInventoryPage({
      success: 1,
      total_inventory_count: 2,
      more_items: true,
      last_assetid: "99",
      assets: [{ appid: 730, contextid: "2", assetid: "10", classid: "20", instanceid: "0", amount: "2" }],
      descriptions: [{ classid: "20", instanceid: "0", market_hash_name: "Case", name: "Weapon Case", type: "Container", icon_url: "image-key", marketable: 1, tradable: 1, commodity: 0, market_fee: "0.1" }]
    });
    expect(page).toEqual({
      items: [expect.objectContaining({ appId: 730, contextId: "2", assetId: "10", amount: 2, marketHashName: "Case", marketable: true, iconUrl: "https://community.fastly.steamstatic.com/economy/image/image-key" })],
      lastAssetId: "99",
      hasMore: true,
      totalCount: 2
    });
  });

  it("requests inventory pages with a temporary market session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"assets":[],"descriptions":[],"more_items":false}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await listSteamInventoryItems(item, { appId: 730, contextId: "2", language: "zh-CN", count: 75 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/inventory/${item.steamId}/730/2`);
    expect(parsed.searchParams.get("l")).toBe("schinese");
    expect((init.headers as Record<string, string>).Cookie).toMatch(/sessionid=[0-9a-f]{24}/);
  });

  it("keeps media on official HTTPS Steam hosts", () => {
    expect(sanitizeSteamAssetUrl("https://cdn.cloudflare.steamstatic.com/item.png")).toContain("steamstatic.com");
    expect(sanitizeSteamAssetUrl("http://cdn.cloudflare.steamstatic.com/item.png")).toBe("");
    expect(sanitizeSteamAssetUrl("https://example.com/item.png")).toBe("");
  });

  it("maps Android Steam language names", () => {
    expect(steamCommunityLanguage("zh-Hant")).toBe("tchinese");
    expect(steamCommunityLanguage("fr-FR")).toBe("english");
  });
});

function jwt(exp: number): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}
