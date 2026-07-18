import { chromium, expect, test, type BrowserContext, type Locator } from "@playwright/test";
import path from "node:path";

test("auth card omits the decorative avatar", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("auth-polish-profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    await expect(page.locator(".login-card h1")).toHaveText("创建加密密码库");
    await expect(page.locator(".avatar-icon")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("auth-card.png"), fullPage: true });
  } finally { await context?.close(); }
});

test("provider page is compact and decorated icon glyphs are centered", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("provider-polish-profile"), { channel: "chromium", headless: true, colorScheme: "dark", viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "visual polish master password" }))).toMatchObject({ ok: true });
    await page.reload();

    await page.getByRole("button", { name: "密码源" }).click();
    await expect(page.locator(".provider-connect-grid .connect-source")).toHaveCount(2);
    await expect(page.locator(".provider-config-card")).toHaveCount(0);
    await expect(page.locator(".provider-list .source-card")).toHaveCount(1);
    expect((await page.locator(".provider-page").boundingBox())!.width).toBeLessThanOrEqual(820);
    await expectCentered(page.locator(".source-icon").first(), page.locator(".source-icon m3e-icon").first());
    await expectCentered(page.locator(".connect-icon").first(), page.locator(".connect-icon m3e-icon").first());
    await expectRoundedAndClipped(page.locator(".connect-source-card").first());
    await expectRoundedAndClipped(page.locator(".provider-list .source-card").first());
    await expectAllRoundedAndClipped(page.locator("main m3e-card"));
    await expect(page.locator("m3e-card m3e-card")).toHaveCount(0);
    const connectionShape = await page.locator(".connect-source-card").first().evaluate((host) => ({
      host: getComputedStyle(host).borderRadius,
      button: getComputedStyle(host.querySelector(".connect-source")!).borderRadius
    }));
    expect(connectionShape.button).toBe(connectionShape.host);
    await page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).hover();

    await page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).click();
    const dialog = page.getByRole("dialog", { name: "连接 Monica Android WebDAV" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(page.getByLabel("WebDAV 地址 *")).toBeVisible();
    await page.getByRole("button", { name: "关闭 WebDAV 设置" }).click();
    await expect(page.getByRole("dialog", { name: "连接 Monica Android WebDAV" })).toHaveCount(0);

    await page.getByRole("button", { name: "概览" }).click();
    await expectCentered(page.locator(".feature-icon"), page.locator(".feature-icon m3e-icon"));
    await expectAllRoundedAndClipped(page.locator("main m3e-card"));
    await page.getByRole("button", { name: "设置与备份" }).click();
    await expectAllRoundedAndClipped(page.locator("main m3e-card"));
    await page.getByRole("button", { name: "密码源" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).hover();
    await page.screenshot({ path: testInfo.outputPath("provider-page.png"), fullPage: true });
  } finally { await context?.close(); }
});

for (const width of [375, 768, 1280, 1440]) {
  test(`manager has no horizontal overflow at ${width}px`, async ({}, testInfo) => {
    const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(testInfo.outputPath(`viewport-${width}-profile`), { channel: "chromium", headless: true, viewport: { width, height: 900 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
      const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
      expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "viewport polish password" }))).toMatchObject({ ok: true });
      await page.reload();
      await expectNoHorizontalOverflow(page.locator("html"));
      if (width <= 900) await page.getByRole("button", { name: "打开导航" }).click();
      await page.getByRole("button", { name: "密码源" }).click();
      await expectNoHorizontalOverflow(page.locator("html"));
    } finally { await context?.close(); }
  });
}

test("login table actions remain fully visible at a 1280px store viewport", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("table-polish-profile"), { channel: "chromium", headless: true, viewport: { width: 1280, height: 800 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    const createdAt = "2026-01-01T00:00:00.000Z";
    expect(await page.evaluate(async (createdAt) => {
      const setup = await chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "table polish master password" });
      if (!setup.ok) return setup;
      return chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: { id: "table-login", kind: "login", title: "示例工作账号", username: "demo@example.test", password: "not-a-real-password", uris: ["https://shop-demo.example.test"], customFields: [], favorite: false, notes: "", createdAt, updatedAt: createdAt, providerRefs: [] } });
    }, createdAt)).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole("button", { name: /^登录项/ }).click();
    const tableWrap = page.locator(".table-wrap");
    await expect(tableWrap).toBeVisible();
    const tableLayout = await tableWrap.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, tableWidth: element.querySelector("table")?.getBoundingClientRect().width }));
    expect(tableLayout.scrollWidth, JSON.stringify(tableLayout)).toBeLessThanOrEqual(tableLayout.clientWidth);
    const finalAction = page.getByRole("button", { name: "删除登录项" });
    const bounds = await finalAction.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280);
    await expect(page.locator(".sidebar-brand small")).toHaveCSS("display", "block");
  } finally { await context?.close(); }
});

async function expectCentered(container: Locator, glyph: Locator): Promise<void> {
  const label = await container.evaluate((element) => `${element.tagName.toLowerCase()}.${element.className}`);
  const glyphElement = await glyph.elementHandle();
  expect(glyphElement).not.toBeNull();
  const { outerCenter, innerCenter } = await container.evaluate((outer, inner) => {
    const outerBox = outer.getBoundingClientRect();
    const innerBox = (inner as Element).getBoundingClientRect();
    return {
      outerCenter: { x: outerBox.x + outerBox.width / 2, y: outerBox.y + outerBox.height / 2 },
      innerCenter: { x: innerBox.x + innerBox.width / 2, y: innerBox.y + innerBox.height / 2 }
    };
  }, glyphElement);
  expect(Math.abs(outerCenter.x - innerCenter.x), `${label} horizontal center`).toBeLessThanOrEqual(1);
  expect(Math.abs(outerCenter.y - innerCenter.y), `${label} vertical center`).toBeLessThanOrEqual(1);
}

async function expectRoundedAndClipped(card: Locator): Promise<void> {
  const styles = await card.evaluate((host) => {
    const base = host.shadowRoot?.querySelector<HTMLElement>(".base");
    return {
      hostRadius: getComputedStyle(host).borderRadius,
      baseRadius: base ? getComputedStyle(base).borderRadius : "missing",
      overflow: getComputedStyle(host).overflow
    };
  });
  expect(styles.hostRadius).toBe("8px");
  expect(styles.hostRadius).toBe(styles.baseRadius);
  expect(["hidden", "clip"]).toContain(styles.overflow);
}

async function expectNoHorizontalOverflow(root: Locator): Promise<void> {
  const dimensions = await root.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(dimensions.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectAllRoundedAndClipped(cards: Locator): Promise<void> {
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) await expectRoundedAndClipped(cards.nth(index));
}
