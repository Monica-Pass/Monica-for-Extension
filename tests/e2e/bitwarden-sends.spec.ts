import { chromium, expect, test, type BrowserContext, type Page, type Route, type TestInfo } from "@playwright/test";
import path from "node:path";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import {
  deriveBitwardenMasterKey,
  deriveBitwardenSendKey,
  encryptBitwardenBytes,
  encryptBitwardenString,
  stretchBitwardenMasterKey,
  type BitwardenSymmetricKey
} from "../../src/providers/bitwarden/bitwarden-crypto";

const VAULT_HOST = "https://bw-sends.example.test";
const EMAIL = "sends@example.test";
const MASTER_PASSWORD = "bitwarden send server password";
const VAULT_PASSWORD = "bitwarden send manager password";

test.setTimeout(180_000);

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

interface SendServer {
  key: BitwardenSymmetricKey;
  sends: Map<string, Record<string, unknown>>;
  lastTextCreate?: Record<string, unknown>;
  uploadedBodies: Uint8Array[];
  route(route: Route): Promise<void>;
}

test("Bitwarden Send text and file operations are encrypted, manager-only, and responsive", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  const server = await createSendServer();
  try {
    const extensionPath = path.resolve("dist");
    context = await chromium.launchPersistentContext(testInfo.outputPath("bitwarden-sends-profile"), {
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
      name: "Bitwarden Sends",
      vaultUrl: VAULT_HOST,
      email: EMAIL,
      masterPassword: MASTER_PASSWORD,
      isDefaultSaveTarget: true
    });
    expect(login, login.error).toMatchObject({ ok: true, data: { status: "authenticated" } });
    const providerId = login.data?.providerId;
    expect(providerId).toEqual(expect.any(String));

    await manager.reload();
    await manager.waitForLoadState("load");
    await manager.getByRole("button", { name: "打开导航" }).click();
    await manager.getByRole("button", { name: "安全发送" }).click();
    await expect(manager.getByRole("heading", { name: "安全发送", exact: true }).first()).toBeVisible();
    await expect(manager.getByRole("option", { name: /Initial secure text/ })).toBeVisible();
    await expect(manager.getByText("Initial text content", { exact: true })).toBeVisible();
    await expect(manager.locator(".send-workspace")).toHaveCSS("border-radius", "8px");
    await expectNoGradients(manager.locator(".send-panel"));
    await expectNoHorizontalOverflow(manager);

    await manager.getByRole("button", { name: "发送文本" }).click();
    const textDialog = manager.getByRole("dialog", { name: "新建文本发送" });
    await expect(textDialog).toHaveCSS("border-radius", "16px");
    await textDialog.getByLabel("标题 *").fill("Created secure text");
    await textDialog.getByLabel("文本内容 *").fill("created plaintext must be encrypted");
    await textDialog.getByLabel("备注").fill("created private note");
    await textDialog.getByLabel("访问密码（可选）").fill("send-access-password");
    await textDialog.getByRole("button", { name: "加密并创建" }).click();
    await expect(manager.getByRole("option", { name: /Created secure text/ })).toBeVisible();
    expect(server.lastTextCreate).toBeDefined();
    const createdWire = JSON.stringify(server.lastTextCreate);
    expect(createdWire).not.toContain("Created secure text");
    expect(createdWire).not.toContain("created plaintext must be encrypted");
    expect(createdWire).not.toContain("created private note");
    expect(createdWire).not.toContain("send-access-password");
    expect(server.lastTextCreate?.password).toMatch(/^[A-Za-z0-9+/]+=*$/);

    await manager.getByRole("button", { name: "发送文件" }).click();
    const fileDialog = manager.getByRole("dialog", { name: "新建文件发送" });
    await fileDialog.getByLabel("选择安全发送文件").setInputFiles({
      name: "browser-file.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("file plaintext must be encrypted")
    });
    await fileDialog.getByLabel("标题 *").fill("Created secure file");
    await fileDialog.getByRole("button", { name: "加密并创建" }).click();
    await expect(manager.getByRole("option", { name: /Created secure file/ })).toBeVisible();
    expect(server.uploadedBodies).toHaveLength(1);
    const uploadedText = Buffer.from(server.uploadedBodies[0]).toString("utf8");
    expect(uploadedText).not.toContain("file plaintext must be encrypted");
    expect(uploadedText).not.toContain("browser-file.txt");
    expect(server.uploadedBodies[0][0]).toBe(2);

    await manager.getByRole("option", { name: /Initial secure text/ }).click();
    await manager.getByRole("button", { name: "编辑" }).click();
    const editDialog = manager.getByRole("dialog", { name: "编辑安全发送" });
    await expect(editDialog.getByLabel("访问密码")).toBeDisabled();
    await editDialog.getByLabel("标题 *").fill("Initial secure text updated");
    await editDialog.getByLabel("文本内容 *").fill("Updated encrypted text");
    await editDialog.getByRole("button", { name: "保存修改" }).click();
    await expect(manager.getByRole("option", { name: /Initial secure text updated/ })).toBeVisible();
    await expect(manager.getByText("Updated encrypted text", { exact: true })).toBeVisible();

    manager.once("dialog", (dialog) => void dialog.accept());
    await manager.getByRole("button", { name: "移除密码" }).click();
    await expect(manager.getByRole("button", { name: "移除密码" })).toHaveCount(0);
    await expect(manager.getByText("无需验证", { exact: true }).first()).toBeVisible();

    await manager.getByRole("option", { name: /Created secure file/ }).click();
    manager.once("dialog", (dialog) => void dialog.accept());
    await manager.getByRole("button", { name: "删除", exact: true }).click();
    await expect(manager.getByRole("option", { name: /Created secure file/ })).toHaveCount(0);

    await manager.getByRole("option", { name: /Email verified send/ }).click();
    await expect(manager.getByText("邮箱验证 Send 暂时只支持查看、复制链接和删除。", { exact: true })).toBeVisible();
    await expect(manager.getByRole("button", { name: "编辑" })).toBeDisabled();

    await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await expectNoHorizontalOverflow(manager);
    await expectNoGradients(manager.locator(".send-panel"));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const denied = await sendRuntime(popup, { type: "BITWARDEN_SEND_LIST", providerId });
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("管理页");
    await popup.close();
  } finally {
    await context?.close();
    server.key.encKey.fill(0);
    server.key.macKey.fill(0);
    for (const bytes of server.uploadedBodies) bytes.fill(0);
  }
});

