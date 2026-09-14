import { createServer } from "node:http";
import path from "node:path";
import * as kdbxweb from "kdbxweb";
import { chromium, expect, test, type Page } from "@playwright/test";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";
import type { LoginItem } from "../../src/core/model";

const kdbx = (kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb;
const PASSWORD = "synthetic automatic KDBX password";
const REMOTE_PATH = "/dav/vault.kdbx";

test("WebDAV checks ETags, automatically receives and publishes KDBX edits, and respects a database lock", async ({}, testInfo) => {
  test.setTimeout(90_000);
  let bytes = await buildKeePassFixture({ password: PASSWORD, name: "Synthetic automatic KDBX", entries: [
    { title: "Phone KDBX", fields: { UserName: "phone-user" }, protectedFields: { Password: "synthetic-only" } },
    { title: "Other KDBX", fields: { UserName: "other-user" } }
  ] });
  let revision = 1;
  let stats = 0;
  let downloads = 0;
  let uploads = 0;
  const etag = () => `"synthetic-kdbx-${revision}"`;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://127.0.0.1");
      if (request.method === "PROPFIND") {
        stats++;
        response.writeHead(207, { "Content-Type": "application/xml" });
        response.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${REMOTE_PATH}</d:href><d:propstat><d:prop><d:getetag>${etag().replaceAll('"', '&quot;')}</d:getetag><d:getcontentlength>${bytes.length}</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>`);
      } else if (url.pathname === REMOTE_PATH && request.method === "GET") {
        downloads++;
        response.writeHead(200, { ETag: etag(), "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
        response.end(Buffer.from(bytes));
      } else if (url.pathname === REMOTE_PATH && request.method === "PUT") {
        if (request.headers["if-match"] !== etag()) { response.writeHead(412); response.end(); return; }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        bytes = new Uint8Array(Buffer.concat(chunks));
        uploads++; revision++;
        response.writeHead(204, { ETag: etag() }); response.end();
      } else { response.writeHead(404); response.end(); }
    })().catch(() => { if (!response.writableEnded) { response.writeHead(500); response.end(); } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic WebDAV server failed");
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), { channel: "chromium", headless: true, locale: "zh-CN", args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  async function editOnPhone(title: string) {
    const database = await kdbx.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
    const entry = database.getDefaultGroup().entries.find(entry => entry.fields.get("UserName") === "phone-user")!;
    entry.fields.set("Title", title); entry.times.update();
    bytes = new Uint8Array(await database.save()); revision++;
  }
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(manager, { type: "VAULT_SETUP", masterPassword: "synthetic automatic browser password" });
    const opened = await send(manager, { type: "KEEPASS_WEBDAV_OPEN", input: { name: "Automatic KDBX", baseUrl: `http://127.0.0.1:${address.port}/dav`, remotePath: "vault.kdbx", username: "synthetic", webDavPassword: "synthetic", databasePassword: PASSWORD } });
    const providerId = opened.account.id;
    await send(manager, { type: "PROVIDER_SYNC", providerId });
    await manager.reload();
    await expect(manager.getByRole("button", { name: "查看Phone KDBX详情", exact: true })).toBeVisible();
    const initialDownloads = downloads;
    const initialStats = stats;
    await expect.poll(() => stats, { timeout: 20_000 }).toBeGreaterThan(initialStats);
    expect(downloads).toBe(initialDownloads);
    expect(uploads).toBe(0);

    await editOnPhone("KDBX edited on phone");
    await expect(manager.getByRole("button", { name: "查看KDBX edited on phone详情", exact: true })).toBeVisible({ timeout: 20_000 });
    expect(downloads).toBe(initialDownloads + 1);
    await expect(manager.getByRole("button", { name: "查看Other KDBX详情", exact: true })).toBeVisible();

    const items = await send(manager, { type: "VAULT_LIST_ITEMS" }) as LoginItem[];
    const current = items.find(item => item.title === "KDBX edited on phone")!;
    await send(manager, { type: "VAULT_UPSERT_ITEM", item: { ...current, notes: "Saved automatically on browser" }, expectedUpdatedAt: current.updatedAt });
    await expect.poll(() => uploads, { timeout: 15_000 }).toBe(1);
    const stored = await kdbx.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
    expect(stored.getDefaultGroup().entries.find(entry => entry.fields.get("UserName") === "phone-user")!.fields.get("Notes")).toBe("Saved automatically on browser");

    await send(manager, { type: "KEEPASS_LOCK", providerId });
    expect(await send(manager, { type: "KEEPASS_STATUS", providerId })).toBeUndefined();
    const lockedStats = stats;
    await editOnPhone("KDBX changed while locked");
    await manager.evaluate(() => window.dispatchEvent(new Event("online")));
    await manager.waitForTimeout(1200);
    expect(stats).toBe(lockedStats);
    expect(await send(manager, { type: "KEEPASS_STATUS", providerId })).toBeUndefined();
    await send(manager, { type: "KEEPASS_REMOTE_RESTORE", providerId });
    await expect(manager.getByRole("button", { name: "查看KDBX changed while locked详情", exact: true })).toBeVisible({ timeout: 20_000 });
    expect(await send(manager, { type: "PROVIDER_CONFLICT_LIST", providerId })).toEqual([]);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    bytes.fill(0);
  }
});

async function send(page: Page, request: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}
