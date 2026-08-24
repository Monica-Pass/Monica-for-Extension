import { chromium, expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { decryptBitwardenString, deriveBitwardenMasterKey, encryptBitwardenString, stretchBitwardenMasterKey, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";

const VAULT_HOST = "https://bw-ssh.example.test";
const EMAIL = "ssh@example.test";
const MASTER_PASSWORD = "bitwarden ssh server password";
const VAULT_PASSWORD = "bitwarden ssh manager password";

test.setTimeout(180_000);

interface RuntimeResponse<T = unknown> { ok: boolean; data?: T; error?: string; }

interface SshServer {
  key: BitwardenSymmetricKey;
  ciphers: Map<string, Record<string, unknown>>;
  nativeWrite?: Record<string, unknown>;
  fallbackWrite?: Record<string, unknown>;
  route(route: Route): Promise<void>;
}

test("Bitwarden SSH keeps native Type 5 data and creates Android-compatible fallback Ciphers", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  const server = await createSshServer();
  try {
    const extensionPath = path.resolve("dist");
    context = await chromium.launchPersistentContext(testInfo.outputPath("bitwarden-ssh-profile"), {
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
      type: "BITWARDEN_LOGIN",
      name: "Bitwarden SSH",
      vaultUrl: VAULT_HOST,
      email: EMAIL,
      masterPassword: MASTER_PASSWORD,
      isDefaultSaveTarget: true
    });
    expect(login, login.error).toMatchObject({ ok: true, data: { status: "authenticated" } });
    const providerId = login.data?.providerId;
    expect(providerId).toEqual(expect.any(String));
    expect(await sendRuntime(manager, { type: "PROVIDER_SYNC", providerId })).toMatchObject({ ok: true, data: { conflicts: 0 } });

    await manager.reload();
    await openLoginSection(manager);
    await manager.getByRole("row").filter({ hasText: "Native SSH" }).getByRole("button", { name: "编辑登录项" }).click();
    const nativeDialog = manager.getByRole("dialog", { name: "编辑登录项" });
    await expect(nativeDialog.getByText("Bitwarden 原生 SSH Cipher（Type 5）", { exact: false })).toBeVisible();
    await expect(nativeDialog.getByLabel("算法", { exact: true })).toHaveAttribute("readonly", "");
    await nativeDialog.getByLabel("OpenSSH 公钥", { exact: true }).fill("ssh-ed25519 AAAAC3Nza updated@example");
    await nativeDialog.getByLabel("OpenSSH 私钥", { exact: true }).fill("-----BEGIN OPENSSH PRIVATE KEY-----\nupdated\n-----END OPENSSH PRIVATE KEY-----");
    await nativeDialog.getByLabel("SHA-256 指纹", { exact: true }).fill("SHA256:updated");
    await nativeDialog.getByLabel("密钥位数", { exact: true }).fill("256");
    await nativeDialog.getByLabel("注释", { exact: true }).fill("local encrypted metadata");
    await nativeDialog.getByRole("button", { name: "加密保存" }).click();
    expect(await sendRuntime(manager, { type: "PROVIDER_SYNC", providerId })).toMatchObject({ ok: true, data: { conflicts: 0 } });

    expect(server.nativeWrite).toMatchObject({ type: 5, sshKey: { futureNative: { keep: true } }, futureTopLevel: "keep" });
    const nativeSsh = server.nativeWrite?.sshKey as Record<string, unknown>;
    await expect(decryptBitwardenString(String(nativeSsh.publicKey), server.key)).resolves.toBe("ssh-ed25519 AAAAC3Nza updated@example");
    await expect(decryptBitwardenString(String(nativeSsh.keyFingerprint), server.key)).resolves.toBe("SHA256:updated");

    await manager.reload();
    await openLoginSection(manager);
    await manager.getByRole("row").filter({ hasText: "Native SSH" }).getByRole("button", { name: "编辑登录项" }).click();
    await expect(manager.getByLabel("密钥位数", { exact: true })).toHaveValue("256");
    await expect(manager.getByLabel("注释", { exact: true })).toHaveValue("local encrypted metadata");
    await manager.getByRole("button", { name: "关闭" }).click();

    await manager.getByRole("button", { name: "新建", exact: true }).click();
    const createDialog = manager.getByRole("dialog", { name: "添加登录项" });
    await createDialog.getByLabel("名称 *", { exact: true }).fill("Fallback SSH");
    await createDialog.getByLabel("SSH 密钥", { exact: true }).check();
    await expect(createDialog.getByText("保存到 Bitwarden 时将使用 Monica Android 兼容格式", { exact: false })).toBeVisible();
    await createDialog.getByLabel("算法", { exact: true }).fill("RSA");
    await createDialog.getByLabel("密钥位数", { exact: true }).fill("4096");
    await createDialog.getByLabel("OpenSSH 公钥", { exact: true }).fill("ssh-rsa AAAA fallback@example");
    await createDialog.getByLabel("OpenSSH 私钥", { exact: true }).fill("private-fallback");
    await createDialog.getByLabel("SHA-256 指纹", { exact: true }).fill("SHA256:fallback");
    await createDialog.getByLabel("注释", { exact: true }).fill("sync to Android");
    await createDialog.getByRole("button", { name: "加密保存" }).click();
    expect(await sendRuntime(manager, { type: "PROVIDER_SYNC", providerId })).toMatchObject({ ok: true, data: { conflicts: 0 } });

    expect(server.fallbackWrite?.type).toBe(1);
    expect(server.fallbackWrite?.sshKey).toBeUndefined();
    const fallbackFields = await decryptFields(server.fallbackWrite?.fields, server.key);
    expect(fallbackFields).toEqual(expect.arrayContaining([
      { name: "monica_login_type", value: "SSH_KEY", type: 0 },
      { name: "monica_ssh_algorithm", value: "RSA", type: 0 },
      { name: "monica_ssh_key_size", value: "4096", type: 0 },
      { name: "monica_ssh_private_key", value: "private-fallback", type: 1 },
      { name: "monica_ssh_comment", value: "sync to Android", type: 0 }
    ]));

    await manager.reload();
    await openLoginSection(manager);
    await manager.getByRole("row").filter({ hasText: "Fallback SSH" }).getByRole("button", { name: "编辑登录项" }).click();
    const fallbackDialog = manager.getByRole("dialog", { name: "编辑登录项" });
    await expect(fallbackDialog.getByText("Monica Android 兼容格式（Type 1 + 加密字段）", { exact: false })).toBeVisible();
    await expectNoGradients(fallbackDialog);
    expect(await manager.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await context?.close();
    server.key.encKey.fill(0);
    server.key.macKey.fill(0);
  }
});

async function createSshServer(): Promise<SshServer> {
  const key = symmetricKey(71);
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 10_000 }));
  const protectedKey = await new BitwardenClient((() => Promise.reject(new Error("unused"))) as unknown as typeof fetch)
    .protectVaultKey(key, stretched, new Uint8Array(16));
  stretched.encKey.fill(0);
  stretched.macKey.fill(0);
  const native = {
    id: "cipher-native-ssh",
    type: 5,
    name: await encryptBitwardenString("Native SSH", key),
    notes: null,
    favorite: false,
    revisionDate: "2026-08-08T10:00:00.000Z",
    creationDate: "2026-08-08T09:59:00.000Z",
    sshKey: {
      privateKey: await encryptBitwardenString("private-native", key),
      publicKey: await encryptBitwardenString("ssh-ed25519 AAAAC3Nza native@example", key),
      keyFingerprint: await encryptBitwardenString("SHA256:native", key),
      futureNative: { keep: true }
    },
    futureTopLevel: "keep"
  };
  const server: SshServer = { key, ciphers: new Map([[String(native.id), native]]), route: async () => undefined };
  let revision = 0;
  server.route = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: 10_000 });
    if (url.pathname === "/identity/connect/token") return jsonRoute(route, { access_token: "ssh-access", refresh_token: "ssh-refresh", expires_in: 3600, Key: protectedKey });
    if (url.pathname === "/api/sync") return jsonRoute(route, { Profile: { Id: "ssh-user" }, Ciphers: [...server.ciphers.values()].map((cipher) => structuredClone(cipher)) });
    if (url.pathname === "/api/ciphers" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      server.fallbackWrite = structuredClone(body);
      const created = { ...body, id: "cipher-fallback-ssh", revisionDate: `2026-08-08T10:0${++revision}:00.000Z`, creationDate: "2026-08-08T10:00:00.000Z" };
      server.ciphers.set("cipher-fallback-ssh", created);
      return jsonRoute(route, structuredClone(created));
    }
    const match = url.pathname.match(/^\/api\/ciphers\/([^/]+)$/);
    if (match && request.method() === "PUT") {
      const id = decodeURIComponent(match[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      if (id === "cipher-native-ssh") server.nativeWrite = structuredClone(body);
      const updated = { ...body, id, revisionDate: `2026-08-08T10:0${++revision}:30.000Z`, creationDate: "2026-08-08T09:59:00.000Z" };
      server.ciphers.set(id, updated);
      return jsonRoute(route, structuredClone(updated));
    }
    return route.abort("failed");
  };
  return server;
}