async function createSendServer(): Promise<SendServer> {
  const key = symmetricKey(27);
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 10_000 }));
  const protectedKey = await new BitwardenClient((() => Promise.reject(new Error("unused"))) as unknown as typeof fetch)
    .protectVaultKey(key, stretched, new Uint8Array(16));
  stretched.encKey.fill(0);
  stretched.macKey.fill(0);
  const initial = await encryptedTextSend(key, {
    id: "send-initial",
    name: "Initial secure text",
    text: "Initial text content",
    password: "server-password-proof",
    authType: 1
  });
  const email = await encryptedTextSend(key, {
    id: "send-email",
    name: "Email verified send",
    text: "Email protected content",
    authType: 0,
    emails: [{ Email: "2.encrypted-email" }]
  });
  const sends = new Map([["send-initial", initial], ["send-email", email]]);
  let revision = 2;
  let createdCount = 0;
  let fileCount = 0;
  const server: SendServer = { key, sends, uploadedBodies: [], route: async () => undefined };
  server.route = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: 10_000 });
    if (url.pathname === "/identity/connect/token") return jsonRoute(route, { access_token: "send-access-token", refresh_token: "send-refresh-token", expires_in: 3600, Key: protectedKey });
    if (url.pathname === "/api/sends" && request.method() === "GET") return jsonRoute(route, { Data: [...server.sends.values()].map((send) => structuredClone(send)) });
    if (url.pathname === "/api/sends" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      server.lastTextCreate = structuredClone(body);
      const id = `send-created-${++createdCount}`;
      const send = { ...body, id, accessId: `access-${id}`, accessCount: 0, revisionDate: nextRevision(revision++), object: "send" };
      server.sends.set(id, send);
      return jsonRoute(route, structuredClone(send));
    }
    if (url.pathname === "/api/sends/file/v2" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      const id = `send-file-${++fileCount}`;
      const fileId = `file-${fileCount}`;
      const file = { ...(body.file as Record<string, unknown>), id: fileId, size: String(body.fileLength || 0) };
      const send = { ...body, id, accessId: `access-${id}`, accessCount: 0, revisionDate: nextRevision(revision++), file, object: "send" };
      server.sends.set(id, send);
      return jsonRoute(route, { FileUploadType: 0, SendResponse: structuredClone(send) });
    }
    const fileMatch = url.pathname.match(/^\/api\/sends\/([^/]+)\/file\/([^/]+)$/);
    if (fileMatch && request.method() === "POST") {
      server.uploadedBodies.push(extractMultipartFileBytes(
        request.postDataBuffer() || Buffer.alloc(0),
        request.headers()["content-type"] || ""
      ));
      return route.fulfill({ status: 200 });
    }
    const removePasswordMatch = url.pathname.match(/^\/api\/sends\/([^/]+)\/remove-password$/);
    if (removePasswordMatch && request.method() === "PUT") {
      const id = decodeURIComponent(removePasswordMatch[1]);
      const current = server.sends.get(id);
      if (!current) return jsonRoute(route, { message: "missing" }, 404);
      const updated = { ...current, password: null, authType: 2, revisionDate: nextRevision(revision++) };
      server.sends.set(id, updated);
      return jsonRoute(route, structuredClone(updated));
    }
    const sendMatch = url.pathname.match(/^\/api\/sends\/([^/]+)$/);
    if (sendMatch) {
      const id = decodeURIComponent(sendMatch[1]);
      if (request.method() === "GET") {
        const current = server.sends.get(id);
        return current ? jsonRoute(route, structuredClone(current)) : jsonRoute(route, { message: "missing" }, 404);
      }
      if (request.method() === "PUT") {
        const current = server.sends.get(id);
        if (!current) return jsonRoute(route, { message: "missing" }, 404);
        const body = request.postDataJSON() as Record<string, unknown>;
        const updated = { ...body, id, accessId: current.accessId, accessCount: current.accessCount, revisionDate: nextRevision(revision++), object: "send" };
        server.sends.set(id, updated);
        return jsonRoute(route, structuredClone(updated));
      }
      if (request.method() === "DELETE") {
        if (!server.sends.delete(id)) return jsonRoute(route, { message: "missing" }, 404);
        return route.fulfill({ status: 204 });
      }
    }
    return route.abort("failed");
  };
  return server;
}

