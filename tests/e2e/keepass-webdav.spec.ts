import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import * as kdbxweb from "kdbxweb";
import path from "node:path";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";

const kdbxRuntime = ((kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb);
const VAULT_PASSWORD = "keepass webdav manager vault password";
const DATABASE_PASSWORD = "keepass webdav manager database password";
const WEBDAV_PASSWORD = "keepass webdav manager transport password";
const REMOTE_ORIGIN = "https://keepass-manager.example.test";
const REMOTE_PATH = "/dav/vaults/main.kdbx";

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

interface RemoteState {
  bytes: Uint8Array;
  etag: string;
  getCount: number;
  putCount: number;
}

test("remote KeePass configures safely and presents restorable and pending states after worker restart", async ({}, testInfo) => {
  test.setTimeout(120_000);
  let context: BrowserContext | undefined;
  try {
    const fixture = await buildKeePassFixture({
      password: DATABASE_PASSWORD,
      name: "KeePass WebDAV UI Fixture",
      entries: [{
        title: "Remote UI login",
        group: "Shared",
        fields: { UserName: "remote-ui-user", URL: "https://remote-ui.example.test" },
        protectedFields: { Password: "remote-ui-private-secret" }
      }]
    });
    const remote: RemoteState = { bytes: fixture, etag: '"ui-etag-1"', getCount: 0, putCount: 0 };
    const launched = await launchExtension(testInfo, remote);
    context = launched.context;
    const page = launched.manager;

    await openProviders(page);
    await page.getByRole("button", { name: "连接 KeePass" }).click();
    const dialog = page.getByRole("dialog", { name: "连接 KeePass" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("WebDAV 文件").check();
    await dialog.getByLabel("显示名称").fill("Remote KeePass UI");
    await dialog.getByLabel("WebDAV 地址").fill(`${REMOTE_ORIGIN}/dav`);
    await dialog.getByLabel("用户名").fill("remote-ui-user");
    await dialog.getByLabel("WebDAV 密码").fill(WEBDAV_PASSWORD);
    await dialog.getByLabel("远端 .kdbx 位置").fill("vaults/main.kdbx");
    await dialog.getByLabel("数据库密码（可留空）").fill(DATABASE_PASSWORD);

    await dialog.getByRole("button", { name: "测试连接" }).click();
    await expect(dialog.getByRole("status")).toContainText("连接成功");
    await dialog.getByRole("button", { name: "连接并解锁" }).click();
    await expect(dialog).toHaveCount(0);

    const card = providerCard(page, "Remote KeePass UI");
    await expect(card).toBeVisible();
    await expect(card.getByText("已解锁", { exact: true }).first()).toBeVisible();
    await expect(card.getByText("工作副本可用", { exact: true })).toBeVisible();
    await expect(card.getByText("远端基线可用", { exact: true })).toBeVisible();
    await expect(card.getByText("同步完成", { exact: true })).toBeVisible();
    await expect(card.getByText("修改只在内存中", { exact: false })).toHaveCount(0);
    await expect(card.getByText("后台重启后必须重新选择", { exact: false })).toHaveCount(0);
    await expectNoGradients(card);
    await expectNoHorizontalOverflow(page.locator("main"));
    await expectVisibleTargetsAtLeast44(card);
    await expectSecretsAbsent(page);

    const providers = await send<Array<{ id: string; config: Record<string, unknown> }>>(page, { type: "PROVIDER_LIST" });
    expect(providers, providers.error).toMatchObject({ ok: true });
    const provider = providers.data?.find((candidate) => candidate.config.sourceMode === "webdav");
    expect(provider).toBeTruthy();
    expect(JSON.stringify(providers)).not.toMatch(new RegExp(`${escapeRegExp(DATABASE_PASSWORD)}|${escapeRegExp(WEBDAV_PASSWORD)}|ui-etag-1|remote-ui-private-secret`));

    await card.getByRole("button", { name: "管理 KeePass" }).click();
    const editDialog = page.getByRole("dialog", { name: "管理 KeePass" });
    await expect(editDialog.getByLabel("WebDAV 地址")).toHaveValue(`${REMOTE_ORIGIN}/dav`);
    await expect(editDialog.getByLabel("用户名")).toHaveValue("remote-ui-user");
    await expect(editDialog.getByLabel("远端 .kdbx 位置")).toHaveValue("vaults/main.kdbx");
    await expect(editDialog.getByLabel("WebDAV 密码")).toHaveValue("");
    await expect(editDialog.getByLabel("数据库密码（可留空）")).toHaveValue("");
    await expect(editDialog.getByLabel("WebDAV 密码")).toHaveAttribute("placeholder", /留空保持/);
    await editDialog.getByRole("button", { name: "取消" }).click();

    const getCountBeforeRestart = remote.getCount;
    await terminateExtensionServiceWorker(context, page, launched.extensionId);
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await openProviders(page);
    const restorableCard = providerCard(page, "Remote KeePass UI");
    await expect(restorableCard.getByText("可恢复", { exact: true }).first()).toBeVisible();
    await expect(restorableCard.getByRole("button", { name: "恢复本机会话" })).toBeVisible();
    expect(remote.getCount).toBe(getCountBeforeRestart);
    await restorableCard.getByRole("button", { name: "恢复本机会话" }).click();
    await expect(restorableCard.getByText("已解锁", { exact: true }).first()).toBeVisible();
    expect(remote.getCount).toBe(getCountBeforeRestart);

    const groups = await send<{ items: Array<{ groupId: string; name: string }> }>(page, {
      type: "KEEPASS_GROUP_LIST",
      providerId: provider!.id,
      includeRecycleBin: true,
      pageSize: 50
    });
    expect(groups, groups.error).toMatchObject({ ok: true });
    const create = await send(page, {
      type: "KEEPASS_GROUP_CREATE",
      providerId: provider!.id,
      operationId: "11111111-1111-4111-8111-111111111111",
      name: "Pending WebDAV Group"
    });
    expect(create, create.error).toMatchObject({ ok: true, data: { changed: true } });
    await terminateExtensionServiceWorker(context, page, launched.extensionId);
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await openProviders(page);
    const pendingCard = providerCard(page, "Remote KeePass UI");
    await expect(pendingCard.getByText("结果待确认", { exact: true }).first()).toBeVisible();
    await expect(pendingCard.getByText("持久操作记录", { exact: false })).toBeVisible();

    const accessibility = await new AxeBuilder({ page }).include(".provider-page").analyze();
    expect(accessibility.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
    await expectNoHorizontalOverflow(page.locator("main"));
    await page.screenshot({ path: testInfo.outputPath("keepass-webdav-pending-dark-375-large-text.png") });
  } finally {
    await context?.close();
  }
});

test("remote KeePass preserves a rebase conflict code and never overwrites the changed KDBX", async ({}, testInfo) => {
  test.setTimeout(120_000);
  let context: BrowserContext | undefined;
  try {
    const fixture = await buildKeePassFixture({
      password: DATABASE_PASSWORD,
      name: "KeePass Conflict UI Fixture",
      entries: [{ title: "Conflict login", group: "Shared", protectedFields: { Password: "conflict-private-secret" } }]
    });
    const remote: RemoteState = { bytes: fixture, etag: '"conflict-etag-1"', getCount: 0, putCount: 0 };
    const launched = await launchExtension(testInfo, remote);
    context = launched.context;
    const page = launched.manager;
    const providerId = await connectRemoteKeePass(page, "Conflict KeePass UI");

    const groups = await send<{ items: Array<{ groupId: string; name: string }> }>(page, {
      type: "KEEPASS_GROUP_LIST",
      providerId,
      includeRecycleBin: true,
      pageSize: 50
    });
    const shared = groups.data?.items.find((group) => group.name === "Shared");
    expect(shared).toBeTruthy();
    const renamed = await send(page, {
      type: "KEEPASS_GROUP_RENAME",
      providerId,
      operationId: "22222222-2222-4222-8222-222222222222",
      groupId: shared!.groupId,
      name: "Browser Shared"
    });
    expect(renamed, renamed.error).toMatchObject({ ok: true, data: { changed: true } });

    remote.bytes = await renameFixtureGroup(fixture, "Shared", "Android Shared");
    remote.etag = '"conflict-etag-2"';
    const response = await send(page, { type: "PROVIDER_SYNC", providerId });
    expect(response).toMatchObject({ ok: false, code: "remote-rebase-conflict" });
    expect(remote.putCount).toBeGreaterThan(0);
    expect(await fixtureGroupName(remote.bytes, "Android Shared")).toBe("Android Shared");

    await page.reload();
    await openProviders(page);
    const card = providerCard(page, "Conflict KeePass UI");
    await expect(card.getByText("字段或结构冲突", { exact: false })).toBeVisible();
    await expect(card.getByText("远端文件未被覆盖", { exact: false })).toBeVisible();
    await expect(card.getByRole("button", { name: "重新检查冲突" })).toBeVisible();
    await expect(card).not.toContainText("remote-rebase-conflict");
    await expectSecretsAbsent(page);
  } finally {
    await context?.close();
  }
});

test("KeePass passkey saves into the KDBX and signs a later assertion", async ({}, testInfo) => {
  test.setTimeout(180_000);
  let context: BrowserContext | undefined;
  try {
    const fixture = await buildKeePassFixture({
      password: DATABASE_PASSWORD,
      name: "KeePass Passkey Fixture",
      entries: [{ title: "Anchor login", group: "Shared", fields: { UserName: "anchor-user" }, protectedFields: { Password: "anchor-private-secret" } }]
    });
    const remote: RemoteState = { bytes: fixture, etag: '"passkey-etag-1"', getCount: 0, putCount: 0 };
    const launched = await launchExtension(testInfo, remote);
    context = launched.context;
    const providerId = await connectRemoteKeePass(launched.manager, "Passkey KeePass");

    const rpId = "keepass-passkey.example.test";
    await context.route(`https://${rpId}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: passkeyCeremonyPage(rpId) }));
    const page = await context.newPage();
    await page.goto(`https://${rpId}/`);
    await page.locator("#register").click();
    // The prompt lives in a closed shadow root: focus starts on 创建 Passkey;
    // Shift+Tab twice reaches the 保存位置 select, ArrowDown picks the KeePass target.
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("monica-passkey-prompt-host");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator("#result")).toContainText("registered:");
    await expect(page.locator("#result")).not.toContainText("error:");

    const created = await vaultPasskeys(launched.manager);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ sourceMode: "browser-local", signCount: 0 });
    expect(created[0].providerRefs).toEqual([expect.objectContaining({ providerId })]);

    expect(await send(launched.manager, { type: "PROVIDER_SYNC", providerId })).toMatchObject({ ok: true, data: { conflicts: 0 } });
    expect(remote.putCount).toBe(1);
    const stored = await fixturePasskeyEntry(remote.bytes, rpId);
    expect(stored.credentialId).toBe(created[0].credentialId);
    expect(stored.privateKeyPem).toContain("BEGIN PRIVATE KEY");

    await page.locator("#authenticate").click();
    const prompt = page.locator("#monica-passkey-prompt-host");
    await expect(prompt).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("monica-passkey-prompt-host");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator("#result")).toContainText("authenticated:");
    await expect(page.locator("#result")).not.toContainText("error:");
    const signed = await vaultPasskeys(launched.manager);
    expect(signed[0]).toMatchObject({ useCount: 1, lastUsedAt: expect.any(String) });

    expect(await send(launched.manager, { type: "PROVIDER_SYNC", providerId })).toMatchObject({ ok: true, data: { conflicts: 0 } });
    expect(remote.putCount).toBe(2);
    const storedAfterSign = await fixturePasskeyEntry(remote.bytes, rpId);
    expect(storedAfterSign.credentialId).toBe(created[0].credentialId);
    expect(storedAfterSign.useCount).toBe(1);

    expect(await send(launched.manager, { type: "VAULT_DELETE_ITEM", itemId: created[0].id })).toMatchObject({ ok: true });
    expect(await send(launched.manager, { type: "PROVIDER_SYNC", providerId })).toMatchObject({ ok: true, data: { conflicts: 0 } });
    expect(remote.putCount).toBe(3);
    expect(await vaultPasskeys(launched.manager)).toHaveLength(0);
    await expect(fixturePasskeyEntry(remote.bytes, rpId)).rejects.toThrow("Passkey 条目");
    await expectSecretsAbsent(launched.manager);
  } finally {
    await context?.close();
  }
});

async function vaultPasskeys(page: Page): Promise<Array<Record<string, any>>> {
  const response = await send<Array<{ kind: string } & Record<string, any>>>(page, { type: "VAULT_LIST_ITEMS" });
  expect(response, response.error).toMatchObject({ ok: true });
  return (response.data || []).filter((item) => item.kind === "passkey");
}

interface FixturePasskeyEntry {
  credentialId: string;
  privateKeyPem: string;
  useCount?: number;
}

async function fixturePasskeyEntry(bytes: Uint8Array, rpId: string): Promise<FixturePasskeyEntry> {
  const database = await kdbxRuntime.Kdbx.load(bytes.slice().buffer, keePassCredentials(DATABASE_PASSWORD));
  const recycleBinUuid = database.meta.recycleBinUuid?.id;
  for (const entry of database.getDefaultGroup().allEntries()) {
    // Deleted entries move into the KDBX recycle bin; only the active tree counts as present.
    let parent: kdbxweb.KdbxGroup | undefined = entry.parentGroup;
    let inRecycleBin = false;
    while (parent) {
      if (recycleBinUuid && parent.uuid.id === recycleBinUuid) inRecycleBin = true;
      parent = parent.parentGroup;
    }
    if (inRecycleBin) continue;
    const relyingParty = entry.fields.get("KPEX_PASSKEY_RELYING_PARTY");
    if (typeof relyingParty !== "string" || relyingParty !== rpId) continue;
    const text = (value: unknown): string => (typeof value === "string" ? value : (value as { getText?: () => string })?.getText?.() ?? "");
    const payloadText = text(entry.fields.get("MonicaPasskeyData"));
    let useCount: number | undefined;
    try { useCount = JSON.parse(payloadText).useCount; } catch { /* Monica payload is optional. */ }
    return {
      credentialId: String(entry.fields.get("MonicaPasskeyCredentialId") ?? ""),
      privateKeyPem: text(entry.fields.get("KPEX_PASSKEY_PRIVATE_KEY_PEM")),
      useCount
    };
  }
  throw new Error(`KDBX 中没有 ${rpId} 的 Passkey 条目`);
}

function passkeyCeremonyPage(rpId: string): string {
  return `<!doctype html><title>KeePass Passkey Test</title><button id="register">Register passkey</button><button id="authenticate">Authenticate passkey</button><output id="result"></output><script>
    const challenge = () => new Uint8Array(32).fill(21); let credentialId;
    const decode = value => { const normalized=value.replace(/-/g,'+').replace(/_/g,'/'); const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4)); return Uint8Array.from(binary,c=>c.charCodeAt(0)); };
    register.onclick = async () => { try { const credential = await navigator.credentials.create({ publicKey: { challenge: challenge(), rp: { id: '${rpId}', name: 'KeePass Passkey Test' }, user: { id: new Uint8Array(16).fill(13), name: 'joy@example.com', displayName: 'Joy' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], timeout: 60000, attestation: 'none' } }); credentialId=credential.id; result.textContent='registered:'+credential.id; } catch(error) { result.textContent='error:'+error.name+':'+error.message; } };
    authenticate.onclick = async () => { try { const credential = await navigator.credentials.get({ publicKey: { challenge: challenge(), rpId: '${rpId}', allowCredentials: [{ type:'public-key', id: decode(credentialId) }], timeout: 60000 } }); result.textContent='authenticated:'+credential.id+':'+credential.response.signature.byteLength; } catch(error) { result.textContent='error:'+error.name+':'+error.message; } };
  </script>`;
}

async function launchExtension(testInfo: TestInfo, remote: RemoteState): Promise<{ context: BrowserContext; extensionId: string; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("p"), {
    channel: "chromium",
    headless: true,
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { width: 375, height: 1000 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  await installRemoteRoute(context, remote);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  const setup = await manager.evaluate(async (masterPassword) => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword }), VAULT_PASSWORD) as RuntimeResponse;
  expect(setup, setup.error).toMatchObject({ ok: true });
  await manager.reload();
  await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  return { context, extensionId, manager };
}

async function installRemoteRoute(context: BrowserContext, remote: RemoteState): Promise<void> {
  await context.route(`${REMOTE_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PROPFIND" && url.pathname === "/dav") {
      await route.fulfill({ status: 207, contentType: "application/xml; charset=utf-8", body: "<d:multistatus xmlns:d=\"DAV:\"></d:multistatus>" });
      return;
    }
    if (request.method() === "PROPFIND" && url.pathname === REMOTE_PATH) {
      await route.fulfill({ status: 207, contentType: "application/xml; charset=utf-8", body: webDavStat(url.pathname, remote) });
      return;
    }
    if (request.method() === "GET" && url.pathname === REMOTE_PATH) {
      remote.getCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/octet-stream",
        headers: { ETag: remote.etag, "Content-Length": String(remote.bytes.length) },
        body: Buffer.from(remote.bytes)
      });
      return;
    }
    if (request.method() === "PUT" && url.pathname === REMOTE_PATH) {
      remote.putCount += 1;
      if (request.headers()["if-match"] !== remote.etag) {
        await route.fulfill({ status: 412, body: "Precondition failed" });
        return;
      }
      const body = request.postDataBuffer();
      expect(body).toBeTruthy();
      remote.bytes = new Uint8Array(body!);
      remote.etag = `"ui-etag-${remote.putCount + 1}"`;
      await route.fulfill({ status: 204, headers: { ETag: remote.etag } });
      return;
    }
    await route.fulfill({ status: 500, body: `Unexpected ${request.method()} ${url.pathname}` });
  });
}

async function connectRemoteKeePass(page: Page, name: string): Promise<string> {
  await openProviders(page);
  await page.getByRole("button", { name: "连接 KeePass" }).click();
  const dialog = page.getByRole("dialog", { name: "连接 KeePass" });
  await dialog.getByLabel("WebDAV 文件").check();
  await dialog.getByLabel("显示名称").fill(name);
  await dialog.getByLabel("WebDAV 地址").fill(`${REMOTE_ORIGIN}/dav`);
  await dialog.getByLabel("用户名").fill("remote-ui-user");
  await dialog.getByLabel("WebDAV 密码").fill(WEBDAV_PASSWORD);
  await dialog.getByLabel("远端 .kdbx 位置").fill("vaults/main.kdbx");
  await dialog.getByLabel("数据库密码（可留空）").fill(DATABASE_PASSWORD);
  await dialog.getByRole("button", { name: "连接并解锁" }).click();
  await expect(dialog).toHaveCount(0);
  const providers = await send<Array<{ id: string; name: string }>>(page, { type: "PROVIDER_LIST" });
  const provider = providers.data?.find((candidate) => candidate.name === name);
  expect(provider).toBeTruthy();
  return provider!.id;
}

async function openProviders(page: Page): Promise<void> {
  const navigationButton = page.getByRole("button", { name: "打开导航" });
  const providersButton = page.getByRole("button", { name: "密码源" });
  await expect.poll(async () => await navigationButton.isVisible() || await providersButton.isVisible()).toBe(true);
  if (await navigationButton.isVisible()) await navigationButton.click();
  await expect(providersButton).toBeVisible();
  await providersButton.click();
  await expect(page.locator(".provider-page")).toBeVisible();
}

function providerCard(page: Page, name: string): Locator {
  return page.locator("m3e-card.source-card").filter({ has: page.getByRole("heading", { name }) });
}

async function send<T = unknown>(page: Page, request: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  return page.evaluate(async (message) => chrome.runtime.sendMessage(message), request) as Promise<RuntimeResponse<T>>;
}

async function terminateExtensionServiceWorker(context: BrowserContext, manager: Page, extensionId: string): Promise<void> {
  const session = await context.newCDPSession(manager);
  try {
    const targets = await session.send("Target.getTargets") as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    const target = targets.targetInfos.find((candidate) => candidate.type === "service_worker" && new URL(candidate.url).host === extensionId);
    expect(target).toBeTruthy();
    await session.send("ServiceWorker.enable");
    await session.send("ServiceWorker.stopAllWorkers");
  } finally {
    await session.detach();
  }
}

function webDavStat(pathName: string, remote: RemoteState): string {
  return `<?xml version="1.0" encoding="utf-8"?>
    <d:multistatus xmlns:d="DAV:"><d:response><d:href>${pathName}</d:href><d:propstat><d:prop>
      <d:getetag>${remote.etag.replaceAll("\"", "&quot;")}</d:getetag>
      <d:getcontentlength>${remote.bytes.length}</d:getcontentlength>
      <d:getlastmodified>Fri, 07 Aug 2026 10:00:00 GMT</d:getlastmodified>
    </d:prop></d:propstat></d:response></d:multistatus>`;
}

async function renameFixtureGroup(bytes: Uint8Array, currentName: string, nextName: string): Promise<Uint8Array> {
  const database = await kdbxRuntime.Kdbx.load(bytes.slice().buffer, keePassCredentials(DATABASE_PASSWORD));
  const group = database.getDefaultGroup().groups.find((candidate) => candidate.name === currentName);
  expect(group).toBeTruthy();
  group!.name = nextName;
  group!.times.lastModTime = new Date("2026-08-07T10:30:00.000Z");
  return new Uint8Array(await database.save());
}

async function fixtureGroupName(bytes: Uint8Array, expectedName: string): Promise<string | undefined> {
  const database = await kdbxRuntime.Kdbx.load(bytes.slice().buffer, keePassCredentials(DATABASE_PASSWORD));
  return database.getDefaultGroup().groups.find((candidate) => candidate.name === expectedName)?.name;
}

async function expectSecretsAbsent(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  for (const secret of [DATABASE_PASSWORD, WEBDAV_PASSWORD, "remote-ui-private-secret", "conflict-private-secret"]) {
    expect(text).not.toContain(secret);
  }
}

async function expectNoGradients(locator: Locator): Promise<void> {
  const offenders = await locator.evaluate((root) => [root, ...root.querySelectorAll<HTMLElement>("*")].flatMap((candidate) => {
    const image = getComputedStyle(candidate).backgroundImage;
    return /gradient\(/i.test(image) ? [image] : [];
  }).slice(0, 10));
  expect(offenders).toEqual([]);
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((element) => Math.max(0, element.scrollWidth - element.clientWidth));
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectVisibleTargetsAtLeast44(locator: Locator): Promise<void> {
  const targets = locator.locator("m3e-button:visible, m3e-icon-button:visible, button:visible, select:visible");
  const count = await targets.count();
  for (let index = 0; index < count; index += 1) {
    const box = await targets.nth(index).boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
