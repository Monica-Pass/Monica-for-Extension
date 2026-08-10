import { chromium, expect, test, type BrowserContext, type Page, type Route, type TestInfo } from "@playwright/test";
import path from "node:path";
import { createLoginItem } from "../../src/core/model";
import { encodeBitwardenCipher } from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { deriveBitwardenMasterKey, encryptBitwardenString, stretchBitwardenMasterKey, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";

const VAULT_HOST = "https://bw-folders.example.test";
const EMAIL = "folders@example.test";
const MASTER_PASSWORD = "bitwarden folder server password";
const VAULT_PASSWORD = "bitwarden folder manager password";

test.setTimeout(120_000);

interface RuntimeResponse<T = unknown> { ok: boolean; data?: T; error?: string; code?: string; }

interface FolderServer {
  key: BitwardenSymmetricKey;
  folders: Map<string, Record<string, unknown>>;
  cipher: Record<string, unknown>;
  route(route: Route): Promise<void>;
}

test("Bitwarden folders are encrypted, manager-only, conflict-aware, and route Cipher siblings", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  const server = await createFolderServer();
  try {
    const extensionPath = path.resolve("dist");
    context = await chromium.launchPersistentContext(testInfo.outputPath("bitwarden-folders-profile"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 1100 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    await context.route(`${VAULT_HOST}/**`, (route) => server.route(route));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await sendRuntime(manager, { type: "VAULT_SETUP", masterPassword: VAULT_PASSWORD })).toMatchObject({ ok: true });
    const login = await sendRuntime<{ status: string; providerId?: string }>(manager, {
      type: "BITWARDEN_LOGIN", name: "Bitwarden folders", vaultUrl: VAULT_HOST, email: EMAIL, masterPassword: MASTER_PASSWORD, isDefaultSaveTarget: true
    });
    expect(login, login.error).toMatchObject({ ok: true, data: { status: "authenticated" } });
    const providerId = login.data?.providerId;
    expect(providerId).toEqual(expect.any(String));
    expect(await sendRuntime(manager, { type: "PROVIDER_SYNC", providerId })).toMatchObject({ ok: true, data: { conflicts: 0 } });

    await manager.reload();
    await manager.waitForLoadState("load");
    await manager.getByRole("button", { name: "打开导航" }).click();
    await manager.getByRole("button", { name: /^密码源/ }).click();
    const manage = manager.getByRole("button", { name: "管理文件夹" });
    await expect(manage).toBeVisible();
    await manage.click();
    const dialog = manager.getByRole("dialog", { name: /Bitwarden 文件夹/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(dialog.locator(".bitwarden-folders-list-shell")).toHaveCSS("border-radius", "8px");
    await expect(dialog.getByText("名称按 Bitwarden 用户密钥加密", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Work 1 个项目" })).toBeVisible();
    await expectNoGradients(dialog);

    await dialog.getByRole("button", { name: "新建文件夹" }).click();
    await dialog.getByLabel("文件夹名称").fill("Personal");
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Personal 0 个项目" })).toBeVisible();

    await dialog.getByRole("button", { name: /Work/ }).click();
    await dialog.getByRole("button", { name: "重命名" }).click();
    await dialog.getByLabel("新名称").fill("Work renamed");
    await dialog.getByRole("button", { name: "保存名称" }).click();
    await expect(dialog.getByRole("button", { name: "Work renamed 1 个项目" })).toBeVisible();

    await dialog.locator("[data-move-item]").selectOption({ label: "Folder account" });
    await dialog.locator("[data-move-target]").selectOption({ label: "Personal" });
    await dialog.getByRole("button", { name: "移动项目" }).click();
    await expect(dialog.getByText("Folder account 已移动到 Personal。", { exact: true })).toBeVisible();
    expect(String(server.cipher.folderId)).toBe("folder-personal");

    await dialog.getByRole("button", { name: /Personal/ }).click();
    await dialog.getByRole("button", { name: "删除" }).click();
    await expect(dialog.getByRole("button", { name: "确认删除" })).toBeFocused();
    await dialog.getByRole("button", { name: "确认删除" }).click();
    expect(server.folders.has("folder-personal")).toBe(false);
    expect(server.cipher.folderId).toBeNull();

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const denied = await sendRuntime(popup, { type: "BITWARDEN_FOLDER_LIST", providerId });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("管理页");
    await popup.close();
  } finally {
    await context?.close();
    server.key.encKey.fill(0);
    server.key.macKey.fill(0);
  }
});

async function createFolderServer(): Promise<FolderServer> {
  const key = symmetricKey(31);
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 10_000 }));
  const protectedKey = await new BitwardenClient((() => Promise.reject(new Error("unused"))) as unknown as typeof fetch)
    .protectVaultKey(key, stretched, new Uint8Array(16));
  stretched.encKey.fill(0);
  stretched.macKey.fill(0);
  const login = createLoginItem({ title: "Folder account", username: "folder-user", password: "folder-password", uris: ["https://folders.example.test"] });
  const cipher = await encodeBitwardenCipher(login, key);
  cipher.id = "cipher-folder";
  cipher.revisionDate = "2026-08-08T09:00:00.000Z";
  cipher.creationDate = "2026-08-08T08:59:00.000Z";
  cipher.folderId = "folder-work";
  const work = { id: "folder-work", name: await encryptBitwardenString("Work", key), revisionDate: "2026-08-08T09:00:00.000Z" };
  const server: FolderServer = { key, folders: new Map([["folder-work", work]]), cipher, route: async () => undefined };
  server.route = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: 10_000 });
    if (url.pathname === "/identity/connect/token") return jsonRoute(route, { access_token: "folder-access", refresh_token: "folder-refresh", expires_in: 3600, Key: protectedKey });
    if (url.pathname === "/api/sync") return jsonRoute(route, { Profile: { Id: "folder-user" }, Folders: [...server.folders.values()].map((folder) => structuredClone(folder)), Ciphers: [structuredClone(server.cipher)] });
    if (url.pathname === "/api/folders" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      server.folders.set("folder-personal", { id: "folder-personal", name: body.name, revisionDate: "2026-08-08T09:01:00.000Z" });
      return jsonRoute(route, { id: "folder-personal", name: body.name, revisionDate: "2026-08-08T09:01:00.000Z" });
    }
    const folderMatch = url.pathname.match(/^\/api\/folders\/([^/]+)$/);
    if (folderMatch) {
      const id = decodeURIComponent(folderMatch[1]);
      if (request.method() === "PUT") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const current = server.folders.get(id);
        if (!current) return jsonRoute(route, { message: "missing" }, 404);
        current.name = body.name;
        current.revisionDate = "2026-08-08T09:02:00.000Z";
        return jsonRoute(route, current);
      }
      if (request.method() === "DELETE") {
        if (!server.folders.delete(id)) return jsonRoute(route, { message: "missing" }, 404);
        server.cipher.folderId = null;
        server.cipher.revisionDate = "2026-08-08T09:03:00.000Z";
        return route.fulfill({ status: 204 });
      }
    }
    const cipherMatch = url.pathname.match(/^\/api\/ciphers\/([^/]+)$/);
    if (cipherMatch && request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      server.cipher = { ...server.cipher, ...body, id: "cipher-folder", revisionDate: "2026-08-08T09:04:00.000Z" };
      return jsonRoute(route, structuredClone(server.cipher));
    }
    return route.abort("failed");
  };
  return server;
}

function symmetricKey(seed: number): BitwardenSymmetricKey {
  return { encKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff), macKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + 64 + index) & 0xff) };
}

function sendRuntime<T = unknown>(page: Page, request: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  return page.evaluate(async (value) => chrome.runtime.sendMessage(value), request) as Promise<RuntimeResponse<T>>;
}

function jsonRoute(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function expectNoGradients(locator: import("@playwright/test").Locator): Promise<void> {
  const offenders = await locator.evaluate((root) => [root, ...root.querySelectorAll<HTMLElement>("*")].flatMap((candidate) => /gradient\(/i.test(getComputedStyle(candidate).backgroundImage) ? [candidate.className] : []));
  expect(offenders).toEqual([]);
}
