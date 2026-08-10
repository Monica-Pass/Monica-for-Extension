import { chromium, expect, test, type BrowserContext, type Page, type Route, type TestInfo } from "@playwright/test";
import path from "node:path";
import { createLoginItem } from "../../src/core/model";
import { encodeBitwardenCipher } from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { bytesToBase64 } from "../../src/security/encoding";
import { deriveBitwardenMasterKey, encryptBitwardenString, stretchBitwardenMasterKey, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";

const VAULT_HOST = "https://bw-collections.example.test";
const EMAIL = "collections@example.test";
const MASTER_PASSWORD = "bitwarden collection server password";
const VAULT_PASSWORD = "bitwarden collection manager password";

test.setTimeout(180_000);

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

interface CollectionServer {
  key: BitwardenSymmetricKey;
  organizationKey: BitwardenSymmetricKey;
  cipher: Record<string, unknown>;
  organization: Record<string, unknown>;
  collections: Map<string, Record<string, unknown>>;
  route(route: Route): Promise<void>;
}

test("Bitwarden organization Collections are permission-aware, manager-only, and routed without gradients", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  const server = await createCollectionServer();
  try {
    const extensionPath = path.resolve("dist");
    context = await chromium.launchPersistentContext(testInfo.outputPath("bitwarden-collections-profile"), {
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
      type: "BITWARDEN_LOGIN", name: "Bitwarden Collections", vaultUrl: VAULT_HOST, email: EMAIL, masterPassword: MASTER_PASSWORD, isDefaultSaveTarget: true
    });
    expect(login, login.error).toMatchObject({ ok: true, data: { status: "authenticated" } });
    const providerId = login.data?.providerId;
    expect(providerId).toEqual(expect.any(String));
    expect(await sendRuntime(manager, { type: "PROVIDER_SYNC", providerId })).toMatchObject({ ok: true, data: { conflicts: 0 } });

    await manager.reload();
    await manager.waitForLoadState("load");
    await manager.getByRole("button", { name: "打开导航" }).click();
    await manager.getByRole("button", { name: /^密码源/ }).click();
    const manage = manager.getByRole("button", { name: "管理 Collection" });
    await expect(manage).toBeVisible();
    await manage.click();

    const dialog = manager.getByRole("dialog", { name: /Bitwarden Collection/ });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(dialog.locator(".bitwarden-organization-panel")).toHaveCSS("border-radius", "8px");
    await expect(dialog.getByText("只有管理页能读取组织名称", { exact: false })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Shared org/ })).toBeVisible();
    await expect(dialog.getByText("Target", { exact: true })).toBeVisible();
    await expect(dialog.getByLabel("选择 Collection Target")).toBeEnabled();
    await expectNoGradients(dialog);

    await dialog.locator("[data-route-item]").selectOption({ label: "Shared account" });
    await dialog.getByLabel("选择 Collection Old").uncheck();
    await dialog.getByLabel("选择 Collection Target").check();
    await dialog.getByRole("button", { name: "保存路由" }).click();
    await expect(dialog.getByText("Shared account 的 Collection 路由已更新。", { exact: true })).toBeVisible();
    expect(server.cipher.collectionIds).toEqual(["collection-target"]);

    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const denied = await sendRuntime(popup, { type: "BITWARDEN_COLLECTION_LIST", providerId });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("管理页");
    await popup.close();
  } finally {
    await context?.close();
    server.key.encKey.fill(0);
    server.key.macKey.fill(0);
    server.organizationKey.encKey.fill(0);
    server.organizationKey.macKey.fill(0);
  }
});

async function createCollectionServer(): Promise<CollectionServer> {
  const key = symmetricKey(11);
  const organizationKey = symmetricKey(91);
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 10_000 }));
  const protectedVaultKey = await new BitwardenClient((() => Promise.reject(new Error("unused"))) as unknown as typeof fetch)
    .protectVaultKey(key, stretched, fixedRandom(3)(16));
  stretched.encKey.fill(0);
  stretched.macKey.fill(0);

  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-1" }, true, ["encrypt", "decrypt"]);
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privateKeyCipher = await encryptBitwardenString(bytesToBase64(privateKeyPkcs8), key);
  const organizationRawKey = concat(organizationKey.encKey, organizationKey.macKey);
  const organizationEncryptedKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pair.publicKey, organizationRawKey as unknown as BufferSource));

  const login = createLoginItem({ title: "Shared account", username: "shared-user", password: "shared-password", uris: ["https://collections.example.test"] });
  const cipher = await encodeBitwardenCipher(login, organizationKey);
  cipher.id = "cipher-shared";
  cipher.organizationId = "org-1";
  cipher.collectionIds = ["collection-old"];
  cipher.revisionDate = "2026-08-08T09:00:00.000Z";
  cipher.creationDate = "2026-08-08T08:59:00.000Z";
  const organization = {
    id: "org-1",
    name: await encryptBitwardenString("Shared org", organizationKey),
    key: `4.${bytesToBase64(organizationEncryptedKey)}`,
    type: "Manager",
    status: "Confirmed",
    enabled: true,
    permissions: { editAssignedCollections: true },
    allowAdminAccessToAllCollectionItems: false
  };
  const collections = new Map<string, Record<string, unknown>>([
    ["collection-old", { id: "collection-old", organizationId: "org-1", name: await encryptBitwardenString("Old", organizationKey), revisionDate: "2026-08-08T09:00:00.000Z", readOnly: false, hidePasswords: false, manage: true, assigned: true }],
    ["collection-target", { id: "collection-target", organizationId: "org-1", name: await encryptBitwardenString("Target", organizationKey), revisionDate: "2026-08-08T09:00:00.000Z", readOnly: false, hidePasswords: false, manage: true, assigned: true }]
  ]);
  const server: CollectionServer = { key, organizationKey, cipher, organization, collections, route: async () => undefined };
  server.route = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: 10_000 });
    if (url.pathname === "/identity/connect/token") return jsonRoute(route, { access_token: "collections-access", refresh_token: "collections-refresh", expires_in: 3600, Key: protectedVaultKey });
    if (url.pathname === "/api/sync") {
      return jsonRoute(route, {
        Profile: { Id: "collection-user", PrivateKey: privateKeyCipher, Organizations: [structuredClone(server.organization)] },
        Collections: [...server.collections.values()].map((collection) => structuredClone(collection)),
        Ciphers: [structuredClone(server.cipher)]
      });
    }
    if (url.pathname === "/api/ciphers/cipher-shared/collections_v2" && request.method() === "PUT") {
      const body = request.postDataJSON() as Record<string, unknown>;
      server.cipher.collectionIds = Array.isArray(body.collectionIds) ? [...body.collectionIds] : [];
      server.cipher.revisionDate = "2026-08-08T09:01:00.000Z";
      return jsonRoute(route, { unavailable: false, cipher: structuredClone(server.cipher) });
    }
    return route.abort("failed");
  };
  return server;
}

function symmetricKey(seed: number): BitwardenSymmetricKey {
  return { encKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff), macKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + 64 + index) & 0xff) };
}

function fixedRandom(seed: number): (length: number) => Uint8Array {
  return (length) => Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
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
