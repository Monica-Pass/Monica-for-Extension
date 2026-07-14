import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

interface ListedLogin {
  id: string;
  kind: string;
  username: string;
  password: string;
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
  const setup = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "save prompt e2e master password" }));
  expect(setup).toMatchObject({ ok: true });
  return { context, manager };
}

async function routeLoginPage(context: BrowserContext): Promise<void> {
  await context.route("https://save.example.test/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><title>Save Example</title>
      <form id="login">
        <label>Email <input id="username" type="email" autocomplete="username"></label>
        <label>Password <input id="password" type="password" autocomplete="current-password"></label>
        <button type="submit">登录</button>
      </form>
      <script>document.querySelector("form").addEventListener("submit", event => event.preventDefault())</script>`
  }));
}

async function listItems(manager: Page): Promise<ListedLogin[]> {
  const response = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data?: ListedLogin[]; error?: string };
  expect(response, response.error).toMatchObject({ ok: true });
  return response.data || [];
}

async function triggerLogin(page: Page): Promise<void> {
  await page.locator("#login button").click();
}

test("save prompt explicitly stores a newly submitted login in the encrypted local vault", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "new-login-profile");
    context = launched.context;
    await routeLoginPage(context);
    const page = await context.newPage();
    await page.goto("https://save.example.test/login");
    await page.locator("#username").fill("joy@example.com");
    await page.locator("#password").fill("new-login-secret");
    await triggerLogin(page);

    const prompt = page.locator("#monica-save-prompt-host");
    await expect(prompt.locator(".title")).toHaveText("保存到 Monica？");
    await expect(prompt.locator("select")).toHaveValue(/.+/);
    await prompt.locator(".primary").click();
    await expect(prompt.locator(".status")).toContainText("已保存");

    const items = await listItems(launched.manager);
    expect(items).toEqual([expect.objectContaining({ kind: "login", username: "joy@example.com", password: "new-login-secret" })]);
  } finally {
    await context?.close();
  }
});

test("save prompt updates the matching login with a submitted replacement password", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "update-login-profile");
    context = launched.context;
    const now = new Date().toISOString();
    const existing = {
      id: "existing-save-login",
      kind: "login",
      title: "Existing Save Account",
      favorite: false,
      notes: "",
      createdAt: now,
      updatedAt: now,
      providerRefs: [],
      username: "joy@example.com",
      password: "old-secret",
      uris: ["https://save.example.test"],
      customFields: []
    };
    const seeded = await launched.manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), existing);
    expect(seeded).toMatchObject({ ok: true });
    await routeLoginPage(context);
    const page = await context.newPage();
    await page.goto("https://save.example.test/login");
    await page.locator("#username").fill("joy@example.com");
    await page.locator("#password").fill("replacement-secret");
    await triggerLogin(page);

    const prompt = page.locator("#monica-save-prompt-host");
    await expect(prompt.locator(".title")).toHaveText("更新 Monica 中的密码？");
    await expect(prompt.locator(".subtitle")).toContainText("Existing Save Account");
    await expect(prompt.locator("select")).toHaveCount(0);
    await prompt.locator(".primary").click();
    await expect(prompt.locator(".status")).toContainText("已更新");

    const items = await listItems(launched.manager);
    expect(items).toEqual([expect.objectContaining({ id: existing.id, password: "replacement-secret" })]);
    expect(items[0].password).not.toBe("old-secret");
  } finally {
    await context?.close();
  }
});

test("save prompt dismisses a submitted login without writing it", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "dismiss-login-profile");
    context = launched.context;
    await routeLoginPage(context);
    const page = await context.newPage();
    await page.goto("https://save.example.test/login");
    await page.locator("#username").fill("dismiss@example.com");
    await page.locator("#password").fill("must-not-save");
    await triggerLogin(page);

    const prompt = page.locator("#monica-save-prompt-host");
    await expect(prompt.locator(".title")).toHaveText("保存到 Monica？");
    await prompt.locator(".secondary").click();
    await expect(prompt).toHaveCount(0);
    expect(await listItems(launched.manager)).toEqual([]);
  } finally {
    await context?.close();
  }
});
