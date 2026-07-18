import { afterEach, describe, expect, it, vi } from "vitest";
import type { TotpItem } from "../../core/model";
import { cancelSteamMarketListing, findNewSteamMarketConfirmations, listSteamInventoryItems, parseLocalizedSteamPriceMinorUnits, parseSteamInventoryOverview, parseSteamInventoryPage, parseSteamMarketHistory, parseSteamMarketListings, parseSteamMarketPrice, resolveSteamSellerReceive, sanitizeSteamAssetUrl, sellSteamMarketItems, steamCommunityLanguage, steamMarketFeeBreakdown, steamSellerReceiveFromBuyerTotal, type SteamWalletInfo } from "./steam-market";

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
  steamIdentitySecret: "MTIzNDU2Nzg=",
  steamDeviceId: "android:test-device",
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

  it("parses localized market overview and recent history", () => {
    expect(parseSteamMarketPrice({ success: true, lowest_price: "¥ 1,23", median_price: "¥ 1,45", volume: "1,234" })).toEqual({ lowestPrice: "¥ 1,23", medianPrice: "¥ 1,45", volume: 1234 });
    expect(parseSteamMarketHistory({ success: true, prices: [["Jul 17", 1.2, "2"], ["Jul 18", "1.4", "1,001"]] }, 1)).toEqual([{ label: "Jul 18", price: 1.4, volume: 1001 }]);
  });

  it("parses active listings and preserves pagination based on raw rows", () => {
    const page = parseSteamMarketListings({
      num_active_listings: 3,
      listings: [
        { listingid: "100", price: 90, fee: 10, active: 1, time_created: "1700000000", asset: { appid: 730, contextid: "2", id: "9", market_hash_name: "Case", name: "Weapon Case", icon_url: "image-key" } },
        { listingid: "101", active: 0, asset: { appid: 730, contextid: "2", id: "10" } }
      ]
    }, 0, 2);
    expect(page).toEqual({
      items: [expect.objectContaining({ listingId: "100", sellerReceives: 90, fee: 10, buyerPrice: 100, active: true })],
      totalActive: 3,
      nextStart: 2,
      hasMore: true
    });
  });

  it("matches Android localized price and fee calculations", () => {
    const wallet: SteamWalletInfo = { currency: 23, steamFeePercent: 0.05, publisherFeePercent: 0.1, marketMinimum: 7, currencyIncrement: 1 };
    expect(parseLocalizedSteamPriceMinorUnits("¥ 1.17")).toBe(117);
    expect(parseLocalizedSteamPriceMinorUnits("€ 1,17")).toBe(117);
    expect(parseLocalizedSteamPriceMinorUnits("$1,234.56 USD")).toBe(123456);
    expect(parseLocalizedSteamPriceMinorUnits("₹ 7")).toBe(700);
    expect(steamMarketFeeBreakdown(100, wallet)).toEqual({ receive: 100, steamFee: 7, publisherFee: 10, totalFee: 17, buyerPays: 117 });
    for (const receive of [7, 10, 50, 100, 233, 999, 1000, 12345]) expect(steamSellerReceiveFromBuyerTotal(steamMarketFeeBreakdown(receive, wallet).buyerPays, wallet)).toBe(receive);
    expect(resolveSteamSellerReceive("lowest-listing", { price: { lowestPrice: "¥ 1.17" }, history: [] }, wallet)).toBe(100);
  });

  it("submits a validated sell request with seller-receive pricing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true,"requires_confirmation":false}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sellSteamMarketItems(item, { entries: [{ appId: 730, contextId: "2", assetId: "99", priceReceive: 100 }] });
    expect(result.items).toEqual([{ assetId: "99", success: true, requiresConfirmation: false, message: undefined }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/market/sellitem/");
    expect(String(init.body)).toContain("assetid=99");
    expect(String(init.body)).toContain("price=100");
    expect(init.referrer).toContain(`/profiles/${item.steamId}/inventory/`);
  });

  it("auto-confirms only newly created market confirmations", async () => {
    const old = { id: "old", nonce: "old-nonce", type: "3", headline: "Market listing", summary: "", creation_time: 1 };
    const market = { id: "market", nonce: "market-nonce", type: "3", headline: "Market listing", summary: "Case", creation_time: 2 };
    const trade = { id: "trade", nonce: "trade-nonce", type: "2", headline: "Trade offer", summary: "Item", creation_time: 2 };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, conf: [old] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"success":true,"requires_confirmation":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, conf: [old, market, trade] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await sellSteamMarketItems(item, { entries: [{ appId: 730, contextId: "2", assetId: "99", priceReceive: 100 }], autoConfirm: true }, { pollAttempts: 1, pollIntervalMs: 0 });
    expect(result.newConfirmations.map((entry) => entry.id)).toEqual(["market"]);
    expect(result.approvedConfirmationIds).toEqual(["market"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body)).toContain("cid=market");
  });

  it("cancels numeric listings and rejects path injection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(cancelSteamMarketListing(item, "123")).resolves.toBe(true);
    expect(new URL(fetchMock.mock.calls[0]?.[0] as string).pathname).toBe("/market/removelisting/123");
    await expect(cancelSteamMarketListing(item, "123/../../login")).rejects.toThrow("无效");
  });

  it("filters existing and non-market confirmations", () => {
    const base = { nonce: "n", summary: "", imageUrl: "", creationTime: 0 };
    expect(findNewSteamMarketConfirmations(new Set(["old"]), [
      { ...base, id: "old", type: "3", headline: "Market listing" },
      { ...base, id: "trade", type: "2", headline: "Trade offer" },
      { ...base, id: "new", type: "3", headline: "Market listing" }
    ]).map((entry) => entry.id)).toEqual(["new"]);
  });
});

function jwt(exp: number): string {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}
