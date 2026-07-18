import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

test("Steam manager handles approvals, inventory, market listings, and devices", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("steam-profile"), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;

    await context.route("https://steamcommunity.com/**", async (route) => {
      const url = new URL(route.request().url());
      const pathname = url.pathname;
      if (pathname.endsWith("/mobileconf/getlist")) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true, conf: [{ id: "confirm-1", nonce: "nonce-1", type: "3", headline: "Steam 市场交易", summary: ["Monica Item", "¥10"], creation_time: 1_700_000_000 }] }) });
      } else if (pathname.startsWith("/mobileconf/")) {
        await route.fulfill({ contentType: "application/json", body: '{"success":true}' });
      } else if (pathname.endsWith("/inventory/")) {
        await route.fulfill({ contentType: "text/html", body: inventoryOverviewHtml() });
      } else if (pathname.startsWith("/inventory/")) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(inventoryPage()) });
      } else if (pathname.endsWith("/market/priceoverview/")) {
        await route.fulfill({ contentType: "application/json", body: '{"success":true,"lowest_price":"¥ 1.17","median_price":"¥ 2.67","volume":"12"}' });
      } else if (pathname.endsWith("/market/pricehistory/")) {
        await route.fulfill({ contentType: "application/json", body: '{"success":true,"prices":[["Jul 17",1.17,"2"],["Jul 18",2.67,"1"]]}' });
      } else if (pathname.endsWith("/market/mylistings/")) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(marketListings()) });
      } else if (pathname.endsWith("/market/sellitem/") || pathname.includes("/market/removelisting/")) {
        await route.fulfill({ contentType: "application/json", body: '{"success":true,"requires_confirmation":false}' });
      } else if (pathname.startsWith("/miniprofile/")) {
        await route.fulfill({ contentType: "application/json", body: '{}' });
      } else {
        await route.fulfill({ status: 404, contentType: "application/json", body: '{}' });
      }
    });
    await context.route("https://api.steampowered.com/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.includes("GetPasswordRSAPublicKey")) await route.fulfill({ contentType: "application/json", body: JSON.stringify({ response: { publickey_mod: "ff".repeat(128), publickey_exp: "01", timestamp: "1700000000" } }) });
      else if (pathname.includes("GetAuthSessionsForAccount")) await route.fulfill({ contentType: "application/octet-stream", headers: { "x-eresult": "1" }, body: Buffer.from([0x08, 0x7b]) });
      else if (pathname.includes("GetAuthSessionInfo")) await route.fulfill({ contentType: "application/octet-stream", headers: { "x-eresult": "1" }, body: Buffer.from(protoSessionInfo()) });
      else if (pathname.includes("EnumerateTokens")) await route.fulfill({ contentType: "application/octet-stream", headers: { "x-eresult": "1" }, body: Buffer.from(protoAuthorizedDevices()) });
      else if (pathname.includes("BeginAuthSessionViaCredentials")) await route.fulfill({ contentType: "application/octet-stream", headers: { "x-eresult": "1" }, body: Buffer.from([...fieldVarint(1, 123n), ...fieldBytes(2, [1, 2, 3, 4]), ...fieldFixed64(5, 76561198000000000n)]) });
      else if (pathname.includes("PollAuthSessionStatus")) await route.fulfill({ contentType: "application/octet-stream", headers: { "x-eresult": "1" }, body: Buffer.from([...fieldString(3, "refresh-temp"), ...fieldString(4, "access-temp")]) });
      else await route.fulfill({ contentType: "application/octet-stream", headers: { "x-eresult": "1" }, body: Buffer.alloc(0) });
    });

    const manager = await context.newPage();
    await manager.setViewportSize({ width: 1280, height: 900 });
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    await manager.getByLabel("主密码", { exact: true }).fill("steam e2e master password");
    await manager.getByLabel("确认主密码", { exact: true }).fill("steam e2e master password");
    await manager.getByRole("button", { name: "创建并解锁" }).click();
    await expect(manager.getByRole("heading", { name: "密码库概览" })).toBeVisible();
    const now = new Date().toISOString();
    const accessToken = jwt(4_102_444_800);
    const upsert = await manager.evaluate(async ({ now, token }) => chrome.runtime.sendMessage({
      type: "VAULT_UPSERT_ITEM",
      item: { id: "steam-e2e", kind: "totp", title: "Steam E2E", favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], secret: "MTIzNDU2Nzg=", issuer: "Steam", accountName: "joy", otpType: "STEAM", algorithm: "SHA1", digits: 5, period: 30, steamId: "76561198000000000", steamDeviceId: "android:test", steamSharedSecretBase64: "MTIzNDU2Nzg=", steamIdentitySecret: "MTIzNDU2Nzg=", steamAccessToken: token }
    }), { now, token: accessToken }) as { ok: boolean; error?: string };
    expect(upsert.ok, upsert.error).toBe(true);
    const safeResponses = await manager.evaluate(async (itemId) => Promise.all([
      chrome.runtime.sendMessage({ type: "STEAM_LIST_AUTHORIZED_DEVICES", itemId }),
      chrome.runtime.sendMessage({ type: "STEAM_GET_INVENTORY_OVERVIEW", itemId })
    ]), "steam-e2e");
    const serializedResponses = JSON.stringify(safeResponses);
    for (const forbidden of [accessToken, "MTIzNDU2Nzg=", "steamLoginSecure", "access_token", "refresh_token"]) expect(serializedResponses).not.toContain(forbidden);
    await manager.reload();
    await manager.getByRole("button", { name: /^Steam/ }).click();
    const account = manager.locator(".steam-account-panel").filter({ hasText: "Steam E2E" });
    await expect(account).toBeVisible();

    await account.getByRole("button", { name: "刷新待批准操作" }).click();
    await expect(account.getByText("Steam 市场交易", { exact: true })).toBeVisible();
    await expect(account.getByText("Chrome on Windows", { exact: true })).toBeVisible();
    await account.getByRole("button", { name: "允许" }).click();
    await account.getByRole("button", { name: "批准", exact: true }).click();

    await account.getByRole("tab", { name: "库存" }).click();
    await expect(account.getByText("Monica Weapon Case", { exact: true })).toBeVisible();
    await account.getByLabel("选择Monica Weapon Case").check();
    await account.getByRole("button", { name: "读取报价" }).click();
    await expect(account.getByText(/最低 ¥ 1.17/)).toBeVisible();
    manager.once("dialog", (dialog) => void dialog.accept());
    await account.getByRole("button", { name: "出售选中项" }).click();
    await expect(account.getByText(/已提交 1 项出售/)).toBeVisible();

    await account.getByRole("tab", { name: "市场" }).click();
    await expect(account.getByText("Monica Market Item", { exact: true })).toBeVisible();
    await account.getByLabel("选择Monica Market Item").check();
    manager.once("dialog", (dialog) => void dialog.accept());
    await account.getByRole("button", { name: "撤销选中挂单" }).click();
    await expect(account.getByText(/已撤销 1 个市场挂单/)).toBeVisible();

    await account.getByRole("tab", { name: "设备" }).click();
    await expect(account.getByText(/Chrome on Windows/)).toBeVisible();
    await expect(account.getByText("当前设备", { exact: true })).toBeVisible();
    const oldDevice = account.getByRole("listitem").filter({ hasText: "Old phone" });
    await oldDevice.getByRole("button", { name: "撤销", exact: true }).click();
    await account.getByLabel("Steam 账号名").fill("joy");
    await account.getByLabel("Steam 密码").fill("one-time-password");
    manager.once("dialog", (dialog) => void dialog.accept());
    await account.getByRole("button", { name: "撤销设备授权" }).click();
    await expect(account.getByText(/Steam 授权设备已撤销/)).toBeVisible();
    await expect(account.getByText("Old phone", { exact: true })).toHaveCount(0);
    await expect(account.getByLabel("Steam 密码")).toHaveCount(0);

    await manager.screenshot({ path: testInfo.outputPath("steam-manager-desktop.png"), fullPage: true });
    await manager.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => manager.evaluate(() => document.querySelector(".sidebar")?.getBoundingClientRect().right || 0)).toBeLessThanOrEqual(1);
    const mobileLayout = await manager.evaluate(() => {
      const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
      const main = document.querySelector("main")?.getBoundingClientRect();
      return { width: innerWidth, shellClass: document.querySelector(".shell")?.className || "", sidebarRight: sidebar?.right || 0, mainLeft: main?.left || 0, fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
    });
    expect(mobileLayout).toMatchObject({ width: 390, shellClass: "shell", fits: true });
    expect(mobileLayout.sidebarRight).toBeLessThanOrEqual(1);
    expect(mobileLayout.mainLeft).toBe(0);
    const accessibility = await new AxeBuilder({ page: manager }).include(".steam-account-panel").analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    await manager.screenshot({ path: testInfo.outputPath("steam-manager-mobile.png"), fullPage: true });
  } finally {
    await context?.close();
  }
});

