import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import * as kdbxweb from "kdbxweb";
import path from "node:path";
import { buildKeePassFixture, keePassCredentials } from "../../src/providers/keepass/keepass-fixture";

const kdbxRuntime = ((kdbxweb as unknown as { default?: typeof kdbxweb }).default ?? kdbxweb);

const VAULT_PASSWORD = "keepass remote runtime vault password";
const DATABASE_PASSWORD = "keepass remote runtime database password";
const WEBDAV_PASSWORD = "keepass remote runtime webdav password";
const REMOTE_ORIGIN = "https://keepass-runtime.example.test";
const REMOTE_PATH = "/root/vaults/main.kdbx";

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

interface KeePassOpenResult {
  account: {
    id: string;
    config: Record<string, unknown>;
  };
  session: {
    providerId: string;
    sourceMode: "local-file" | "webdav";
    databaseName: string;
    itemCount: number;
    dirty: boolean;
  };
}

async function launchExtension(testInfo: TestInfo): Promise<{ context: BrowserContext; extensionId: string; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("p"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  const setup = await manager.evaluate(async (masterPassword) => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword }), VAULT_PASSWORD) as RuntimeResponse;
  expect(setup, setup.error).toMatchObject({ ok: true });
  return { context, extensionId, manager };
}

test("remote KeePass restores from Chromium IndexedDB after a new Service Worker starts", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const fixture = await buildKeePassFixture({
      password: DATABASE_PASSWORD,
      name: "Remote Runtime Fixture",
      entries: [{
        title: "Remote runtime login",
        fields: { UserName: "remote-runtime-user", URL: "https://runtime.example.test" },
        protectedFields: { Password: "remote-runtime-secret" }
      }]
    });
    const launched = await launchExtension(testInfo);
    context = launched.context;
    let downloadCount = 0;

    await context.route(`${REMOTE_ORIGIN}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "PROPFIND" && url.pathname === REMOTE_PATH) {
        await route.fulfill({
          status: 207,
          contentType: "application/xml; charset=utf-8",
          body: webDavStat(url.toString(), fixture.length)
        });
        return;
      }
      if (request.method() === "GET" && url.pathname === REMOTE_PATH) {
        downloadCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          headers: { ETag: '"runtime-etag-1"', "Content-Length": String(fixture.length) },
          body: Buffer.from(fixture)
        });
        return;
      }
      await route.fulfill({ status: 500, body: `Unexpected ${request.method()} ${url.pathname}` });
    });

    const opened = await launched.manager.evaluate(async (input) => chrome.runtime.sendMessage({
      type: "KEEPASS_WEBDAV_OPEN",
      input
    }), {
      name: "Remote Runtime KeePass",
      baseUrl: `${REMOTE_ORIGIN}/root`,
      username: "remote-runtime-user",
      webDavPassword: WEBDAV_PASSWORD,
      remotePath: "vaults/main.kdbx",
      databasePassword: DATABASE_PASSWORD,
      isDefaultSaveTarget: false
    }) as RuntimeResponse<KeePassOpenResult>;

    expect(opened, opened.error).toMatchObject({
      ok: true,
      data: {
        account: {
          config: {
            sourceMode: "webdav",
            webDavPasswordConfigured: true,
            databaseCredentialStored: true,
            workingCopyAvailable: true,
            remoteEtagAvailable: true
          }
        },
        session: {
          sourceMode: "webdav",
          databaseName: "Remote Runtime Fixture",
          itemCount: 1,
          dirty: false
        }
      }
    });
    expect(downloadCount).toBe(1);
    const providerId = opened.data!.account.id;
    assertSecretsAbsent(opened);

    const listed = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "PROVIDER_LIST" })) as RuntimeResponse;
    expect(listed, listed.error).toMatchObject({ ok: true });
    assertSecretsAbsent(listed);

    await terminateExtensionServiceWorker(context, launched.manager, launched.extensionId);
    await expect.poll(
      () => extensionServiceWorkerTargetId(context!, launched.manager, launched.extensionId),
      { message: "The original extension Service Worker should stop before restore" }
    ).toBeUndefined();
    const restored = await launched.manager.evaluate(async (id) => chrome.runtime.sendMessage({ type: "KEEPASS_STATUS", providerId: id }), providerId) as RuntimeResponse<KeePassOpenResult["session"]>;
    await expect.poll(
      () => extensionServiceWorkerTargetId(context!, launched.manager, launched.extensionId),
      { message: "A new extension Service Worker target should handle the restore request" }
    ).toBeDefined();

    expect(restored, restored.error).toMatchObject({
      ok: true,
      data: {
        providerId,
        sourceMode: "webdav",
        databaseName: "Remote Runtime Fixture",
        itemCount: 1,
        dirty: false
      }
    });
    expect(downloadCount).toBe(1);

    const locked = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LOCK" })) as RuntimeResponse;
    expect(locked, locked.error).toMatchObject({ ok: true });
    const refused = await launched.manager.evaluate(async (id) => chrome.runtime.sendMessage({ type: "KEEPASS_REMOTE_RESTORE", providerId: id }), providerId) as RuntimeResponse;
    expect(refused).toMatchObject({ ok: false, code: "VAULT_LOCKED" });
  } finally {
    await context?.close();
  }
});

test("remote KeePass group, attachment and history acknowledgements replay after Service Worker restart", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const fixture = await buildDurabilityFixture();
    const launched = await launchExtension(testInfo);
    context = launched.context;
    let downloadCount = 0;
    await context.route(`${REMOTE_ORIGIN}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === "PROPFIND" && url.pathname === REMOTE_PATH) {
        await route.fulfill({ status: 207, contentType: "application/xml; charset=utf-8", body: webDavStat(url.toString(), fixture.length) });
        return;
      }
      if (request.method() === "GET" && url.pathname === REMOTE_PATH) {
        downloadCount += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          headers: { ETag: '"runtime-etag-1"', "Content-Length": String(fixture.length) },
          body: Buffer.from(fixture)
        });
        return;
      }
      await route.fulfill({ status: 500, body: `Unexpected ${request.method()} ${url.pathname}` });
    });

    const opened = await openRemoteKeePass(launched.manager, "Remote Durable KeePass");
    const providerId = opened.data!.account.id;
    const firstSync = await send(launched.manager, { type: "PROVIDER_SYNC", providerId });
    expect(firstSync, firstSync.error).toMatchObject({ ok: true });
    const items = await send<Array<{ id: string; title: string }>>(launched.manager, { type: "VAULT_LIST_ITEMS" });
    const item = items.data?.find((candidate) => candidate.title === "Remote durable login");
    expect(item).toBeTruthy();

    const groupOperationId = "11111111-1111-4111-8111-111111111111";
    const createGroupRequest = { type: "KEEPASS_GROUP_CREATE", providerId, operationId: groupOperationId, name: "Durable Private Group" };
    const createdGroup = await send(launched.manager, createGroupRequest);
    expect(createdGroup, createdGroup.error).toMatchObject({ ok: true, data: { changed: true, group: { name: "Durable Private Group" } } });
    await restartWorker(context, launched.manager, launched.extensionId);
    const replayedGroup = await send(launched.manager, createGroupRequest);
    expect(replayedGroup, replayedGroup.error).toMatchObject({ ok: true, data: { changed: true, group: { name: "Durable Private Group" } } });
    const groups = await send<{ items: Array<{ name: string }> }>(launched.manager, { type: "KEEPASS_GROUP_LIST", providerId, includeRecycleBin: true, pageSize: 50 });
    expect(groups, groups.error).toMatchObject({ ok: true });
    expect(groups.data?.items.filter((candidate) => candidate.name === "Durable Private Group")).toHaveLength(1);

    const attachmentBytes = Buffer.from("private durable attachment payload", "utf8");
    const upload = await send<{ transferId: string }>(launched.manager, {
      type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN",
      providerId,
      itemId: item!.id,
      fileName: "private-durable-proof.txt",
      mediaType: "text/plain",
      sizeBytes: attachmentBytes.length,
      operationId: "22222222-2222-4222-8222-222222222222",
      attachmentId: "33333333-3333-4333-8333-333333333333"
    });
    expect(upload, upload.error).toMatchObject({ ok: true });
    const transferId = upload.data!.transferId;
    expect(await send(launched.manager, {
      type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK",
      providerId,
      transferId,
      offset: 0,
      dataBase64: attachmentBytes.toString("base64")
    })).toMatchObject({ ok: true });
    const finishRequest = { type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH", providerId, itemId: item!.id, transferId };
    const finished = await send(launched.manager, finishRequest);
    expect(finished, finished.error).toMatchObject({ ok: true, data: { changed: true, attachment: { fileName: "private-durable-proof.txt" } } });
    await restartWorker(context, launched.manager, launched.extensionId);
    const replayedFinish = await send(launched.manager, finishRequest);
    expect(replayedFinish, replayedFinish.error).toMatchObject({ ok: true, data: { changed: true, attachment: { fileName: "private-durable-proof.txt" } } });
    const attachments = await send<{ items: Array<{ fileName: string }> }>(launched.manager, { type: "PROVIDER_ATTACHMENT_LIST", providerId, itemId: item!.id, pageSize: 50 });
    expect(attachments, attachments.error).toMatchObject({ ok: true });
    expect(attachments.data?.items.filter((candidate) => candidate.fileName === "private-durable-proof.txt")).toHaveLength(1);

    const historyBefore = await send<{ items: Array<{ historyId: string }> }>(launched.manager, { type: "KEEPASS_HISTORY_LIST", providerId, itemId: item!.id, pageSize: 50 });
    expect(historyBefore, historyBefore.error).toMatchObject({ ok: true });
    expect(historyBefore.data?.items.length).toBeGreaterThan(0);
    const restoreRequest = {
      type: "KEEPASS_HISTORY_RESTORE",
      providerId,
      itemId: item!.id,
      operationId: "44444444-4444-4444-8444-444444444444",
      historyId: historyBefore.data!.items[0].historyId,
      confirmed: true
    };
    const restored = await send(launched.manager, restoreRequest);
    expect(restored, restored.error).toMatchObject({ ok: true, data: { changed: true } });
    const expectedHistoryCount = (restored.data as { historyCount: number }).historyCount;
    await restartWorker(context, launched.manager, launched.extensionId);
    const replayedRestore = await send(launched.manager, restoreRequest);
    expect(replayedRestore, replayedRestore.error).toMatchObject({ ok: true, data: { changed: true, historyCount: expectedHistoryCount } });
    const historyAfter = await send<{ items: Array<{ historyId: string }> }>(launched.manager, { type: "KEEPASS_HISTORY_LIST", providerId, itemId: item!.id, pageSize: 50 });
    expect(historyAfter, historyAfter.error).toMatchObject({ ok: true });
    expect(historyAfter.data?.items).toHaveLength(expectedHistoryCount);

    const rawReceipts = await launched.manager.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("monica-extension-keepass-working-copies");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
          const transaction = database.transaction("operation-receipts", "readonly");
          const request = transaction.objectStore("operation-receipts").getAll();
          request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
          request.onerror = () => reject(request.error);
        });
      } finally {
        database.close();
      }
    });
    expect(rawReceipts.length).toBeGreaterThanOrEqual(3);
    for (const record of rawReceipts) {
      expect(Object.keys(record).sort()).toEqual(["cipher", "ciphertext", "completedAt", "intentTag", "iv", "key", "operationId", "providerId", "version"].sort());
    }
    const raw = JSON.stringify(rawReceipts);
    for (const secret of ["Durable Private Group", "private-durable-proof.txt", "private durable attachment payload", "old-runtime-user", "remote-runtime-secret"]) {
      expect(raw).not.toContain(secret);
    }
    expect(downloadCount).toBe(1);
  } finally {
    await context?.close();
  }
});

