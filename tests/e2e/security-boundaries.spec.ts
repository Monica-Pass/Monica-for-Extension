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
