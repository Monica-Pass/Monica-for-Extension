import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import os from "node:os";
import path from "node:path";

const extension = path.resolve("dist");
const profilePrefix = path.join(os.tmpdir(), "monica-icons-");
const now = "2026-09-15T08:00:00.000Z";
const login = (id: string, title: string, uris: string[]) => ({
  id, kind: "login", title, favorite: false, notes: "", createdAt: now, updatedAt: now,
  providerRefs: [], username: "synthetic@example.test", password: "Synthetic icon fixture password", uris, customFields: []
});

async function close(context: BrowserContext | undefined, profile: string) {
  await context?.close();
  const resolved = path.resolve(profile);
  if (!resolved.startsWith(profilePrefix) || path.dirname(resolved) !== path.dirname(profilePrefix)) throw new Error("Unexpected icon-test profile path");
  await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
}

test("website icons are private, cached, and consistent across lists, details and popup", async ({}, testInfo) => {
  const profile = await mkdtemp(profilePrefix);
  let context: BrowserContext | undefined;
  let server: Server | undefined;
  const requests: Array<{ url: string; cookie?: string; referer?: string }> = [];
  try {
    const icon = await readFile("public/icons/icon-32.png");
    const alternate = await readFile("public/icons/icon-16.png");
    // Deliberately public test-only key, bound to loopback. Native extension
    // requests can bypass Playwright routing, so exercise a real TLS transport.
    server = createHttpsServer({
      key: await readFile("tests/e2e/fixtures/website-icons.test-key.pem"),
      cert: await readFile("tests/e2e/fixtures/website-icons.test-cert.pem")
    }, (request, response) => {
      const url = `https://${request.headers.host}${request.url}`;
      const headers = request.headers;
      requests.push({ url, cookie: headers.cookie, referer: headers.referer });
      response.setHeader("content-type", "image/png");
      if (url === "https://icons.example.com/favicon.ico") response.end(icon);
      else if (url === "https://alternate.example.com/favicon.ico") response.end(alternate);
      else if (url === "https://broken.example.com/favicon.ico") response.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
      else { response.writeHead(404, { "content-type": "text/html" }); response.end("Missing icon"); }
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTPS fixture port");
    context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, locale: "zh-CN", args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--ignore-certificate-errors", "--no-proxy-server",
      `--host-resolver-rules=MAP *.example.com 127.0.0.1:${address.port}`
    ] });
    await context.addCookies([{ name: "session", value: "synthetic-cookie-secret", domain: "icons.example.com", path: "/", secure: true }]);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${extensionOrigin}/index.html`);
    await expect(page.getByRole("heading", { name: "创建加密密码库", exact: true })).toBeVisible();
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "Synthetic favicon fixture master password" }))).toMatchObject({ ok: true });
    const main = { ...login("icon-main", "Studio account", ["https://private-user:private-password@icons.example.com/sign-in?token=private-token#private-fragment"]), favorite: true };
    const fixtures = [
      main, login("icon-shared", "Studio secondary", ["icons.example.com/other"]),
      login("icon-missing", "Unavailable icon", ["https://missing.example.com"]),
      login("icon-broken", "Invalid image", ["https://broken.example.com"]),
      { ...login("icon-wifi", "Lab Wi-Fi", ["https://wifi.example.com"]), loginType: "WIFI" },
      login("icon-otp-uri", "App-only account", ["otpauth://totp/private?secret=private-otp", "androidapp://com.example.app"]),
      { ...login("icon-regex", "Pattern account", ["https://regex.example.com"]), uriRules: [{ uri: "https://regex.example.com", matchType: "regex" }] }
    ];
    expect(await page.evaluate(async items => {
      for (const item of items) {
        const result = await chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item });
        if (!result.ok) return result;
      }
      return { ok: true };
    }, fixtures)).toMatchObject({ ok: true });
    await page.reload();
    const mainCard = page.locator(".item-card").filter({ hasText: "Studio account" });
    await expect(mainCard.locator(".website-icon__image.is-loaded")).toBeVisible();
    await expect(mainCard.locator(".website-icon__favorite")).toBeVisible();
    await expect.poll(() => requests.filter(request => request.url === "https://icons.example.com/favicon.ico").length).toBe(1);
    await page.locator(".sidebar").getByRole("button", { name: /^登录项/ }).click();
    const row = (title: string) => page.locator(".credential-table tbody tr").filter({ hasText: title });
    await expect(row("Studio account").locator(".website-icon__image.is-loaded")).toBeVisible();
    const originalSource = await row("Studio account").locator(".website-icon__image").getAttribute("src");
    await expect.poll(() => requests.some(request => request.url === "https://broken.example.com/favicon.ico")).toBe(true);
    await expect(row("Invalid image").locator(".website-icon__image")).toHaveCount(0);
    await expect(row("Unavailable icon").locator(".website-icon__fallback")).toHaveJSProperty("name", "language");
    await expect(row("Lab Wi-Fi").locator(".website-icon__fallback")).toHaveJSProperty("name", "wifi");
    await expect(row("App-only account").locator(".website-icon__image")).toHaveCount(0);
    await expect(row("Pattern account").locator(".website-icon__image")).toHaveCount(0);
    await row("Studio account").locator(".row-title").click();
    await expect(page.locator(".detail-heading .website-icon__image.is-loaded")).toBeVisible();
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    expect(requests.filter(request => request.url === "https://icons.example.com/favicon.ico")).toHaveLength(1);

    // A live edit must replace the old icon rather than retain an image from the previous origin.
    expect(await page.evaluate(item => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), { ...main, uris: ["https://alternate.example.com/login"] })).toMatchObject({ ok: true });
    await expect(row("Studio account").locator(".website-icon__image.is-loaded")).not.toHaveAttribute("src", originalSource!);
    await page.screenshot({ path: testInfo.outputPath("password-list-icons.png"), fullPage: true });

    const summaries = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_LOGIN_SUMMARIES" }));
    expect(summaries.data.find((item: { id: string }) => item.id === "icon-main")).toMatchObject({ iconOrigin: "https://alternate.example.com" });
    expect(summaries.data.find((item: { id: string }) => item.id === "icon-regex")).toMatchObject({ iconOrigin: "" });
    expect(summaries.data.find((item: { id: string }) => item.id === "icon-wifi")).toMatchObject({ loginType: "WIFI", iconOrigin: "" });
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 390, height: 600 });
    await page.bringToFront();
    await popup.goto(`${extensionOrigin}/popup.html`);
    const popupRow = popup.locator(".login-row").filter({ hasText: "Studio account" });
    await expect(popupRow.locator(".website-icon__image.is-loaded")).toBeVisible();
    await expect(popupRow.locator(".website-icon__favorite")).toBeVisible();
    await expect(popup.locator(".login-row").filter({ hasText: "Lab Wi-Fi" }).locator(".website-icon__fallback")).toHaveJSProperty("name", "wifi");
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await popup.screenshot({ path: testInfo.outputPath("popup-icons.png"), fullPage: true });

    // Read-only rows remain legible and the independent copy targets stay inside
    // their row, including with long account names and enlarged system text.
    for (const [palette, scheme, width, scale] of [
      ["monica", "light", 390, 100], ["monica", "dark", 390, 100],
      ["nothing", "light", 390, 100], ["nothing", "dark", 390, 100],
      ["monica", "light", 320, 200]
    ] as const) {
      await popup.evaluate(([palette, scheme]) => {
        localStorage.setItem("monica.palette", palette);
        localStorage.setItem("monica.scheme", scheme);
      }, [palette, scheme]);
      await page.bringToFront();
      await popup.reload();
      await popup.setViewportSize({ width, height: 600 });
      await popup.evaluate(scale => { document.documentElement.style.fontSize = `${scale}%`; }, scale);
      await expect(popup.locator(".login-row")).toHaveCount(fixtures.length);
      await popup.evaluate(() => document.fonts.ready);
      await expect(popup.locator(".login-row-main").getByRole("button")).toHaveCount(0);
      const layout = await popup.locator(".login-row").evaluateAll(rows => rows.map(row => {
        const box = row.getBoundingClientRect();
        const icon = row.querySelector(".credential-icon")!.getBoundingClientRect();
        const title = row.querySelector(".popup-item-title")!.getBoundingClientRect();
        const controls = [...row.querySelectorAll("m3e-icon-button")].map(control => control.getBoundingClientRect());
        return {
          height: box.height,
          horizontal: icon.right <= title.left,
          contained: controls.every(control => control.width >= 44 && control.height >= 44 && control.left >= box.left && control.right <= box.right + 1 && control.top >= box.top && control.bottom <= box.bottom + 1),
          titleColor: getComputedStyle(row.querySelector(".popup-item-title")!).color,
          expectedColor: getComputedStyle(document.querySelector(".popup-shell")!).color
        };
      }));
      for (const row of layout) {
        expect(row.horizontal).toBe(true);
        expect(row.contained).toBe(true);
        expect(row.titleColor).toBe(row.expectedColor);
        if (scale === 100) expect(row.height).toBeLessThanOrEqual(80);
      }
      expect(await popup.evaluate(() => document.querySelector(".popup-shell")!.scrollWidth <= document.querySelector(".popup-shell")!.clientWidth)).toBe(true);
      await popup.evaluate(() => { document.querySelector(".popup-shell")!.scrollTop = 0; });
      if (scale > 100) await popup.locator(".login-row").first().scrollIntoViewIfNeeded();
      await popup.screenshot({ path: testInfo.outputPath(`popup-${palette}-${scheme}-${width}-${scale}.png`) });
    }

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.url).toMatch(/^https:\/\/(icons|alternate|missing|broken)\.example\.com\/favicon\.ico$/);
      expect(request.cookie).toBeUndefined();
      expect(request.referer).toBeUndefined();
    }
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
    await expect(page.locator(".website-icon__image")).toHaveCount(0);
  } finally {
    await close(context, profile);
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  }
});

test("a previously visited website uses the real Chromium favicon cache, including local HTTP", async ({}, testInfo) => {
  const profile = await mkdtemp(profilePrefix);
  let context: BrowserContext | undefined;
  let server: Server | undefined;
  let iconRequests = 0;
  try {
    const icon = await readFile("public/icons/icon-32.png");
    server = createServer((request, response) => {
      if (request.url === "/cached-icon.png" || request.url === "/favicon.ico") {
        iconRequests++;
        response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });
        response.end(icon);
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end('<!doctype html><title>Cached icon fixture</title><link rel="icon" href="/cached-icon.png" sizes="32x32"><form><input autocomplete="username"><input type="password" autocomplete="current-password"></form>');
      }
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const site = "http://cached.example.com";
    context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, locale: "zh-CN", args: [
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-proxy-server",
      `--host-resolver-rules=MAP cached.example.com 127.0.0.1:${address.port}`
    ] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
    const sitePage = await context.newPage();
    await sitePage.goto(`${site}/sign-in`);
    await expect.poll(() => iconRequests).toBeGreaterThan(0);
    const page = await context.newPage();
    await page.goto(`${extensionOrigin}/index.html`);
    await expect.poll(() => page.evaluate(async origin => {
      const image = async (pageUrl: string) => {
        const url = new URL(chrome.runtime.getURL("/_favicon/"));
        url.searchParams.set("pageUrl", pageUrl); url.searchParams.set("size", "32"); url.searchParams.set("fallbackToHost", "1");
        return Array.from(new Uint8Array(await (await fetch(url, { cache: "no-store" })).arrayBuffer())).join(",");
      };
      const fallback = await image("about:blank");
      return { origin: await image(origin) !== fallback, exactPage: await image(`${origin}/sign-in`) !== fallback };
    }, site)).toMatchObject({ origin: true });
    const hitsBeforeVault = iconRequests;
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "Synthetic cached icon master password" }))).toMatchObject({ ok: true });
    expect(await page.evaluate(item => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), login("cached", "Locally cached website", [`${site}/different-path?token=private`]))).toMatchObject({ ok: true });
    await page.reload();
    await expect(page.locator(".item-card .website-icon__image.is-loaded")).toBeVisible();
    const popup = await context.newPage();
    await sitePage.bringToFront();
    await popup.goto(`${extensionOrigin}/popup.html`);
    await expect(popup.locator(".site-summary .website-icon__image.is-loaded")).toBeVisible();
    await expect(popup.locator(".credential-card .website-icon__image.is-loaded").first()).toBeVisible();
    expect(iconRequests).toBe(hitsBeforeVault);
    await popup.screenshot({ path: testInfo.outputPath("cached-site-icon.png"), fullPage: true });
  } finally {
    await close(context, profile);
    await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve());
  }
});
