import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { buildKeePassFixture } from "../../src/providers/keepass/keepass-fixture";

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