function inventoryOverviewHtml(): string {
  return `<script>var g_rgAppContextData = {"730":{"appid":730,"name":"Counter-Strike 2","rgContexts":{"2":{"name":"Backpack","asset_count":1}}}}; var g_rgWalletInfo = {"wallet_currency":23,"wallet_fee_percent":"0.05","wallet_publisher_fee_percent_default":"0.10","wallet_market_minimum":7,"wallet_currency_increment":1};</script>`;
}

function inventoryPage() {
  return {
    success: 1,
    total_inventory_count: 1,
    more_items: false,
    assets: [{ appid: 730, contextid: "2", assetid: "99", classid: "20", instanceid: "0", amount: "1" }],
    descriptions: [{ classid: "20", instanceid: "0", market_hash_name: "Monica Weapon Case", name: "Monica Weapon Case", type: "Container", icon_url: "test-image", marketable: 1, tradable: 1, commodity: 0, market_fee: "0.1" }]
  };
}

function marketListings() {
  return {
    num_active_listings: 1,
    listings: [{ listingid: "500", price: 100, fee: 17, active: 1, time_created: "1700000000", asset: { appid: 730, contextid: "2", id: "88", market_hash_name: "Monica Market Item", name: "Monica Market Item", icon_url: "market-image" } }]
  };
}

