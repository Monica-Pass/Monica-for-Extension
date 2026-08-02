import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function launchExtension(testInfo: TestInfo, profileName: string): Promise<{ context: BrowserContext; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath(profileName), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  const setup = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "security boundary e2e password" })) as RuntimeResponse;
  expect(setup, setup.error).toMatchObject({ ok: true });
  return { context, manager };
}

async function seedLogin(manager: Page, itemId: string, pageUrl: string): Promise<void> {
  const now = "2026-07-15T00:00:00.000Z";
  const result = await manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
    id: itemId,
    kind: "login",
    title: "Security boundary account",
    favorite: false,
    notes: "",
    createdAt: now,
    updatedAt: now,
    providerRefs: [],
    username: "boundary-user",
    password: "boundary-secret",
    uris: [new URL(pageUrl).hostname],
    customFields: []
  }) as RuntimeResponse;
  expect(result, result.error).toMatchObject({ ok: true });
}

async function tabState(manager: Page, pageUrl: string): Promise<{ id: number; active: boolean }> {
  const state = await manager.evaluate(async (expectedUrl) => {
    const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === expectedUrl);
    return tab?.id === undefined ? undefined : { id: tab.id, active: Boolean(tab.active) };
  }, pageUrl);
  expect(state, `No browser tab found for ${pageUrl}`).toBeDefined();
  return state!;
}

async function fillLogin(manager: Page, itemId: string, tabId: number): Promise<RuntimeResponse> {
  return manager.evaluate(async ({ id, targetTabId }) => chrome.runtime.sendMessage({ type: "VAULT_FILL_LOGIN", itemId: id, tabId: targetTabId }), {
    id: itemId,
    targetTabId: tabId
  });
}

