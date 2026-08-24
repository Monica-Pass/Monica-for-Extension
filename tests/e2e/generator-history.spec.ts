import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import path from "node:path";

test("Android generator history stays compact masked and deletable", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  const historyPath = "Monica_20260824_120000_generated_history.json";
  const history = [
    { password: "android-generated-secret", timestamp: 1_700_000_003_000, domain: "example.com", username: "joy", type: "AUTOFILL" },
    { password: "246810", timestamp: 1_700_000_002_000, type: "PIN", future: { keep: true } }
  ];
  let remote = zipSync({ [historyPath]: strToU8(JSON.stringify(history)) });
  let latestName = "monica_backup_20260824_120000.zip";
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("generator-history-profile"), {
      channel: "chromium",
      headless: true,
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    await context.route("https://history-dav.example.test/**", async (route) => {
      const request = route.request();
      const method = request.method();
      const depth = request.headers()["depth"];
      if (method === "PROPFIND" && depth === "1") {
        const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Monica_Backups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/Monica_Backups/${latestName}</d:href><d:propstat><d:prop><d:getetag>&quot;history&quot;</d:getetag><d:getlastmodified>Mon, 24 Aug 2026 04:00:00 GMT</d:getlastmodified><d:getcontentlength>${remote.byteLength}</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>`;
        await route.fulfill({ status: 207, contentType: "application/xml", body: xml });
      } else if (method === "PROPFIND") {
        await route.fulfill({ status: 207, contentType: "application/xml", body: "<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"/>" });
      } else if (method === "GET") {
        await route.fulfill({ status: 200, contentType: "application/zip", body: Buffer.from(remote) });
      } else if (method === "PUT") {
        remote = new Uint8Array(request.postDataBuffer()!);
        latestName = new URL(request.url()).pathname.split("/").pop()!;
        await route.fulfill({ status: 201, headers: { etag: '"history-next"' } });
      } else {
        await route.fulfill({ status: 405 });
      }
    });

    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "generator history e2e password" }))).toMatchObject({ ok: true });
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({
      type: "WEBDAV_SAVE",
      name: "Android WebDAV",
      config: { baseUrl: "https://history-dav.example.test/dav", username: "joy", password: "secret" }
    }))).toMatchObject({ ok: true });
    await page.reload();

    await page.getByRole("button", { name: "生成器" }).click();
    await page.getByText("Android 生成历史", { exact: true }).click();
    await expect(page.locator(".generator-history-list li")).toHaveCount(2);
    await expect(page.getByText("android-generated-secret", { exact: true })).toHaveCount(0);
    await expect(page.locator(".generator-history-main code").first()).toHaveText("••••••••");
    await page.getByRole("button", { name: "显示生成值" }).first().click();
    await expect(page.getByText("android-generated-secret", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "删除生成历史" }).first().click();
    await page.getByRole("button", { name: "确认删除" }).click();
    await expect(page.locator(".generator-history-list li")).toHaveCount(1);
    const retained = JSON.parse(strFromU8(unzipSync(remote)[historyPath]));
    expect(retained).toEqual([history[1]]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const accessibility = await new AxeBuilder({ page }).include(".generator-history").analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("android-generator-history.png"), fullPage: true });
  } finally {
    await context?.close();
  }
});
