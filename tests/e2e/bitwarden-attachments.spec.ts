import { chromium, expect, test, type BrowserContext, type Download, type Page, type Route, type TestInfo } from "@playwright/test";
import path from "node:path";
import { createLoginItem } from "../../src/core/model";
import { encodeBitwardenCipher } from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import {
  deriveBitwardenMasterKey,
  encryptBitwardenBytes,
  encryptBitwardenString,
  stretchBitwardenMasterKey,
  type BitwardenSymmetricKey
} from "../../src/providers/bitwarden/bitwarden-crypto";

const VAULT_HOST = "https://bw-attachments.example.test";
const OBJECT_HOST = "https://objects-attachments.example.test";
const EMAIL = "attachments@example.test";
const MASTER_PASSWORD = "bitwarden attachment server password";
const VAULT_PASSWORD = "bitwarden attachment manager password";

test.setTimeout(180_000);

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

interface AttachmentEntry {
  id: string;
  fileName: string;
  key?: string;
  size: number;
}

interface AttachmentServer {
  cipher: Record<string, unknown>;
  bodies: Map<string, Uint8Array>;
  deleteFailuresRemaining: number;
  uploadedCount: number;
  initialBytes: Uint8Array;
  routeBitwarden(route: Route): Promise<void>;
  routeObjects(route: Route): Promise<void>;
}