test("MDBX2 bootstrap and synchronization commands are restricted to the manager page", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "mdbx2-manager-policy-profile");
    context = launched.context;
    const extensionId = new URL(launched.manager.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const response = await popup.evaluate(async () => chrome.runtime.sendMessage({
      type: "MDBX2_BOOTSTRAP_DOWNLOAD",
      config: { baseUrl: "https://dav.example.test", username: "private-user", password: "private-password", remotePath: "vaults/main.mdbx" }
    })) as RuntimeResponse;
    expect(response.ok).toBe(false);
    expect(response.error).toContain("只允许 Monica 管理页调用");
    const historyResponse = await popup.evaluate(async () => chrome.runtime.sendMessage({
      type: "MDBX2_HISTORY_LIST",
      providerId: "manager-only-provider",
      pageSize: 20
    })) as RuntimeResponse;
    expect(historyResponse.ok).toBe(false);
    expect(historyResponse.error).toContain("只允许 Monica 管理页调用");
    const historyRevertResponse = await popup.evaluate(async () => chrome.runtime.sendMessage({
      type: "MDBX2_HISTORY_REVERT",
      providerId: "manager-only-provider",
      operationId: "11111111-1111-4111-8111-111111111111",
      commitId: "22222222-2222-4222-8222-222222222222"
    })) as RuntimeResponse;
    expect(historyRevertResponse.ok).toBe(false);
    expect(historyRevertResponse.error).toContain("只允许 Monica 管理页调用");
    const diagnosticsResponse = await popup.evaluate(async () => chrome.runtime.sendMessage({
      type: "MDBX2_VAULT_DIAGNOSTICS",
      providerId: "manager-only-provider"
    })) as RuntimeResponse;
    expect(diagnosticsResponse.ok).toBe(false);
    expect(diagnosticsResponse.error).toContain("只允许 Monica 管理页调用");
    const tigaResponse = await popup.evaluate(async () => chrome.runtime.sendMessage({
      type: "MDBX2_VAULT_TIGA",
      providerId: "manager-only-provider"
    })) as RuntimeResponse;
    expect(tigaResponse.ok).toBe(false);
    expect(tigaResponse.error).toContain("只允许 Monica 管理页调用");
    const collectionRequests = [
      { type: "MDBX2_COLLECTION_LIST", providerId: "manager-only-provider", excludeRoot: true, pageSize: 50 },
      { type: "MDBX2_COLLECTION_CREATE", providerId: "manager-only-provider", operationId: "11111111-1111-4111-8111-111111111111", collectionId: "22222222-2222-4222-8222-222222222222", title: "Accounts" },
      { type: "MDBX2_COLLECTION_RENAME", providerId: "manager-only-provider", operationId: "11111111-1111-4111-8111-111111111111", collectionId: "22222222-2222-4222-8222-222222222222", title: "Work" },
      { type: "MDBX2_COLLECTION_MOVE", providerId: "manager-only-provider", operationId: "11111111-1111-4111-8111-111111111111", collectionId: "22222222-2222-4222-8222-222222222222" },
      { type: "MDBX2_COLLECTION_DELETE", providerId: "manager-only-provider", operationId: "11111111-1111-4111-8111-111111111111", collectionId: "22222222-2222-4222-8222-222222222222", confirmed: true },
      { type: "MDBX2_COLLECTION_RESTORE", providerId: "manager-only-provider", operationId: "11111111-1111-4111-8111-111111111111", collectionId: "22222222-2222-4222-8222-222222222222" }
    ];
    for (const request of collectionRequests) {
      const collectionResponse = await popup.evaluate(async (message) => chrome.runtime.sendMessage(message), request) as RuntimeResponse;
      expect(collectionResponse.ok).toBe(false);
      expect(collectionResponse.error).toContain("只允许 Monica 管理页调用");
    }
    const snapshotRequests = [
      { type: "MDBX2_SNAPSHOT_LIST", providerId: "manager-only-provider", pageSize: 20 },
      { type: "MDBX2_SNAPSHOT_STRUCTURE", providerId: "manager-only-provider", snapshotId: "11111111-1111-4111-8111-111111111111", side: "snapshot", pageSize: 100 },
      { type: "MDBX2_SNAPSHOT_PRUNE_PLAN", providerId: "manager-only-provider", keepLatest: 0 },
      { type: "MDBX2_SNAPSHOT_PRUNE_EXECUTE", providerId: "manager-only-provider", planToken: "a".repeat(64), keepLatest: 0 },
      { type: "MDBX2_SNAPSHOT_CREATE", providerId: "manager-only-provider", operationId: "11111111-1111-4111-8111-111111111111", name: "" },
      { type: "MDBX2_SNAPSHOT_DELETE", providerId: "manager-only-provider", operationId: "11111111-1111-4111-8111-111111111111", snapshotId: "22222222-2222-4222-8222-222222222222" },
      { type: "MDBX2_SNAPSHOT_RESTORE", providerId: "manager-only-provider", operationId: "11111111-1111-4111-8111-111111111111", snapshotId: "22222222-2222-4222-8222-222222222222" }
    ];
    for (const request of snapshotRequests) {
      const snapshotResponse = await popup.evaluate(async (message) => chrome.runtime.sendMessage(message), request) as RuntimeResponse;
      expect(snapshotResponse.ok).toBe(false);
      expect(snapshotResponse.error).toContain("只允许 Monica 管理页调用");
    }
    const attachmentRequests = [
      { type: "PROVIDER_ATTACHMENT_LIST", providerId: "keepass-provider", itemId: "item-1", pageSize: 20 },
      { type: "PROVIDER_ATTACHMENT_READ_BEGIN", providerId: "keepass-provider", itemId: "item-1", attachmentId: "11111111-1111-4111-8111-111111111111" },
      { type: "PROVIDER_ATTACHMENT_READ_CHUNK", providerId: "keepass-provider", readHandle: "11111111-1111-4111-8111-111111111111", offset: 0, maxBytes: 1024 },
      { type: "PROVIDER_ATTACHMENT_READ_RELEASE", providerId: "keepass-provider", readHandle: "11111111-1111-4111-8111-111111111111" },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN", providerId: "keepass-provider", itemId: "item-1", fileName: "a.txt", sizeBytes: 1 },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK", providerId: "keepass-provider", transferId: "11111111-1111-4111-8111-111111111111", offset: 0, dataBase64: "AQ==" },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH", providerId: "keepass-provider", itemId: "item-1", transferId: "11111111-1111-4111-8111-111111111111" },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_ABORT", providerId: "keepass-provider", transferId: "11111111-1111-4111-8111-111111111111" },
      { type: "PROVIDER_ATTACHMENT_DELETE", providerId: "keepass-provider", itemId: "item-1", attachmentId: "11111111-1111-4111-8111-111111111111", confirmed: true },
      { type: "KEEPASS_EXPORT_FILE", providerId: "keepass-provider" }
    ];
    for (const request of attachmentRequests) {
      const attachmentResponse = await popup.evaluate(async (message) => chrome.runtime.sendMessage(message), request) as RuntimeResponse;
      expect(attachmentResponse.ok).toBe(false);
      expect(attachmentResponse.error).toContain("只允许 Monica 管理页调用");
    }
    const conflictListResponse = await popup.evaluate(async () => chrome.runtime.sendMessage({
      type: "MDBX2_CONFLICT_LIST",
      providerId: "manager-only-provider",
      pageSize: 20
    })) as RuntimeResponse;
    expect(conflictListResponse.ok).toBe(false);
    expect(conflictListResponse.error).toContain("只允许 Monica 管理页调用");
    const conflictResolveResponse = await popup.evaluate(async () => chrome.runtime.sendMessage({
      type: "MDBX2_CONFLICT_RESOLVE",
      providerId: "manager-only-provider",
      operationId: "11111111-1111-4111-8111-111111111111",
      conflictId: "22222222-2222-4222-8222-222222222222",
      choice: "local-wins"
    })) as RuntimeResponse;
    expect(conflictResolveResponse.ok).toBe(false);
    expect(conflictResolveResponse.error).toContain("只允许 Monica 管理页调用");
  } finally {
    await context?.close();
  }
});

