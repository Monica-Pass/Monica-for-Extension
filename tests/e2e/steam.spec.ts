import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import path from "node:path";

test("Steam Guard lists and responds to transaction confirmations and pending logins", async ({}, testInfo) => {
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

    await context.route("https://steamcommunity.com/mobileconf/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith("/getlist")) {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ success: true, conf: [{ id: "confirm-1", nonce: "nonce-1", headline: "Steam 市场交易", summary: ["Monica Item", "¥10"], creation_time: 1_700_000_000 }] }) });
      } else {
        await route.fulfill({ contentType: "application/json", body: '{"success":true}' });
      }
    });
    await context.route("https://api.steampowered.com/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.includes("GetAuthSessionsForAccount")) await route.fulfill({ contentType: "application/octet-stream", body: Buffer.from([0x08, 0x7b]) });
      else if (pathname.includes("GetAuthSessionInfo")) await route.fulfill({ contentType: "application/octet-stream", body: Buffer.from(protoSessionInfo()) });
      else await route.fulfill({ contentType: "application/octet-stream", headers: { "x-eresult": "1" }, body: Buffer.alloc(0) });
    });

    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    await manager.getByLabel("主密码", { exact: true }).fill("steam e2e master password");
    await manager.getByLabel("确认主密码", { exact: true }).fill("steam e2e master password");
    await manager.getByRole("button", { name: "创建并解锁" }).click();
    await expect(manager.getByRole("heading", { name: "密码库概览" })).toBeVisible();
    const now = new Date().toISOString();
    const upsert = await manager.evaluate(async ({ now, token }) => chrome.runtime.sendMessage({
      type: "VAULT_UPSERT_ITEM",
      item: { id: "steam-e2e", kind: "totp", title: "Steam E2E", favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], secret: "MTIzNDU2Nzg=", issuer: "Steam", accountName: "joy", otpType: "STEAM", algorithm: "SHA1", digits: 5, period: 30, steamId: "76561198000000000", steamDeviceId: "android:test", steamSharedSecretBase64: "MTIzNDU2Nzg=", steamIdentitySecret: "MTIzNDU2Nzg=", steamAccessToken: token }
    }), { now, token: jwt(4_102_444_800) }) as { ok: boolean; error?: string };
    expect(upsert.ok, upsert.error).toBe(true);
    await manager.reload();
    await manager.getByRole("button", { name: /动态验证码/ }).click();
    const row = manager.getByRole("row").filter({ hasText: "Steam E2E" });

    await row.getByRole("button", { name: "交易确认" }).click();
    await expect(row.getByText("Steam 市场交易", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "允许" }).click();
    await expect(row.getByText("Steam 市场交易", { exact: true })).toHaveCount(0);

    await row.getByRole("button", { name: "登录请求" }).click();
    await expect(row.getByText("Chrome on Windows", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "批准" }).click();
    await expect(row.getByText("Chrome on Windows", { exact: true })).toHaveCount(0);
  } finally {
    await context?.close();
  }
});

function protoSessionInfo(): number[] {
  return [
    ...fieldString(1, "203.0.113.8"),
    ...fieldString(3, "Shanghai"),
    ...fieldString(5, "CN"),
    ...fieldString(7, "Chrome on Windows"),
    0x40, 0x02
  ];
}

function fieldString(field: number, value: string): number[] {
  const bytes = [...Buffer.from(value, "utf8")];
  return [(field << 3) | 2, bytes.length, ...bytes];
}

function jwt(exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp })}.signature`;
}
