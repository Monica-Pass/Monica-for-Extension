import { chromium, expect, test, type BrowserContext, type Page, type Route, type TestInfo } from "@playwright/test";
import path from "node:path";
import { createLoginItem } from "../../src/core/model";
import { encodeBitwardenCipher } from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";

test.setTimeout(120_000);

interface RuntimeResponse<T = unknown> { ok: boolean; data?: T; error?: string; code?: string; }

const VAULT_HOST = "https://bw-empty.example.test";
const EMAIL = "empty@example.test";
const MASTER_PASSWORD = "empty vault server password";

test("manager archive and recycle-bin views keep records recoverable and privileged", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const extensionPath = path.resolve("dist");
    context = await chromium.launchPersistentContext(testInfo.outputPath("p"), {
      channel: "chromium",
      headless: true,
      viewport: { width: 375, height: 1100 },
      colorScheme: "dark",
      reducedMotion: "reduce",
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    const setup = await sendRuntime(manager, { type: "VAULT_SETUP", masterPassword: "trash archive manager password" });
    expect(setup, setup.error).toMatchObject({ ok: true });

    const archived = createLoginItem({ title: "Archived account", username: "archived-user", password: "archived-secret", uris: ["archive.example.test"] });
    const deleted = createLoginItem({ title: "Deleted account", username: "deleted-user", password: "deleted-secret", uris: ["trash.example.test"] });
    const archivedRecord = { ...archived, archivedAt: "2026-08-08T10:00:00.000Z" };
    expect(await sendRuntime(manager, { type: "VAULT_UPSERT_ITEM", item: archivedRecord })).toMatchObject({ ok: true });
    expect(await sendRuntime(manager, { type: "VAULT_UPSERT_ITEM", item: deleted })).toMatchObject({ ok: true });
    expect(await sendRuntime(manager, { type: "VAULT_DELETE_ITEM", itemId: deleted.id })).toMatchObject({ ok: true });

    await manager.reload();
    await manager.waitForLoadState("load");
    await openMobileSection(manager, /^归档/);
    await expect(manager.locator(".item-card").filter({ hasText: "Archived account" })).toBeVisible();
    await expect(manager.getByRole("button", { name: "取消归档 Archived account" })).toBeVisible();
    await expect(manager.locator(".data-card").first()).toHaveCSS("border-radius", "8px");
    await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expectNoHorizontalOverflow(manager);
    await expectNoGradients(manager.locator(".lifecycle-page"));
    await manager.getByRole("button", { name: "取消归档 Archived account" }).click();
    await expect(manager.locator(".item-card").filter({ hasText: "Archived account" })).toHaveCount(0);

    await openMobileSection(manager, /^回收站/);
    await expect(manager.locator(".item-card").filter({ hasText: "Deleted account" })).toBeVisible();
    await manager.getByRole("button", { name: "恢复 Deleted account" }).click();
    await expect(manager.locator(".item-card").filter({ hasText: "Deleted account" })).toHaveCount(0);
    await openMobileSection(manager, /^登录项/);
    await expect(manager.locator("tr.row-clickable").filter({ hasText: "Deleted account" })).toBeVisible();

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    for (const request of [
      { type: "VAULT_LIST_ARCHIVED_ITEMS" },
      { type: "VAULT_LIST_DELETED_ITEMS" },
      { type: "VAULT_GET_ITEM", itemId: archived.id },
      { type: "VAULT_GET_ITEM", itemId: deleted.id },
      { type: "VAULT_RESTORE_ITEM", itemId: deleted.id }
    ]) {
      const denied = await sendRuntime(popup, request);
      expect(denied.ok).toBe(false);
      expect(denied.error).toContain("管理页");
    }
    await popup.close();
  } finally {
    await context?.close();
  }
});

