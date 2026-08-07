import { chromium, expect, test, type BrowserContext, type Download, type Page, type Route, type TestInfo } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import path from "node:path";
import { buildKeePassFixture } from "../../src/providers/keepass/keepass-fixture";

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
      config: {
        baseUrl: "https://dav.example.test/root",
        username: "private-user",
        password: "private-webdav-password",
        backupPassword: "private-backup-password"
      },
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
    for (const secret of ["private-user", "private-webdav-password", "private-backup-password", "dav.example.test", "local-conflict-secret", "remote-conflict-secret", providerId]) expect(serialized).not.toContain(secret);
  } finally {
    releaseDownload?.();
    await context?.close();
  }
});

test("Android WebDAV backup encryption password is optional and has no minimum length", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo);
    context = launched.context;
    await context.route("https://optional-dav.example.test/**", async (route) => {
      if (route.request().method() === "PROPFIND") {
        await route.fulfill({ status: 207, contentType: "application/xml", body: '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" />' });
        return;
      }
      await route.fulfill({ status: 500, body: "unexpected fixture request" });
    });

    await launched.manager.getByRole("button", { name: "密码源" }).click();
    await launched.manager.getByRole("button", { name: /连接 Monica Android WebDAV/ }).click();
    const dialog = launched.manager.getByRole("dialog", { name: "连接 Monica Android WebDAV" });
    await expect(dialog.getByLabel("Android 备份加密密码（可选）")).toHaveAttribute("placeholder", "留空使用普通 ZIP");
    await dialog.getByLabel("WebDAV 地址 *").fill("https://optional-dav.example.test/root");
    await dialog.getByRole("button", { name: "加密保存" }).click();
    await expect(dialog).toHaveCount(0);

    const plainProviders = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" })) as { ok: boolean; data?: Array<{ id: string; config: { backupPasswordConfigured?: boolean } }> };
    expect(plainProviders.data).toEqual(expect.arrayContaining([expect.objectContaining({ config: expect.objectContaining({ backupPasswordConfigured: false }) })]));

    const short = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({
      type: "WEBDAV_SAVE",
      name: "Short password WebDAV",
      config: { baseUrl: "https://optional-dav.example.test/short", username: "", password: "", backupPassword: "x" },
      isDefaultSaveTarget: false
    })) as { ok: boolean; data?: { id: string }; error?: string };
    expect(short, short.error).toMatchObject({ ok: true });

    const preserved = await launched.manager.evaluate(async (providerId) => chrome.runtime.sendMessage({
      type: "WEBDAV_SAVE",
      providerId,
      name: "Short password WebDAV",
      config: { baseUrl: "https://optional-dav.example.test/short", username: "", password: "" },
      isDefaultSaveTarget: false
    }), short.data!.id) as { ok: boolean; error?: string };
    expect(preserved, preserved.error).toMatchObject({ ok: true });

    const configuredProviders = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" })) as { ok: boolean; data?: Array<{ id: string; config: { backupPasswordConfigured?: boolean } }> };
    expect(configuredProviders.data?.find((provider) => provider.id === short.data!.id)?.config.backupPasswordConfigured).toBe(true);
  } finally {
    await context?.close();
  }
});

test("KeePass UI unlocks with an empty password and key file, exposes dirty state, exports, and locks", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo);
    context = launched.context;
    const keyFile = Uint8Array.from({ length: 32 }, (_, index) => (index * 17 + 9) & 0xff);
    const database = await buildKeePassFixture({
      password: null,
      keyFile,
      name: "Key File Fixture",
      entries: [{
        title: "KeePass imported login",
        fields: { UserName: "joy@example.com", URL: "https://keepass.example.test" },
        protectedFields: { Password: "fixture-secret" }
      }]
    });

    await launched.manager.getByRole("button", { name: "密码源" }).click();
    await launched.manager.getByRole("button", { name: "连接 KeePass" }).click();
    const dialog = launched.manager.getByRole("dialog", { name: "连接 KeePass" });
    await dialog.getByLabel("KeePass 数据库文件").setInputFiles({ name: "key-file-fixture.kdbx", mimeType: "application/octet-stream", buffer: Buffer.from(database) });
    await dialog.getByLabel("密钥文件（可选）").setInputFiles({ name: "fixture.key", mimeType: "application/octet-stream", buffer: Buffer.from(keyFile) });
    await expect(dialog.getByText("仅密钥文件", { exact: true })).toBeVisible();
    await dialog.getByLabel("显示名称").fill("KeePass Key File");
    await dialog.getByRole("button", { name: "解锁并连接" }).click();

    const card = launched.manager.locator("m3e-card.source-card").filter({ has: launched.manager.getByRole("heading", { name: "KeePass Key File" }) });
    await expect(card.getByText("已解锁", { exact: true })).toBeVisible();
    await expect(card.getByText("仅密钥文件", { exact: true })).toBeVisible();
    await expect(card.getByText("Twofish KDBX", { exact: false })).toBeVisible();

    const providerResponse = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" })) as { ok: boolean; data?: Array<{ id: string; name: string; config: Record<string, unknown> }> };
    const provider = providerResponse.data?.find((candidate) => candidate.name === "KeePass Key File");
    expect(provider).toBeTruthy();
    expect(provider?.config).toMatchObject({ fileName: "key-file-fixture.kdbx", protectionMode: "key-file" });
    expect(JSON.stringify(provider?.config)).not.toContain("fixture-secret");
    expect(JSON.stringify(provider?.config)).not.toContain(Buffer.from(keyFile).toString("base64"));

    await card.getByRole("button", { name: "立即同步" }).click();
    await expect.poll(async () => (await listItems(launched.manager)).some((item) => item.title === "KeePass imported login")).toBe(true);

    const now = new Date().toISOString();
    const created = {
      id: "keepass-browser-created",
      kind: "login",
      title: "Browser-created KeePass login",
      favorite: false,
      notes: "",
      createdAt: now,
      updatedAt: now,
      providerRefs: [{ providerId: provider!.id }],
      username: "browser-user",
      password: "browser-secret",
      uris: ["https://created.example.test"],
      customFields: []
    };
    expect(await launched.manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), created)).toMatchObject({ ok: true });
    await card.getByRole("button", { name: "立即同步" }).click();
    await expect(card.getByText("有尚未导出的 KDBX 修改", { exact: true })).toBeVisible();

    const downloadPromise = launched.manager.waitForEvent("download");
    await card.getByRole("button", { name: "导出 KDBX" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("key-file-fixture.kdbx");
    const stream = await download.createReadStream();
    let downloadedBytes = 0;
    for await (const chunk of stream) downloadedBytes += Buffer.byteLength(chunk);
    expect(downloadedBytes).toBeGreaterThan(100);
    await expect(card.getByText("有尚未导出的 KDBX 修改", { exact: true })).toHaveCount(0);

    await card.getByRole("button", { name: "锁定", exact: true }).click();
    await expect(card.getByText("已锁定", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "立即同步" })).toBeDisabled();
    const status = await launched.manager.evaluate(async (providerId) => chrome.runtime.sendMessage({ type: "KEEPASS_STATUS", providerId }), provider!.id) as { ok: boolean; data?: unknown };
    expect(status.ok).toBe(true);
    expect(status.data).toBeUndefined();
  } finally {
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