test("Bitwarden attachments are manager-only, encrypted end-to-end, and recover interrupted deletes", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  const server = await createAttachmentServer();
  try {
    const extensionPath = path.resolve("dist");
    context = await chromium.launchPersistentContext(testInfo.outputPath("bitwarden-attachments-profile"), {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 1100 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    await context.route(`${VAULT_HOST}/**`, (route) => server.routeBitwarden(route));
    await context.route(`${OBJECT_HOST}/**`, (route) => server.routeObjects(route));

    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    const setup = await sendRuntime(manager, { type: "VAULT_SETUP", masterPassword: VAULT_PASSWORD });
    expect(setup, setup.error).toMatchObject({ ok: true });
    await manager.reload();
    await manager.waitForLoadState("load");

    const login = await sendRuntime<{ status: string; providerId?: string }>(manager, {
      type: "BITWARDEN_LOGIN",
      name: "Bitwarden Attachment Source",
      vaultUrl: VAULT_HOST,
      email: EMAIL,
      masterPassword: MASTER_PASSWORD,
      isDefaultSaveTarget: true
    });
    expect(login, login.error).toMatchObject({ ok: true, data: { status: "authenticated" } });
    const providerId = login.data?.providerId;
    expect(providerId).toEqual(expect.any(String));

    const synced = await sendRuntime<{ conflicts: number }>(manager, { type: "PROVIDER_SYNC", providerId });
    expect(synced, synced.error).toMatchObject({ ok: true, data: { conflicts: 0 } });
    const items = await listItems(manager);
    const item = items.find((candidate) => candidate.kind === "login");
    expect(item).toMatchObject({ title: "Bitwarden attachment account" });
    await manager.reload();
    await manager.waitForLoadState("load");

    await manager.getByRole("button", { name: "打开导航" }).click();
    await manager.getByRole("button", { name: /^登录项/ }).click();
    const manage = manager.getByRole("button", { name: "管理 Bitwarden attachment account 的附件" });
    await expect(manage).toBeVisible();
    await manage.click();
    const dialog = manager.getByRole("dialog", { name: "附件 · Bitwarden attachment account" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(dialog.locator(".attachment-list-shell")).toHaveCSS("border-radius", "8px");
    await expect(dialog.getByText("Bitwarden 附件使用独立密钥加密", { exact: false })).toBeVisible();
    await expect(dialog.getByText("initial.txt", { exact: true })).toBeVisible();
    await expect(dialog.locator(".attachment-recovery-panel")).toHaveCount(0);
    await expectNoGradients(dialog);

    const initialDownload = manager.waitForEvent("download");
    await dialog.getByRole("button", { name: "下载 initial.txt" }).click();
    expect(await downloadBytes(await initialDownload)).toEqual(Buffer.from(server.initialBytes));

    const addChooser = manager.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "添加附件" }).click();
    await (await addChooser).setFiles({ name: "new.txt", mimeType: "text/plain", buffer: Buffer.from("new attachment") });
    await expect(dialog.getByText("new.txt", { exact: true })).toBeVisible();

    const newRow = dialog.locator(".provider-attachment-row").filter({ hasText: "new.txt" });
    const newDownload = manager.waitForEvent("download");
    await newRow.getByRole("button", { name: "下载 new.txt" }).click();
    expect(await downloadBytes(await newDownload)).toEqual(Buffer.from("new attachment"));

    const replaceChooser = manager.waitForEvent("filechooser");
    await dialog.locator(".provider-attachment-row").filter({ hasText: "initial.txt" }).getByRole("button", { name: "替换 initial.txt 的内容" }).click();
    await (await replaceChooser).setFiles({ name: "renamed.txt", mimeType: "text/plain", buffer: Buffer.from("replacement") });
    const replacedRow = dialog.locator(".provider-attachment-row").filter({ hasText: "initial.txt" });
    await expect(replacedRow).toContainText("11 B");
    const replacedDownload = manager.waitForEvent("download");
    await replacedRow.getByRole("button", { name: "下载 initial.txt" }).click();
    expect(await downloadBytes(await replacedDownload)).toEqual(Buffer.from("replacement"));

    server.deleteFailuresRemaining = 3;
    await newRow.getByRole("button", { name: "删除 new.txt" }).click();
    const confirmDelete = newRow.getByRole("button", { name: "确认删除" });
    await expect(confirmDelete).toBeFocused();
    await confirmDelete.click();
    await expect(dialog.getByRole("alert")).toContainText("仍需恢复确认");
    await expect(dialog.locator(".attachment-recovery-panel")).toContainText("有 1 个附件操作待恢复");
    const pending = await sendRuntime<{ pending: unknown[] }>(manager, { type: "PROVIDER_ATTACHMENT_RECOVERY_STATUS", providerId });
    expect(pending, pending.error).toMatchObject({ ok: true, data: { pending: [{ kind: "delete" }] } });
    expect(JSON.stringify(pending.data)).not.toContain("e2e-access-token");

    server.deleteFailuresRemaining = 0;
    await confirmDelete.click();
    await expect(dialog.getByText("new.txt", { exact: true })).toHaveCount(0);
    await expect(dialog.locator(".attachment-recovery-panel")).toHaveCount(0);
    expect(server.bodies.has("new-attachment-1")).toBe(false);

    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const popupAttempt = await popup.evaluate(async () => chrome.runtime.sendMessage({
      type: "PROVIDER_ATTACHMENT_READ_BEGIN",
      providerId: "not-from-manager",
      itemId: "not-from-manager",
      attachmentId: "not-from-manager"
    })) as RuntimeResponse;
    expect(popupAttempt.ok).toBe(false);
    expect(popupAttempt.error).toContain("管理页");
    await popup.close();
  } finally {
    await context?.close();
    for (const bytes of server.bodies.values()) bytes.fill(0);
    server.initialBytes.fill(0);
  }
});

async function createAttachmentServer(): Promise<AttachmentServer> {
  const vaultKey = symmetricKey(7);
  const stretchedKey = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(MASTER_PASSWORD, EMAIL, { type: 0, iterations: 10_000 }));
  const protectedVaultKey = await new BitwardenClient((() => Promise.reject(new Error("unused"))) as unknown as typeof fetch)
    .protectVaultKey(vaultKey, stretchedKey, Uint8Array.from({ length: 16 }, (_, index) => (17 + index) & 0xff));
  stretchedKey.encKey.fill(0);
  stretchedKey.macKey.fill(0);
  const login = createLoginItem({
    title: "Bitwarden attachment account",
    username: "attachment-user",
    password: "attachment-password",
    uris: ["https://attachments.example.test"]
  });
  const cipher = await encodeBitwardenCipher(login, vaultKey);
  cipher.id = "cipher-attachments";
  cipher.revisionDate = "2026-08-08T01:00:00.000Z";
  cipher.creationDate = "2026-08-08T00:59:00.000Z";
  const initialBytes = new TextEncoder().encode("initial attachment");
  const attachmentKey = symmetricKey(91);
  const encryptedFileName = await encryptBitwardenString("initial.txt", vaultKey, fixedRandom(3));
  const wrappedKey = await encryptBitwardenBytes(concat(attachmentKey.encKey, attachmentKey.macKey), vaultKey, fixedRandom(5));
  const encryptedBody = await encryptAttachmentBytes(initialBytes, attachmentKey, fixedRandom(11));
  attachmentKey.encKey.fill(0);
  attachmentKey.macKey.fill(0);
  cipher.attachments = [{ id: "initial-attachment", fileName: encryptedFileName, key: wrappedKey, size: String(encryptedBody.length) }];
  return {
    cipher,
    bodies: new Map([["initial-attachment", encryptedBody]]),
    deleteFailuresRemaining: 0,
    uploadedCount: 0,
    initialBytes,
    async routeBitwarden(route) {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/identity/accounts/prelogin/password") return jsonRoute(route, { Kdf: 0, KdfIterations: 10_000 });
      if (url.pathname === "/identity/connect/token") {
        return jsonRoute(route, { access_token: "e2e-access-token", refresh_token: "e2e-refresh-token", expires_in: 3600, Key: protectedVaultKey });
      }
      if (url.pathname === "/api/sync") return jsonRoute(route, { Profile: { Id: "e2e-user" }, Ciphers: [structuredClone(this.cipher)] });
      if (url.pathname === "/api/ciphers/cipher-attachments/attachment/v2" && request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        const id = `new-attachment-${++this.uploadedCount}`;
        const metadata = { id, fileName: String(body.fileName), key: String(body.key), size: String(body.fileSize) };
        this.cipher.attachments = [...attachmentEntries(this.cipher), metadata];
        this.cipher.revisionDate = nextRevision(this.cipher);
        return jsonRoute(route, { attachmentId: id, fileUploadType: 1, url: `${OBJECT_HOST}/upload/${id}?sv=2026-01-01&se=2099-01-01T00%3A00%3A00Z&sig=opaque`, cipherResponse: structuredClone(this.cipher) });
      }
      const attachmentMatch = url.pathname.match(/^\/api\/ciphers\/cipher-attachments\/attachment\/([^/]+)$/);
      if (attachmentMatch) {
        const id = decodeURIComponent(attachmentMatch[1]);
        const entry = attachmentEntries(this.cipher).find((candidate) => candidate.id === id);
        if (request.method() === "GET") {
          if (!entry) return jsonRoute(route, { message: "missing" }, 404);
          return jsonRoute(route, { id, url: `${OBJECT_HOST}/download/${id}?sig=opaque`, fileName: entry.fileName, key: entry.key, size: String(entry.size) });
        }
        if (request.method() === "DELETE") {
          if (this.deleteFailuresRemaining > 0) {
            this.deleteFailuresRemaining -= 1;
            return route.abort("failed");
          }
          this.cipher.attachments = attachmentEntries(this.cipher).filter((candidate) => candidate.id !== id);
          this.bodies.delete(id);
          this.cipher.revisionDate = nextRevision(this.cipher);
          return route.fulfill({ status: 204 });
        }
      }
      return route.abort("failed");
    },
    async routeObjects(route) {
      const request = route.request();
      const url = new URL(request.url());
      const id = decodeURIComponent(url.pathname.split("/").pop() || "");
      if (url.pathname.startsWith("/upload/") && request.method() === "PUT") {
        const bytes = new Uint8Array(request.postDataBuffer() || Buffer.alloc(0));
        this.bodies.set(id, bytes);
        return route.fulfill({ status: 201 });
      }
      if (url.pathname.startsWith("/download/") && request.method() === "GET") {
        const body = this.bodies.get(id);
        if (!body) return jsonRoute(route, { message: "missing" }, 404);
        return route.fulfill({ status: 200, body: Buffer.from(body), headers: { "Content-Type": "application/octet-stream", "Content-Length": String(body.length) } });
      }
      return route.abort("failed");
    }
  };
}