test("manager requires explicit confirmation before adopting an authenticated empty Bitwarden vault", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  const server = await createEmptyVaultServer();
  try {
    const extensionPath = path.resolve("dist");
    context = await chromium.launchPersistentContext(testInfo.outputPath("p"), {
      channel: "chromium",
      headless: true,
      viewport: { width: 375, height: 1100 },
      colorScheme: "dark",
      reducedMotion: "reduce",
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    await context.route(`${VAULT_HOST}/**`, (route) => server.route(route));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    const setup = await sendRuntime(manager, { type: "VAULT_SETUP", masterPassword: "empty vault manager password" });
    expect(setup, setup.error).toMatchObject({ ok: true });
    const login = await sendRuntime<{ status: string; providerId?: string }>(manager, {
      type: "BITWARDEN_LOGIN",
      name: "Bitwarden empty vault",
      vaultUrl: VAULT_HOST,
      email: EMAIL,
      masterPassword: MASTER_PASSWORD,
      isDefaultSaveTarget: true
    });
    expect(login, login.error).toMatchObject({ ok: true, data: { status: "authenticated" } });
    const providerId = login.data?.providerId || "";
    expect(await sendRuntime(manager, { type: "PROVIDER_SYNC", providerId })).toMatchObject({ ok: true, data: { conflicts: 0 } });

    server.ciphers = [];
    await manager.reload();
    await manager.waitForLoadState("load");
    await openMobileSection(manager, /^密码源/);
    await manager.getByRole("button", { name: "立即同步" }).click();
    await expect(manager.getByText("服务器返回空密码库", { exact: true })).toBeVisible();
    const openConfirmation = manager.getByRole("button", { name: "查看并确认空库" });
    await expect(openConfirmation).toBeVisible();
    await expectNoGradients(manager.locator(".provider-page"));
    await expectNoHorizontalOverflow(manager);
    await openConfirmation.click();
    const confirmation = manager.getByRole("dialog", { name: "采用服务器空密码库？" });
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toHaveCSS("border-radius", "16px");
    await confirmation.getByRole("button", { name: "确认采用空库" }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(openConfirmation).toHaveCount(0);

    await openMobileSection(manager, /^登录项/);
    await expect(manager.getByRole("row").filter({ hasText: "Server account" })).toHaveCount(0);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const denied = await sendRuntime(popup, { type: "PROVIDER_SYNC", providerId, allowEmptyRemote: true });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("管理页");
    await popup.close();
  } finally {
    await context?.close();
    server.key.encKey.fill(0);
    server.key.macKey.fill(0);
  }
});

function sendRuntime<T = unknown>(page: Page, request: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  return page.evaluate(async (value) => chrome.runtime.sendMessage(value), request) as Promise<RuntimeResponse<T>>;
}

async function openMobileSection(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name }).click();
}

interface EmptyVaultServer {
  key: BitwardenSymmetricKey;
  ciphers: Record<string, unknown>[];
  route(route: Route): Promise<void>;
}

async function createEmptyVaultServer(): Promise<EmptyVaultServer> {
  const key = symmetricKey(73);
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 10_000 }));
  const protectedKey = await new BitwardenClient((() => Promise.reject(new Error("unused"))) as unknown as typeof fetch)
    .protectVaultKey(key, stretched, new Uint8Array(16));
  stretched.encKey.fill(0);
  stretched.macKey.fill(0);
  const cipher = await encodeBitwardenCipher(createLoginItem({ title: "Server account", username: "server-user", password: "server-secret", uris: ["https://empty.example.test"] }), key);
  cipher.id = "server-cipher";
  cipher.revisionDate = "2026-08-08T10:00:00.000Z";
  cipher.creationDate = "2026-08-08T09:59:00.000Z";
  const server: EmptyVaultServer = { key, ciphers: [cipher], route: async () => undefined };
  server.route = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: 10_000 });
    if (url.pathname === "/identity/connect/token") return jsonRoute(route, { access_token: "empty-access", refresh_token: "empty-refresh", expires_in: 3600, Key: protectedKey });
    if (url.pathname === "/api/sync") return jsonRoute(route, { Profile: { Id: "empty-user" }, Ciphers: structuredClone(server.ciphers) });
    return route.abort("failed");
  };
  return server;
}

function symmetricKey(seed: number): BitwardenSymmetricKey {
  return {
    encKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff),
    macKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + 64 + index) & 0xff)
  };
}

function jsonRoute(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

async function expectNoGradients(locator: import("@playwright/test").Locator): Promise<void> {
  const offenders = await locator.evaluate((root) => [root, ...root.querySelectorAll<HTMLElement>("*")]
    .flatMap((candidate) => /gradient\(/i.test(getComputedStyle(candidate).backgroundImage) ? [candidate.className] : []));
  expect(offenders).toEqual([]);
}
