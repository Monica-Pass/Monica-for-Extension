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

test("popup fills the login form that was focused before opening the popup", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "focused-form-fill-profile");
    context = launched.context;
    const now = new Date().toISOString();
    expect(await launched.manager.evaluate(async (item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
      id: "focused-form-login", kind: "login", title: "Focused Form Account", favorite: false, notes: "", createdAt: now, updatedAt: now,
      providerRefs: [], username: "focused-user", password: "focused-secret", uris: ["focused-forms.example.test"], customFields: []
    })).toMatchObject({ ok: true });
    await context.route("https://focused-forms.example.test/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><title>Focused forms</title><form id="first"><input autocomplete="username"><input type="password" autocomplete="current-password"></form><form id="second"><input autocomplete="username"><input type="password" autocomplete="current-password"></form>'
    }));
    const page = await context.newPage();
    await page.goto("https://focused-forms.example.test/login");
    await page.locator("#second input").first().focus();
    const popup = await context.newPage();
    await page.bringToFront();
    await popup.goto(`chrome-extension://${launched.extensionId}/popup.html`);
    await popup.getByRole("button", { name: /Focused Form Account/ }).click();
    await expect(page.locator("#first input").nth(0)).toHaveValue("");
    await expect(page.locator("#first input").nth(1)).toHaveValue("");
    await expect(page.locator("#second input").nth(0)).toHaveValue("focused-user");
    await expect(page.locator("#second input").nth(1)).toHaveValue("focused-secret");
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
    await expect(prompt).toHaveCount(1);
    expect(await prompt.evaluate((host) => host.shadowRoot)).toBeNull();
    await expect.poll(() => prompt.evaluate((host) => document.activeElement === host)).toBe(true);
    await loginPage.keyboard.press("Enter");
    await expect.poll(async () => {
      const response = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data?: Array<{ username: string }> };
      return response.data?.[0]?.username;
    }).toBe("two-step-user");
    const response = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { ok: boolean; data?: Array<{ username: string; password: string }> };
    expect(response).toMatchObject({ ok: true });
    expect(response.data).toEqual([expect.objectContaining({ username: "two-step-user", password: "two-step-secret" })]);
  } finally {
    await context?.close();
  }
});

test("navigation carries username to the next password page", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "nav-user");
    context = launched.context;
    await context.route("https://navigation-steps.example.test/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/username") return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><title>Username step</title><form><input id="username" autocomplete="username"><button type="button">Continue</button></form><script>
          document.querySelector('button').addEventListener('click', () => setTimeout(() => location.href='/password', 30));
        </script>`
      });
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><title>Password step</title><form><input id="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button></form><script>
          document.querySelector('form').addEventListener('submit', event => event.preventDefault());
        </script>`
      });
    });
    const page = await context.newPage();
    await page.goto("https://navigation-steps.example.test/username");
    await page.locator("#username").fill("navigation-user");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL("**/password");
    await page.locator("#password").fill("navigation-secret");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator("#monica-save-prompt-host")).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe("monica-save-prompt-host");
    await page.keyboard.press("Enter");
    await expect.poll(async () => {
      const response = await launched.manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" })) as { data?: Array<{ username: string }> };
      return response.data?.[0]?.username;
    }).toBe("navigation-user");
  } finally {
    await context?.close();
  }
});