async function terminateExtensionServiceWorker(context: BrowserContext, manager: Page, extensionId: string): Promise<void> {
  const session = await context.newCDPSession(manager);
  try {
    const targets = await session.send("Target.getTargets") as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    const target = targets.targetInfos.find((candidate) => candidate.type === "service_worker" && new URL(candidate.url).host === extensionId);
    expect(target, "Extension Service Worker target was not found").toBeTruthy();
    await session.send("ServiceWorker.enable");
    await session.send("ServiceWorker.stopAllWorkers");
  } finally {
    await session.detach();
  }
}

async function restartWorker(context: BrowserContext, manager: Page, extensionId: string): Promise<void> {
  await terminateExtensionServiceWorker(context, manager, extensionId);
  await expect.poll(
    () => extensionServiceWorkerTargetId(context, manager, extensionId),
    { message: "The extension Service Worker should stop before durable replay" }
  ).toBeUndefined();
}

async function extensionServiceWorkerTargetId(context: BrowserContext, manager: Page, extensionId: string): Promise<string | undefined> {
  const session = await context.newCDPSession(manager);
  try {
    const targets = await session.send("Target.getTargets") as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    return targets.targetInfos.find((candidate) => candidate.type === "service_worker" && new URL(candidate.url).host === extensionId)?.targetId;
  } finally {
    await session.detach();
  }
}

