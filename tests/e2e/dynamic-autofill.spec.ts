import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

async function launchExtension(testInfo: TestInfo, profileName: string): Promise<{ context: BrowserContext; extensionId: string; manager: Page }> {
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
  expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "dynamic e2e master password" }))).toMatchObject({ ok: true });
  return { context, extensionId, manager };
}

test("popup explicitly fills a login inserted later inside an open shadow root", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "dynamic-shadow-fill-profile");
    context = launched.context;
    const now = new Date().toISOString();
    expect(await launched.manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
      id: "dynamic-shadow-login",
      kind: "login",
      title: "Dynamic Shadow Account",
      favorite: false,
      notes: "",
      createdAt: now,
      updatedAt: now,
      providerRefs: [],
      username: "shadow-user",
      password: "shadow-secret",
      uris: ["dynamic.example.test"],
      customFields: []
    })).toMatchObject({ ok: true });

    await context.route("https://dynamic.example.test/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Dynamic Shadow Login</title><main id="app"></main><script>
        setTimeout(() => {
          const host = document.createElement('login-shell');
          document.querySelector('#app').append(host);
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML = '<form><input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"></form>';
        }, 50);
      </script>`
    }));
    const loginPage = await context.newPage();
    await loginPage.goto("https://dynamic.example.test/login");
    const username = loginPage.locator("#username");
    const password = loginPage.locator("#password");
    await expect(password).toBeVisible();
    await expect(username).toHaveValue("");
    await expect(password).toHaveValue("");

    const popup = await context.newPage();
    await loginPage.bringToFront();
    await popup.goto(`chrome-extension://${launched.extensionId}/popup.html`);
    await expect(popup.getByText("Dynamic Shadow Account", { exact: true })).toBeVisible();
    await expect(username).toHaveValue("");
    await expect(password).toHaveValue("");
    await popup.getByRole("button", { name: /Dynamic Shadow Account/ }).click();

    await expect(username).toHaveValue("shadow-user");
    await expect(password).toHaveValue("shadow-secret");
  } finally {
    await context?.close();
  }
});

test("two-step SPA login in a late open shadow root offers one save prompt with its username", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "dynamic-shadow-save-profile");
    context = launched.context;
    await context.route("https://steps.example.test/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><title>Two Step Login</title><main id="app"><form id="username-step">
        <input id="username" autocomplete="username"><button type="button">Continue</button></form></main><script>
        document.querySelector('#username-step button').addEventListener('click', () => {
          const app = document.querySelector('#app');
          app.replaceChildren();
          const host = document.createElement('password-step');
          app.append(host);
          const root = host.attachShadow({ mode: 'open' });
          root.innerHTML = '<form><input id="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form>';
          root.querySelector('form').addEventListener('submit', event => event.preventDefault());
        });
      </script>`
    }));
    const loginPage = await context.newPage();
    await loginPage.goto("https://steps.example.test/login");
    await loginPage.locator("#username").fill("two-step-user");
    await loginPage.getByRole("button", { name: "Continue" }).click();
    const password = loginPage.locator("#password");
    await expect(password).toBeVisible();
    await password.fill("two-step-secret");
    await loginPage.getByRole("button", { name: "Sign in" }).click();

    const prompt = loginPage.locator("#monica-save-prompt-host");
    await expect(prompt.locator(".title")).toHaveText("保存到 Monica？");
    await prompt.locator(".primary").click();
    await expect(prompt.locator(".status")).toContainText("已保存");
    const response = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data?: Array<{ username: string; password: string }> };
    expect(response).toMatchObject({ ok: true });
    expect(response.data).toEqual([expect.objectContaining({ username: "two-step-user", password: "two-step-secret" })]);
  } finally {
    await context?.close();
  }
});