function attachmentEntries(cipher: Record<string, unknown>): AttachmentEntry[] {
  return (Array.isArray(cipher.attachments) ? cipher.attachments : []).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    return [{ id: String(value.id), fileName: String(value.fileName), key: typeof value.key === "string" ? value.key : undefined, size: Number(value.size) }];
  });
}

function nextRevision(cipher: Record<string, unknown>): string {
  const current = String(cipher.revisionDate || "2026-08-08T01:00:00.000Z");
  const seconds = Number(current.slice(17, 19)) + 1;
  return `2026-08-08T01:00:${String(seconds).padStart(2, "0")}.000Z`;
}

async function sendRuntime<T = unknown>(page: Page, request: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  return page.evaluate(async (value) => chrome.runtime.sendMessage(value), request) as Promise<RuntimeResponse<T>>;
}

async function listItems(page: Page): Promise<Array<Record<string, any>>> {
  const response = await sendRuntime<Array<Record<string, any>>>(page, { type: "VAULT_LIST_ITEMS" });
  expect(response, response.error).toMatchObject({ ok: true });
  return response.data || [];
}

async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function encryptAttachmentBytes(plaintext: Uint8Array, key: BitwardenSymmetricKey, randomness: (length: number) => Uint8Array): Promise<Uint8Array> {
  const iv = randomness(16);
  const cryptoKey = await crypto.subtle.importKey("raw", key.encKey as BufferSource, { name: "AES-CBC" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, cryptoKey, plaintext as BufferSource));
  const hmacKey = await crypto.subtle.importKey("raw", key.macKey as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, concat(iv, ciphertext) as BufferSource));
  return concat(iv, ciphertext, mac);
}

function symmetricKey(seed: number): BitwardenSymmetricKey {
  return {
    encKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff),
    macKey: Uint8Array.from({ length: 32 }, (_, index) => (seed + 64 + index) & 0xff)
  };
}

function fixedRandom(seed: number): (length: number) => Uint8Array {
  return (length) => Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function jsonRoute(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function expectNoGradients(locator: import("@playwright/test").Locator): Promise<void> {
  const offenders = await locator.evaluate((root) => [root, ...root.querySelectorAll<HTMLElement>("*")].flatMap((candidate) => /gradient\(/i.test(getComputedStyle(candidate).backgroundImage) ? [candidate.className] : []));
  expect(offenders).toEqual([]);
}
