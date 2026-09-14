import { dialogContent } from "./fixtures/material";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { MessageType } from "@microsoft/signalr";
import { MessagePackHubProtocol } from "@microsoft/signalr-protocol-msgpack";
import { chromium, expect, test, type Page, type TestInfo } from "@playwright/test";
import type { LoginItem } from "../../src/core/model";
import { BitwardenClient } from "../../src/providers/bitwarden/bitwarden-client";
import { decodeBitwardenCipher, encodeBitwardenCipher } from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey, type BitwardenSymmetricKey } from "../../src/providers/bitwarden/bitwarden-crypto";

const { Server: WebSocketServer } = createRequire(import.meta.url)("ws");
const EMAIL = "synthetic-sync@example.test";
const PASSWORD = "synthetic Bitwarden sync password";
const VAULT_PASSWORD = "synthetic browser sync password";
const BASE = "2026-09-14T00:00:00.000Z";

/** Real HTTP + SignalR MessagePack transport, with synthetic ciphertext only. */
async function bitwardenServer() {
  const key: BitwardenSymmetricKey = { encKey: new Uint8Array(32).fill(7), macKey: new Uint8Array(32).fill(12) };
  const master = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(PASSWORD, EMAIL, { type: 0, iterations: 10_000 }));
  const protectedKey = await new BitwardenClient().protectVaultKey(key, master, new Uint8Array(16));
  const protocol = new MessagePackHubProtocol();
  const ciphers = new Map<string, Record<string, unknown>>();
  const originals = new Map<string, LoginItem>();
  for (let i = 0; i < 2; i++) {
    const item: LoginItem = { id: `cipher-${i}`, kind: "login", title: i ? "Other account" : "Phone account", username: `synthetic-user-${i}`, password: `synthetic-secret-${i}`, uris: ["https://sync.example.test"], customFields: [], favorite: false, notes: "", createdAt: BASE, updatedAt: BASE, providerRefs: [] };
    originals.set(item.id, item);
    ciphers.set(item.id, { ...await encodeBitwardenCipher(item, key), id: item.id, revisionDate: BASE, creationDate: BASE });
  }
  let revision = Date.parse(BASE);
  let tokenVersion = 0;
  let acceptedToken = "";
  let handshakes = 0;
  let lastRequestAt = 0;
  const requests: Array<{ method: string; path: string }> = [];
  const sockets = new Set<any>();
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://127.0.0.1");
      // Do not record URLs: SignalR uses a token query parameter.
      requests.push({ method: request.method!, path: url.pathname });
      lastRequestAt = Date.now();
      if (url.pathname === "/identity/accounts/prelogin/password") return json(response, { Kdf: 0, KdfIterations: 10_000 });
      if (url.pathname === "/identity/connect/token") {
        acceptedToken = `synthetic-access-${++tokenVersion}`;
        return json(response, { access_token: acceptedToken, refresh_token: "synthetic-refresh", expires_in: 3600, Key: protectedKey });
      }
      if (request.headers.authorization !== `Bearer ${acceptedToken}`) return json(response, {}, 401);
      if (url.pathname === "/api/accounts/revision-date") return json(response, revision);
      if (url.pathname === "/api/sync") return json(response, { Profile: { Id: "synthetic-user" }, Folders: [], Collections: [], Ciphers: [...ciphers.values()] });
      const detailsId = /^\/api\/ciphers\/([^/]+)\/details$/.exec(url.pathname)?.[1];
      if (detailsId) return json(response, ciphers.get(detailsId) || {}, ciphers.has(detailsId) ? 200 : 404);
      const updateId = /^\/api\/ciphers\/([^/]+)$/.exec(url.pathname)?.[1];
      if (updateId && request.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.lastKnownRevisionDate !== ciphers.get(updateId)?.revisionDate) return json(response, { Message: "The cipher has been modified." }, 400);
        const raw = { ...body, id: updateId, creationDate: BASE, revisionDate: new Date(revision += 1000).toISOString() };
        ciphers.set(updateId, raw);
        return json(response, raw);
      }
      json(response, {}, 404);
    })().catch(() => { if (!response.writableEnded) json(response, { Message: "Synthetic fixture error" }, 500); });
  });
  const hub = new WebSocketServer({ server, path: "/notifications/hub" });
  hub.on("connection", (socket: any) => {
    let ready = false;
    socket.on("error", () => undefined);
    socket.on("message", (data: Buffer) => {
      if (!ready) {
        if (!data.toString("utf8").includes('"protocol":"messagepack"')) return socket.close();
        socket.send("{}\x1e");
        ready = true;
        sockets.add(socket);
        handshakes += 1;
      } else socket.send(Buffer.from(protocol.writeMessage({ type: MessageType.Ping }) as ArrayBuffer));
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic server has no TCP address");
  function notify(id: string, type = 0) {
    const message = protocol.writeMessage({ type: MessageType.Invocation, target: "ReceiveMessage", arguments: [{ Type: type, ContextId: "synthetic-phone", Payload: { UserId: "synthetic-user", Id: id } }], headers: {} });
    for (const socket of sockets) socket.send(Buffer.from(message as ArrayBuffer));
  }
  return {
    url: `http://127.0.0.1:${address.port}`, requests,
    handshakes: () => handshakes, connected: () => sockets.size,
    quietFor: () => Date.now() - lastRequestAt,
    count: (method: string, pathname: string) => requests.filter(request => request.method === method && request.path === pathname).length,
    async edit(id: string, patch: Partial<LoginItem>, push = true) {
      const item = { ...originals.get(id)!, ...patch, updatedAt: new Date(revision += 1000).toISOString() };
      originals.set(id, item);
      ciphers.set(id, { ...await encodeBitwardenCipher(item, key, ciphers.get(id)), id, revisionDate: item.updatedAt, creationDate: BASE });
      if (push) notify(id);
    },
    remove(id: string) { ciphers.delete(id); revision += 1000; notify(id, 9); },
    async login(id: string) { return (await decodeBitwardenCipher(ciphers.get(id)!, "synthetic-provider", key)).items.find(item => item.kind === "login") as LoginItem; },
    expireToken() { acceptedToken = "synthetic-expired"; },
    disconnect() { for (const socket of sockets) socket.terminate(); },
    async close() {
      for (const socket of hub.clients) socket.terminate();
      await new Promise<void>(resolve => hub.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
async function send(page: Page, request: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}
async function openFixture(testInfo: TestInfo) {
  const mock = await bitwardenServer();
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), { channel: "chromium", headless: true, locale: "zh-CN", args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const root = `chrome-extension://${new URL(worker.url()).host}`;
    const manager = await context.newPage();
    await manager.goto(`${root}/index.html`);
    await send(manager, { type: "VAULT_SETUP", masterPassword: VAULT_PASSWORD });
    const { providerId } = await send(manager, { type: "BITWARDEN_LOGIN", name: "Synthetic sync", vaultUrl: mock.url, email: EMAIL, masterPassword: PASSWORD, isDefaultSaveTarget: false });
    await send(manager, { type: "PROVIDER_SYNC", providerId });
    await manager.reload();
    await expect(manager.getByRole("button", { name: "查看Phone account详情", exact: true })).toBeVisible();
    await expect.poll(mock.handshakes).toBeGreaterThan(0);
    await expect.poll(() => mock.count("GET", "/api/sync")).toBeGreaterThanOrEqual(2);
    await expect.poll(mock.quietFor).toBeGreaterThan(650);
    return { mock, context, manager, providerId, root, close: async () => {
      await manager.evaluate(() => chrome.storage.local.set({ "monica.sync.preferences.v1": { enabled: false } })).catch(() => undefined);
      await mock.close();
      await context.close();
    } };
  } catch (error) { await context.close(); await mock.close(); throw error; }
}

test("phone notification updates the open list and detail using one Cipher request", async ({}, testInfo) => {
  const f = await openFixture(testInfo);
  try {
    await f.manager.getByRole("button", { name: "查看Phone account详情", exact: true }).click();
    const fullReads = f.mock.count("GET", "/api/sync");
    const startedAt = Date.now();
    await f.mock.edit("cipher-0", { title: "Updated on phone", username: "phone-edited-user" });
    await expect(f.manager.locator("#vault-detail-title")).toHaveText("Updated on phone");
    await expect(dialogContent(f.manager).getByText("phone-edited-user", { exact: true })).toBeVisible();
    const latencyMs = Date.now() - startedAt;
    expect(latencyMs).toBeLessThan(10_000);
    expect(f.mock.count("GET", "/api/ciphers/cipher-0/details")).toBe(1);
    expect(f.mock.count("GET", "/api/sync")).toBe(fullReads);
    await testInfo.attach("synthetic-sync-latency", { contentType: "application/json", body: JSON.stringify({ latencyMs, cipherRequests: 1, extraFullReads: 0, syntheticOnly: true }) });
    const items = await send(f.manager, { type: "VAULT_LIST_ITEMS" });
    expect(items).toHaveLength(2);
    expect(items.some((item: LoginItem) => item.title === "Other account")).toBe(true);
    await f.manager.getByRole("button", { name: "关闭详情", exact: true }).click();
    await f.mock.remove("cipher-0");
    await expect(f.manager.getByRole("button", { name: "查看Updated on phone详情", exact: true })).toHaveCount(0);
    await expect(f.manager.getByRole("button", { name: "查看Other account详情", exact: true })).toBeVisible();
    expect(await send(f.manager, { type: "PROVIDER_CONFLICT_LIST", providerId: f.providerId })).toEqual([]);
  } finally { await f.close(); }
});

test("remote edits preserve an open draft and a normal local save uploads automatically", async ({}, testInfo) => {
  const f = await openFixture(testInfo);
  try {
    await f.manager.getByRole("button", { name: "查看Phone account详情", exact: true }).click();
    await dialogContent(f.manager).getByRole("button", { name: "编辑", exact: true }).click();
    const editor = dialogContent(f.manager, { name: "编辑登录项", exact: true });
    await editor.getByLabel("用户名", { exact: true }).fill("unfinished-browser-draft");
    await f.mock.edit("cipher-0", { title: "New phone title", username: "phone-edit" });
    await expect.poll(async () => (await send(f.manager, { type: "VAULT_LIST_ITEMS" })).find((item: LoginItem) => item.title === "New phone title")?.username).toBe("phone-edit");
    await expect(editor.getByLabel("用户名", { exact: true })).toHaveValue("unfinished-browser-draft");
    await editor.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(editor.getByText("此项目已被其他设备或窗口修改。你的草稿仍然保留，请重新打开最新项目后再保存。", { exact: true })).toBeVisible();
    expect(f.mock.count("PUT", "/api/ciphers/cipher-0")).toBe(0);
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await f.manager.getByRole("button", { name: "查看New phone title详情", exact: true }).click();
    await dialogContent(f.manager).getByRole("button", { name: "编辑", exact: true }).click();
    await editor.getByLabel("用户名", { exact: true }).fill("saved-on-browser");
    await editor.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect.poll(async () => (await f.mock.login("cipher-0")).username, { timeout: 15_000 }).toBe("saved-on-browser");
    expect(f.mock.count("PUT", "/api/ciphers/cipher-0")).toBe(1);
    expect(await send(f.manager, { type: "PROVIDER_CONFLICT_LIST", providerId: f.providerId })).toEqual([]);
  } finally { await f.close(); }
});

test("reconnect and token refresh recover edits while the automatic-sync switch and lock stop work", async ({}, testInfo) => {
  const f = await openFixture(testInfo);
  try {
    f.mock.expireToken();
    await f.mock.edit("cipher-0", { username: "after-token-refresh" });
    await expect.poll(async () => (await send(f.manager, { type: "VAULT_LIST_ITEMS" })).find((item: LoginItem) => item.title === "Phone account")?.username).toBe("after-token-refresh");
    expect(f.mock.count("POST", "/identity/connect/token")).toBe(2);
    await f.mock.edit("cipher-0", { title: "Missed notification" }, false);
    f.mock.disconnect();
    await expect(f.manager.getByRole("button", { name: "查看Missed notification详情", exact: true })).toBeVisible();
    await expect.poll(f.mock.handshakes).toBeGreaterThanOrEqual(2);

    await f.manager.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "设置与备份", exact: true }).click();
    const toggle = f.manager.getByRole("switch", { name: "自动同步", exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect.poll(f.mock.connected).toBe(0);
    await expect.poll(f.mock.quietFor).toBeGreaterThan(650);
    const stoppedAt = f.mock.requests.length;
    await f.mock.edit("cipher-0", { title: "While disabled" });
    await f.manager.evaluate(() => window.dispatchEvent(new Event("online")));
    await f.manager.waitForTimeout(900); // Exceeds the queue debounce and initial scheduled check.
    expect(f.mock.requests).toHaveLength(stoppedAt);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect.poll(async () => (await send(f.manager, { type: "VAULT_LIST_ITEMS" })).some((item: LoginItem) => item.title === "While disabled")).toBe(true);
    await expect.poll(f.mock.connected).toBe(1);
    await send(f.manager, { type: "VAULT_LOCK" });
    await expect.poll(f.mock.connected).toBe(0);
    await expect.poll(f.mock.quietFor).toBeGreaterThan(650);
    const lockedAt = f.mock.requests.length;
    await f.mock.edit("cipher-0", { title: "While locked" });
    await f.manager.evaluate(() => window.dispatchEvent(new Event("online")));
    await f.manager.waitForTimeout(900);
    expect(f.mock.requests).toHaveLength(lockedAt);
    await send(f.manager, { type: "VAULT_UNLOCK", masterPassword: VAULT_PASSWORD });
    await expect.poll(async () => (await send(f.manager, { type: "VAULT_LIST_ITEMS" })).some((item: LoginItem) => item.title === "While locked")).toBe(true);
  } finally { await f.close(); }
});

test("a restarted MV3 worker rebuilds its baseline and reconnects the visible vault", async ({}, testInfo) => {
  const f = await openFixture(testInfo);
  try {
    const cdp = await f.context.newCDPSession(f.manager);
    let versionId = "";
    cdp.on("ServiceWorker.workerVersionUpdated", event => {
      versionId = event.versions.find(version => version.scriptURL.startsWith(f.root) && version.runningStatus === "running")?.versionId || versionId;
    });
    await cdp.send("ServiceWorker.enable");
    await expect.poll(() => versionId).not.toBe("");
    const before = f.mock.count("GET", "/api/sync");
    await f.mock.edit("cipher-0", { title: "Changed before restart" }, false);
    await cdp.send("ServiceWorker.stopWorker", { versionId });
    await cdp.detach();
    await expect(f.manager.getByRole("button", { name: "查看Changed before restart详情", exact: true })).toBeVisible({ timeout: 20_000 });
    expect(f.mock.count("GET", "/api/sync")).toBeGreaterThan(before);
    await expect.poll(f.mock.handshakes).toBeGreaterThanOrEqual(2);
  } finally { await f.close(); }
});

test("an open popup receives a phone edit and fills the new credentials", async ({}, testInfo) => {
  const f = await openFixture(testInfo);
  try {
    await f.context.route("https://sync.example.test/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><title>Synthetic login</title><form><label>Username<input id="username" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>' }));
    const website = await f.context.newPage();
    await website.goto("https://sync.example.test/login");
    const popup = await f.context.newPage();
    await website.bringToFront();
    await popup.goto(`${f.root}/popup.html`);
    await expect(popup.locator("#popup-matches").getByRole("button", { name: /Phone account/ })).toBeVisible();
    await popup.bringToFront();
    await f.mock.edit("cipher-0", { title: "Phone popup update", username: "phone-popup-user", password: "synthetic-new-password" });
    const match = popup.locator("#popup-matches").getByRole("button", { name: /Phone popup update/ });
    await expect(match).toContainText("phone-popup-user");
    // This harness renders the popup in a tab. The actual toolbar popup keeps
    // the website active, which the fill authorization requires.
    await website.bringToFront();
    await match.click();
    await expect(website.locator("#username")).toHaveValue("phone-popup-user");
    await expect(website.locator("#password")).toHaveValue("synthetic-new-password");
    await f.manager.bringToFront();
    await expect(f.manager.getByRole("button", { name: "查看Phone popup update详情", exact: true })).toBeVisible();
  } finally { await f.close(); }
});