test("non-loopback HTTP login submissions are rejected without retaining a password", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "insecure-save-profile");
    context = launched.context;
    await context.route("http://insecure-save.example.test/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Insecure Save</title><form id="login">
        <input id="username" autocomplete="username">
        <input id="password" type="password" autocomplete="current-password">
        <button type="submit">Sign in</button>
      </form><script>document.querySelector("form").addEventListener("submit", event => event.preventDefault())</script>`
    }));

    const page = await context.newPage();
    await page.goto("http://insecure-save.example.test/login");
    await page.locator("#username").fill("unsafe@example.test");
    await page.locator("#password").fill("must-never-be-retained");
    const rejection = page.waitForEvent("console", {
      predicate: (message) => message.text().includes("[Monica] Credential candidate rejected:") && message.text().includes("不安全的 HTTP")
    });
    await page.getByRole("button", { name: "Sign in" }).click();
    await rejection;
    await expect(page.locator("#monica-save-prompt-host")).toHaveCount(0);

    const listed = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as RuntimeResponse<unknown[]>;
    expect(listed, listed.error).toMatchObject({ ok: true, data: [] });
  } finally {
    await context?.close();
  }
});

test("login filling is rejected for a non-loopback HTTP target", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "insecure-fill-profile");
    context = launched.context;
    const pageUrl = "http://insecure-fill.example.test/login";
    await context.route("http://insecure-fill.example.test/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password">'
    }));
    const page = await context.newPage();
    await page.goto(pageUrl);
    await seedLogin(launched.manager, "insecure-fill-login", pageUrl);
    await page.bringToFront();
    const target = await tabState(launched.manager, pageUrl);
    expect(target.active).toBe(true);

    const response = await fillLogin(launched.manager, "insecure-fill-login", target.id);
    expect(response.ok).toBe(false);
    expect(response.error).toContain("不安全的 HTTP 页面");
    await expect(page.locator("#username")).toHaveValue("");
    await expect(page.locator("#password")).toHaveValue("");
  } finally {
    await context?.close();
  }
});

test("login filling is rejected when the target tab is not active", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "inactive-fill-profile");
    context = launched.context;
    const pageUrl = "https://inactive-fill.example.test/login";
    await context.route("https://inactive-fill.example.test/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password">'
    }));
    await context.route("https://active-decoy.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Active decoy</title>" }));
    const targetPage = await context.newPage();
    await targetPage.goto(pageUrl);
    await seedLogin(launched.manager, "inactive-fill-login", pageUrl);
    const decoy = await context.newPage();
    await decoy.goto("https://active-decoy.example.test/");
    await decoy.bringToFront();
    const target = await tabState(launched.manager, pageUrl);
    expect(target.active).toBe(false);

    const response = await fillLogin(launched.manager, "inactive-fill-login", target.id);
    expect(response.ok).toBe(false);
    expect(response.error).toContain("非活动标签页");
    await expect(targetPage.locator("#username")).toHaveValue("");
    await expect(targetPage.locator("#password")).toHaveValue("");
  } finally {
    await context?.close();
  }
});

test("login filling is rejected after the reviewed document navigates", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "stale-document-fill-profile");
    context = launched.context;
    const pageUrl = "https://stale-document.example.test/login";
    await context.route("https://stale-document.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password">' }));
    const page = await context.newPage();
    await page.goto(pageUrl);
    await seedLogin(launched.manager, "stale-document-login", pageUrl);
    await page.bringToFront();
    const target = await tabState(launched.manager, pageUrl);
    const reviewed = await launched.manager.evaluate(async (tabId) => (await chrome.webNavigation.getAllFrames({ tabId }))?.find((frame) => frame.frameId === 0), target.id);
    expect(reviewed?.documentId).toEqual(expect.any(String));
    await page.reload();
    const response = await launched.manager.evaluate(async ({ tabId, documentId, origin }) => chrome.runtime.sendMessage({ type: "VAULT_FILL_LOGIN", itemId: "stale-document-login", tabId, frameId: 0, documentId, expectedOrigin: origin }), { tabId: target.id, documentId: reviewed!.documentId, origin: new URL(pageUrl).origin }) as RuntimeResponse;
    expect(response.ok).toBe(false);
    expect(response.error).toContain("页面已变化");
    await expect(page.locator("#username")).toHaveValue("");
    await expect(page.locator("#password")).toHaveValue("");
  } finally {
    await context?.close();
  }
});

test("a top-page match is not reused for a cross-origin iframe", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "iframe-boundary");
    context = launched.context;
    const topUrl = "https://top-login.example.test/";
    await context.route("https://top-login.example.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<iframe src="https://untrusted-frame.attacker.test/login"></iframe>' }));
    await context.route("https://untrusted-frame.attacker.test/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password">' }));
    const page = await context.newPage();
    await page.goto(topUrl);
    await seedLogin(launched.manager, "top-only-login", topUrl);
    await page.bringToFront();
    const target = await tabState(launched.manager, topUrl);
    const frames = await launched.manager.evaluate(async (tabId) => chrome.webNavigation.getAllFrames({ tabId }), target.id);
    const child = frames?.find((frame) => frame.url.startsWith("https://untrusted-frame.attacker.test/"));
    expect(child).toBeDefined();
    const response = await launched.manager.evaluate(async ({ tabId, frame }) => chrome.runtime.sendMessage({ type: "VAULT_FILL_LOGIN", itemId: "top-only-login", tabId, frameId: frame.frameId, documentId: frame.documentId, expectedOrigin: new URL(frame.url).origin }), { tabId: target.id, frame: child! }) as RuntimeResponse;
    expect(response.ok).toBe(false);
    expect(response.error).toContain("目标页面不匹配");
    const childFrame = page.frames().find((frame) => frame.url().startsWith("https://untrusted-frame.attacker.test/"))!;
    await expect(childFrame.locator("#username")).toHaveValue("");
    await expect(childFrame.locator("#password")).toHaveValue("");
  } finally {
    await context?.close();
  }
});