async function encryptedTextSend(key: BitwardenSymmetricKey, input: {
  id: string;
  name: string;
  text: string;
  password?: string;
  authType: number;
  emails?: unknown;
}): Promise<Record<string, unknown>> {
  const seed = Uint8Array.from({ length: 16 }, (_, index) => index + input.id.length);
  const sendKey = await deriveBitwardenSendKey(seed);
  const raw = {
    Id: input.id,
    AccessId: `access-${input.id}`,
    Key: await encryptBitwardenBytes(seed, key, fixedRandom(1)),
    Type: 0,
    Name: await encryptBitwardenString(input.name, sendKey, fixedRandom(2)),
    Notes: await encryptBitwardenString("Owner note", sendKey, fixedRandom(3)),
    Text: { Text: await encryptBitwardenString(input.text, sendKey, fixedRandom(4)), Hidden: false },
    AccessCount: 1,
    MaxAccessCount: 10,
    Password: input.password || null,
    AuthType: input.authType,
    ...(input.emails ? { Emails: input.emails } : {}),
    Disabled: false,
    HideEmail: true,
    RevisionDate: "2026-08-08T08:01:00.000Z",
    DeletionDate: "2026-08-20T08:00:00.000Z",
    Object: "send"
  };
  seed.fill(0);
  sendKey.encKey.fill(0);
  sendKey.macKey.fill(0);
  return raw;
}

function symmetricKey(seed: number): BitwardenSymmetricKey {
  return {
    encKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff),
    macKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + 64 + index) & 0xff)
  };
}

function fixedRandom(value: number): () => Uint8Array {
  return () => new Uint8Array(16).fill(value);
}

function nextRevision(index: number): string {
  return `2026-08-08T08:${String(index).padStart(2, "0")}:00.000Z`;
}

function sendRuntime<T = unknown>(page: Page, request: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  return page.evaluate(async (value) => chrome.runtime.sendMessage(value), request) as Promise<RuntimeResponse<T>>;
}

function jsonRoute(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function extractMultipartFileBytes(body: Buffer, contentType: string): Uint8Array {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) throw new Error("Direct Send upload is missing a multipart boundary.");
  const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"));
  if (headerEnd < 0) throw new Error("Direct Send upload is missing multipart headers.");
  const dataStart = headerEnd + 4;
  const dataEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart);
  if (dataEnd < dataStart) throw new Error("Direct Send upload is missing the closing multipart boundary.");
  return new Uint8Array(body.subarray(dataStart, dataEnd));
}

async function expectNoGradients(locator: import("@playwright/test").Locator): Promise<void> {
  const offenders = await locator.evaluate((root) => [root, ...root.querySelectorAll<HTMLElement>("*")]
    .flatMap((candidate) => /gradient\(/i.test(getComputedStyle(candidate).backgroundImage) ? [candidate.className] : []));
  expect(offenders).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.width);
}