function webDavStat(url: string, sizeBytes: number): string {
  const pathName = new URL(url).pathname;
  return `<?xml version="1.0" encoding="utf-8"?>
    <d:multistatus xmlns:d="DAV:">
      <d:response>
        <d:href>${pathName}</d:href>
        <d:propstat><d:prop>
          <d:getetag>&quot;runtime-etag-1&quot;</d:getetag>
          <d:getcontentlength>${sizeBytes}</d:getcontentlength>
          <d:getlastmodified>Fri, 07 Aug 2026 04:00:00 GMT</d:getlastmodified>
        </d:prop></d:propstat>
      </d:response>
    </d:multistatus>`;
}

function assertSecretsAbsent(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of [DATABASE_PASSWORD, WEBDAV_PASSWORD, '"runtime-etag-1"', "remote-runtime-secret"]) {
    expect(serialized).not.toContain(secret);
  }
}

async function openRemoteKeePass(manager: Page, name: string): Promise<RuntimeResponse<KeePassOpenResult>> {
  const opened = await send<KeePassOpenResult>(manager, {
    type: "KEEPASS_WEBDAV_OPEN",
    input: {
      name,
      baseUrl: `${REMOTE_ORIGIN}/root`,
      username: "remote-runtime-user",
      webDavPassword: WEBDAV_PASSWORD,
      remotePath: "vaults/main.kdbx",
      databasePassword: DATABASE_PASSWORD,
      isDefaultSaveTarget: false
    }
  });
  expect(opened, opened.error).toMatchObject({ ok: true });
  return opened;
}

async function send<T = unknown>(manager: Page, request: Record<string, unknown>): Promise<RuntimeResponse<T>> {
  return manager.evaluate(async (message) => chrome.runtime.sendMessage(message), request) as Promise<RuntimeResponse<T>>;
}

async function buildDurabilityFixture(): Promise<Uint8Array> {
  const base = await buildKeePassFixture({
    password: DATABASE_PASSWORD,
    name: "Remote Durable Fixture",
    entries: [{
      title: "Remote durable login",
      fields: { UserName: "current-runtime-user", URL: "https://durable.example.test" },
      protectedFields: { Password: "remote-runtime-secret" }
    }]
  });
  const database = await kdbxRuntime.Kdbx.load(base.slice().buffer, keePassCredentials(DATABASE_PASSWORD));
  const entry = database.getDefaultGroup().entries[0];
  entry.fields.set("UserName", "old-runtime-user");
  entry.pushHistory();
  entry.fields.set("UserName", "current-runtime-user");
  entry.times.lastModTime = new Date("2026-08-07T05:00:00.000Z");
  return new Uint8Array(await database.save());
}
