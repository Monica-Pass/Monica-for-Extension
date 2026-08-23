import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

async function launch(testInfo: TestInfo): Promise<{ context: BrowserContext; page: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("site-policy-profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 375, height: 720 },
    args: ["--disable-extensions-except=" + extensionPath, "--load-extension=" + extensionPath]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto("chrome-extension://" + extensionId + "/index.html");
  await page.getByLabel("主密码", { exact: true }).fill("site policy e2e password");
  await page.getByLabel("确认主密码", { exact: true }).fill("site policy e2e password");
  await page.getByRole("button", { name: "创建并解锁" }).click();
  await expect(page.getByRole("heading", { name: "密码库概览" })).toBeVisible();
  return { context, page };
}

test("settings manages encrypted autofill site exclusions in a compact dialog", async ({}, testInfo) => {
  const { context, page } = await launch(testInfo);
  try {
    const result = await page.evaluate(async () => chrome.runtime.sendMessage({
      type: "AUTOFILL_SITE_POLICY_SET",
      policy: { blockedHosts: ["blocked.example.com"], saveBlockedHosts: ["save.example.com"] }
    }));
    expect(result).toMatchObject({ ok: true, data: { blockedHosts: ["blocked.example.com"], saveBlockedHosts: ["save.example.com"] } });
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "设置与备份" }).click();
    await expect(page.getByRole("button", { name: /自动填充排除项/ })).toContainText("自动填充 1 个 · 保存提示 1 个");
    await page.getByRole("button", { name: /自动填充排除项/ }).click();
    const dialog = page.getByRole("dialog", { name: "自动填充排除项" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("blocked.example.com", { exact: true })).toBeVisible();
    await expect(dialog.getByText("save.example.com", { exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await dialog.getByLabel("排除类型").selectOption("blockedHosts");
    await dialog.getByPlaceholder("example.com").fill("new.example.org");
    await dialog.getByRole("button", { name: "添加" }).click();
    await dialog.getByRole("button", { name: "保存" }).click();
    await expect(dialog).toBeHidden();
    const persisted = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "AUTOFILL_SITE_POLICY_GET" }));
    expect(persisted).toMatchObject({ ok: true, data: { blockedHosts: ["blocked.example.com", "new.example.org"], saveBlockedHosts: ["save.example.com"] } });

    const login = await page.evaluate(async () => {
      const now = new Date().toISOString();
      return chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: {
        id: crypto.randomUUID(), kind: "login", title: "Blocked account", username: "joy@example.org", password: "blocked-secret",
        uris: ["new.example.org"], uriRules: [{ uri: "new.example.org", matchType: "base-domain" }], customFields: [],
        favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: []
      } });
    }) as { ok: boolean; data: { id: string } };
    expect(login.ok).toBe(true);
    await context.route("https://new.example.org/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><title>Blocked</title><form><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button id="submit">登录</button></form><button id="register">注册 Passkey</button><output id="result"></output><script>document.querySelector("form").addEventListener("submit",event=>event.preventDefault());register.onclick=async()=>{try{await navigator.credentials.create({publicKey:{challenge:new Uint8Array(32),rp:{id:"new.example.org",name:"Blocked"},user:{id:new Uint8Array(16),name:"joy@example.org",displayName:"Joy"},pubKeyCredParams:[{type:"public-key",alg:-7}]}});result.textContent="unexpected"}catch(error){result.textContent="blocked:"+error.name}}</script>'
    }));
    const target = await context.newPage();
    await target.goto("https://new.example.org/login");
    const tabId = await page.evaluate(async () => (await chrome.tabs.query({ url: "https://new.example.org/*" }))[0].id);
    const matches = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_MATCH_LOGINS", pageUrl: "https://new.example.org/login" }));
    expect(matches).toMatchObject({ ok: true, data: [] });
    const directFill = await page.evaluate(async ({ itemId, targetTabId }) => chrome.runtime.sendMessage({ type: "VAULT_FILL_LOGIN", itemId, tabId: targetTabId }), { itemId: login.data.id, targetTabId: tabId });
    expect(directFill).toMatchObject({ ok: false });
    await target.locator("#username").fill("joy@example.org");
    await target.locator("#password").fill("new-secret");
    await target.locator("#submit").click();
    await target.waitForTimeout(750);
    await expect(target.locator("#monica-save-prompt-host")).toHaveCount(0);
    await target.locator("#register").click();
    await expect(target.locator("#result")).toContainText("blocked:");
    const items = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data: Array<{ kind: string }> };
    expect(items.data.filter((item) => item.kind === "passkey")).toHaveLength(0);
  } finally {
    await context.close();
  }
});