async function decryptFields(raw: unknown, key: BitwardenSymmetricKey): Promise<Array<{ name: string; value: string; type: number }>> {
  const fields = Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
  return Promise.all(fields.map(async (field) => ({
    name: await decryptBitwardenString(String(field.name || field.Name || ""), key).catch(() => ""),
    value: await decryptBitwardenString(String(field.value || field.Value || ""), key).catch(() => ""),
    type: Number(field.type ?? field.Type)
  })));
}

function symmetricKey(seed: number): BitwardenSymmetricKey {
  return {
    encKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff),
    macKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + 64 + index) & 0xff)
  };
}

function sendRuntime<T = unknown>(page: Page, request: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  return page.evaluate(async (value) => chrome.runtime.sendMessage(value), request) as Promise<RuntimeResponse<T>>;
}

async function openLoginSection(page: Page): Promise<void> {
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /^登录项/ }).click();
}

function jsonRoute(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function expectNoGradients(locator: import("@playwright/test").Locator): Promise<void> {
  const offenders = await locator.evaluate((root) => [root, ...root.querySelectorAll<HTMLElement>("*")]
    .flatMap((candidate) => /gradient\(/i.test(getComputedStyle(candidate).backgroundImage) ? [candidate.className] : []));
  expect(offenders).toEqual([]);
}