function protoSessionInfo(): number[] {
  return [...fieldString(1, "203.0.113.8"), ...fieldString(3, "Shanghai"), ...fieldString(5, "CN"), ...fieldString(7, "Chrome on Windows"), 0x40, 0x02];
}

function protoAuthorizedDevices(): number[] {
  const usage = [...fieldVarint(1, 1_700_000_000n), ...fieldString(4, "CN"), ...fieldString(5, "Shanghai"), ...fieldString(6, "Shanghai")];
  const device = [...fieldFixed64(1, 42n), ...fieldString(2, "Chrome on Windows"), ...fieldVarint(4, 3n), ...fieldVarint(5, 1n), ...fieldBytes(10, usage)];
  const oldDevice = [...fieldFixed64(1, 43n), ...fieldString(2, "Old phone"), ...fieldVarint(4, 2n), ...fieldVarint(5, 1n), ...fieldBytes(10, usage)];
  return [...fieldBytes(1, device), ...fieldBytes(1, oldDevice), ...fieldFixed64(2, 42n)];
}

function fieldString(field: number, value: string): number[] {
  return fieldBytes(field, [...Buffer.from(value, "utf8")]);
}

function fieldBytes(field: number, value: number[]): number[] {
  return [(field << 3) | 2, ...rawVarint(BigInt(value.length)), ...value];
}

function fieldVarint(field: number, value: bigint): number[] {
  return [field << 3, ...rawVarint(value)];
}

function fieldFixed64(field: number, value: bigint): number[] {
  const bytes: number[] = [];
  let current = value;
  for (let index = 0; index < 8; index++) { bytes.push(Number(current & 0xffn)); current >>= 8n; }
  return [(field << 3) | 1, ...bytes];
}

function rawVarint(value: bigint): number[] {
  const bytes: number[] = [];
  let current = value;
  while (current > 0x7fn) { bytes.push(Number((current & 0x7fn) | 0x80n)); current >>= 7n; }
  bytes.push(Number(current));
  return bytes;
}

function jwt(exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}
