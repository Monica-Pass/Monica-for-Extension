import { chromium, expect, test, type BrowserContext, type Download, type Page, type Route, type TestInfo } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import path from "node:path";

const BACKUP_NAME = "monica_backup_20260715_140000_browser.zip";
const BACKUP_PATH = `folders/_root/passwords/password_42_1700000000000.json`;

async function launchExtension(testInfo: TestInfo): Promise<{ context: BrowserContext; extensionId: string; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("provider-resilience-profile"), {
    channel: "chromium",
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "provider resilience e2e password" }))).toMatchObject({ ok: true });
  await manager.reload();
  return { context, extensionId, manager };
}

test("WebDAV conflicts resolve explicitly, sync cancels promptly, and exported diagnostics stay redacted", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  let remotePassword = "initial-remote-secret";
  let remoteUpdatedAt = 1_700_000_001_000;
  let remoteEtag = '"remote-1"';
  let holdDownload = false;
  let releaseDownload: (() => void) | undefined;
  let markDownloadStarted: (() => void) | undefined;
  let downloadStarted = Promise.resolve();

  try {
    const launched = await launchExtension(testInfo);
    context = launched.context;
    await context.route("https://dav.example.test/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "PROPFIND" && /\/Monica_Backups\/?$/.test(url.pathname)) {
        await route.fulfill({ status: 207, contentType: "application/xml", body: multiStatus(remoteEtag) });
        return;
      }
      if (request.method() === "PROPFIND") {
        await route.fulfill({ status: 207, contentType: "application/xml", body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" />' });
        return;
      }
      if (request.method() === "GET" && url.pathname.endsWith(`/${BACKUP_NAME}`)) {
        if (holdDownload) {
          markDownloadStarted?.();
          await new Promise<void>((resolve) => { releaseDownload = resolve; });
        }
        await safeFulfill(route, androidZip(remotePassword, remoteUpdatedAt));
        return;
      }
      await route.fulfill({ status: 500, body: "unexpected fixture request" });
    });

    const saved = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({
      type: "WEBDAV_SAVE",
      name: "Resilient Android WebDAV",
      config: { baseUrl: "https://dav.example.test/root", username: "private-user", password: "private-webdav-password" },
      isDefaultSaveTarget: false
    })) as { ok: boolean; data?: { id: string }; error?: string };
    expect(saved, saved.error).toMatchObject({ ok: true });
    const providerId = saved.data!.id;

    expect(await sync(launched.manager, providerId)).toMatchObject({ ok: true, data: { conflicts: 0 } });
    const initialItems = await listItems(launched.manager);
    expect(initialItems).toEqual([expect.objectContaining({ password: "initial-remote-secret" })]);
    const local = { ...initialItems[0], password: "local-conflict-secret" };
    expect(await launched.manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), local)).toMatchObject({ ok: true });

    remotePassword = "remote-conflict-secret";
    remoteUpdatedAt = 1_700_000_005_000;
    remoteEtag = '"remote-2"';
    expect(await sync(launched.manager, providerId)).toMatchObject({ ok: true, data: { conflicts: 1 } });

    await launched.manager.getByRole("button", { name: "密码源" }).click();
    await expect(launched.manager.getByText("1 个冲突", { exact: true })).toBeVisible();
    await expect(launched.manager.getByText("敏感字段不在此处显示", { exact: false })).toBeVisible();
    launched.manager.once("dialog", (dialog) => dialog.accept());
    await launched.manager.getByRole("button", { name: "采用 Android 版本" }).click();
    await expect(launched.manager.getByText("1 个冲突", { exact: true })).toHaveCount(0);
    expect(await listItems(launched.manager)).toEqual([expect.objectContaining({ password: "remote-conflict-secret" })]);

    holdDownload = true;
    downloadStarted = new Promise<void>((resolve) => { markDownloadStarted = resolve; });
    await launched.manager.getByRole("button", { name: "立即同步" }).first().click();
    await downloadStarted;
    await expect(launched.manager.getByRole("button", { name: "取消同步" })).toBeVisible();
    await launched.manager.getByRole("button", { name: "取消同步" }).click();
    releaseDownload?.();
    await expect(launched.manager.getByRole("button", { name: "立即同步" }).first()).toBeVisible();
    await expect(launched.manager.getByText(/sync 已取消|网络请求失败/)).toHaveCount(0);
    const providerResponse = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" })) as { ok: boolean; data?: Array<{ id: string; lastError?: string }> };
    expect(providerResponse.data?.find((provider) => provider.id === providerId)?.lastError).toBeUndefined();

    const downloadPromise = launched.manager.waitForEvent("download");
    await launched.manager.getByRole("button", { name: "导出脱敏诊断" }).click();
    const diagnostic = await readDownload(await downloadPromise);
    expect(diagnostic).toMatchObject({ magic: "MONICA_PROVIDER_DIAGNOSTICS", version: 1, summary: { conflicts: 1, cancellations: 1 } });
    const serialized = JSON.stringify(diagnostic);
    for (const secret of ["private-user", "private-webdav-password", "dav.example.test", "local-conflict-secret", "remote-conflict-secret", providerId]) expect(serialized).not.toContain(secret);
  } finally {
    releaseDownload?.();
    await context?.close();
  }
});

async function sync(page: Page, providerId: string): Promise<{ ok: boolean; data?: { conflicts: number }; error?: string }> {
  return page.evaluate(async (id) => chrome.runtime.sendMessage({ type: "PROVIDER_SYNC", providerId: id }), providerId);
}

async function listItems(page: Page): Promise<Array<Record<string, any>>> {
  const response = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data?: Array<Record<string, any>>; error?: string };
  expect(response, response.error).toMatchObject({ ok: true });
  return response.data || [];
}

function androidZip(password: string, updatedAt: number): Uint8Array {
  return zipSync({
    [BACKUP_PATH]: strToU8(JSON.stringify({
      id: 42,
      title: "Conflict Account",
      username: "joy@example.com",
      password,
      website: "https://accounts.example.com",
      notes: "fixture",
      isFavorite: false,
      createdAt: 1_700_000_000_000,
      updatedAt
    }))
  });
}

function multiStatus(etag: string): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/root/Monica_Backups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/root/Monica_Backups/${BACKUP_NAME}</d:href><d:propstat><d:prop><d:getetag>${etag.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</d:getetag><d:getcontentlength>1024</d:getcontentlength><d:getlastmodified>Wed, 15 Jul 2026 14:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
  </d:multistatus>`;
}

async function safeFulfill(route: Route, bytes: Uint8Array): Promise<void> {
  try {
    await route.fulfill({ status: 200, contentType: "application/octet-stream", body: Buffer.from(bytes) });
  } catch {
    // An aborted fetch is the expected cancellation path.
  }
}

async function readDownload(download: Download): Promise<Record<string, any>> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
