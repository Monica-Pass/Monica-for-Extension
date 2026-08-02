import { chromium, expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

interface ListedLogin {
  id: string;
  kind: string;
  username: string;
  password: string;
}

async function launchExtension(testInfo: TestInfo, profileName: string, viewport = { width: 1280, height: 720 }): Promise<{ context: BrowserContext; manager: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath(profileName), {
    channel: "chromium",
    headless: true,
    viewport,
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

async function confirmSavePrompt(page: Page): Promise<void> {
  const prompt = page.locator("#monica-save-prompt-host");
  await expect(prompt).toHaveCount(1, { timeout: 15_000 });
  expect(await prompt.evaluate((host) => host.shadowRoot)).toBeNull();
  await expect.poll(() => prompt.evaluate((host) => document.activeElement === host)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveCount(0, { timeout: 20_000 });
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
    await confirmSavePrompt(page);

    await expect.poll(async () => (await listItems(launched.manager)).length).toBe(1);
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
    await confirmSavePrompt(page);

    await expect.poll(async () => (await listItems(launched.manager)).find((item) => item.id === existing.id)?.password).toBe("replacement-secret");
    const items = await listItems(launched.manager);
    expect(items).toEqual([expect.objectContaining({ id: existing.id, password: "replacement-secret" })]);
    expect(items[0].password).not.toBe("old-secret");
  } finally {
    await context?.close();
  }
});

test("save prompt requires choosing among same-username accounts", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "save-choice");
    context = launched.context;
    const now = new Date().toISOString();
    for (const item of [
      { id: "first-same-user", kind: "login", title: "First account", favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], username: "joy@example.com", password: "first-old", uris: ["https://save.example.test"], customFields: [] },
      { id: "second-same-user", kind: "login", title: "Second account", favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], username: "joy@example.com", password: "second-old", uris: ["https://save.example.test"], customFields: [] }
    ]) expect(await launched.manager.evaluate(async (value) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: value }), item)).toMatchObject({ ok: true });
    await routeLoginPage(context);
    const page = await context.newPage();
    await page.goto("https://save.example.test/login");
    await page.locator("#username").fill("joy@example.com");
    await page.locator("#password").fill("chosen-replacement");
    await triggerLogin(page);
    const prompt = page.locator("#monica-save-prompt-host");
    await expect(prompt).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => prompt.evaluate((host) => document.activeElement === host)).toBe(true);
    await page.keyboard.press("End");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");

    await expect.poll(async () => (await listItems(launched.manager)).find((item) => item.id === "second-same-user")?.password).toBe("chosen-replacement");
    const items = await listItems(launched.manager);
    expect(items.find((item) => item.id === "first-same-user")?.password).toBe("first-old");
    expect(items.find((item) => item.id === "second-same-user")?.password).toBe("chosen-replacement");
  } finally {
    await context?.close();
  }
});

test("save prompt fits 375px at 200 percent text", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "save-zoom", { width: 375, height: 667 });
    context = launched.context;
    await context.route("https://zoom-save.example.test/**", (route) => route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html style="font-size:200%"><title>A very long account title for responsive prompt verification</title><form>
        <input id="username" autocomplete="username"><input id="password" type="password" autocomplete="current-password"><button type="submit">Sign in</button>
      </form><script>document.querySelector('form').addEventListener('submit', event => event.preventDefault())</script></html>`
    }));
    const page = await context.newPage();
    await page.goto("https://zoom-save.example.test/login");
    await page.locator("#username").fill("a-very-long-username-for-responsive-testing@example.test");
    await page.locator("#password").fill("zoom-secret");
    await page.getByRole("button", { name: "Sign in" }).click();
    const prompt = page.locator("#monica-save-prompt-host");
    await expect(prompt).toHaveCount(1);
    const cdp = await context.newCDPSession(page);
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const documentTree = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }) as { root: Record<string, any> };
    const nodes = flattenDomNodes(documentTree.root);
    const card = nodes.find((node) => node.nodeName === "SECTION" && attribute(node, "class")?.split(/\s+/).includes("card"));
    const title = nodes.find((node) => node.nodeName === "STRONG" && attribute(node, "class")?.split(/\s+/).includes("title"));
    expect(card?.nodeId).toEqual(expect.any(Number));
    expect(title?.nodeId).toEqual(expect.any(Number));
    const box = await cdp.send("DOM.getBoxModel", { nodeId: card!.nodeId }) as { model: { border: number[] } };
    const xs = box.model.border.filter((_, index) => index % 2 === 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(375);
    const computed = await cdp.send("CSS.getComputedStyleForNode", { nodeId: title!.nodeId }) as { computedStyle: Array<{ name: string; value: string }> };
    const titleFontSize = Number.parseFloat(computed.computedStyle.find((property) => property.name === "font-size")?.value || "0");
    expect(titleFontSize).toBeGreaterThanOrEqual(30);
    await expect.poll(() => prompt.evaluate((host) => document.activeElement === host)).toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await listItems(launched.manager)).length).toBe(1);
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
    await expect(prompt).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(prompt).toHaveCount(0);
    expect(await listItems(launched.manager)).toEqual([]);
  } finally {
    await context?.close();
  }
});

function flattenDomNodes(root: Record<string, any>): Array<Record<string, any>> {
  const result: Array<Record<string, any>> = [];
  const visit = (node: Record<string, any> | undefined) => {
    if (!node) return;
    result.push(node);
    for (const child of node.children || []) visit(child);
    for (const shadow of node.shadowRoots || []) visit(shadow);
    visit(node.contentDocument);
  };
  visit(root);
  return result;
}

function attribute(node: Record<string, any>, name: string): string | undefined {
  const attributes = node.attributes as string[] | undefined;
  if (!attributes) return undefined;
  const index = attributes.indexOf(name);
  return index >= 0 ? attributes[index + 1] : undefined;
}
