import { chromium, expect, test, type BrowserContext, type Locator } from "@playwright/test";
import path from "node:path";
import { installMdbx2TigaMock } from "./fixtures/mdbx2";

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
    const connectionButtons = page.locator(".provider-connect-grid .connect-source");
    await expect(connectionButtons).toHaveCount(4);
    await expect(page.locator(".provider-config-card")).toHaveCount(0);
    await expect(page.locator(".provider-list .source-card")).toHaveCount(1);
    expect((await page.locator(".provider-page").boundingBox())!.width).toBeLessThanOrEqual(820);
    const connectionBoxes = await Promise.all(Array.from({ length: 4 }, (_, index) => connectionButtons.nth(index).boundingBox()));
    for (const box of connectionBoxes.slice(1)) expect(Math.abs(connectionBoxes[0]!.width - box!.width)).toBeLessThanOrEqual(1);
    await expectCentered(page.locator(".source-icon").first(), page.locator(".source-icon m3e-icon").first());
    await expectCentered(page.locator(".connect-icon").first(), page.locator(".connect-icon m3e-icon").first());
    await expectCentered(page.locator(".connect-icon").nth(1), page.locator(".connect-icon m3e-icon").nth(1));
    await expectRoundedAndClipped(page.locator(".connect-source-card").first());
    await expectRoundedAndClipped(page.locator(".provider-list .source-card").first());
    await expectAllRoundedAndClipped(page.locator("main m3e-card"));
    await expect(page.locator("m3e-card m3e-card")).toHaveCount(0);
    const connectionShape = await page.locator(".connect-source-card").first().evaluate((host) => ({
      host: getComputedStyle(host).borderRadius,
      button: getComputedStyle(host.querySelector(".connect-source")!).borderRadius
    }));
    expect(connectionShape.button).toBe(connectionShape.host);

    await page.getByRole("button", { name: /连接 MDBX2 保险库/ }).click();
    const mdbx2Dialog = page.getByRole("dialog", { name: "打开 MDBX2 保险库" });
    await expect(mdbx2Dialog).toBeVisible();
    await expect(mdbx2Dialog).toHaveCSS("border-radius", "16px");
    await expect(mdbx2Dialog.getByLabel("MDBX2 可移植备份")).toBeVisible();
    await mdbx2Dialog.getByRole("button", { name: "从 WebDAV 加入" }).click();
    const remoteMdbx2Dialog = page.getByRole("dialog", { name: "从 WebDAV 加入 MDBX2" });
    await expect(remoteMdbx2Dialog).toBeVisible();
    await expect(remoteMdbx2Dialog.getByLabel("Android 兼容远端位置 *")).toBeVisible();
    await expect(remoteMdbx2Dialog.getByText("日常同步对象自动写入同名", { exact: false })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mdbx2-dialog.png"), fullPage: true });
    await remoteMdbx2Dialog.getByRole("button", { name: "关闭 MDBX2 设置" }).click();
    await expect(page.getByRole("dialog", { name: /MDBX2/ })).toHaveCount(0);

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

test("manager sections remain readable with 200% text", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("manager-large-text-profile"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 1280, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    const createdAt = "2026-01-01T00:00:00.000Z";
    const setup = await page.evaluate(async (createdAt) => {
      const created = await chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "large text visual password" });
      if (!created.ok) return created;
      const first = await chrome.runtime.sendMessage({
        type: "VAULT_UPSERT_ITEM",
        item: {
          id: "large-text-login",
          kind: "login",
          title: "非常长的示例工作账号名称用于检查显示",
          username: "demo-long-user@example.test",
          password: "not-a-real-password",
          uris: ["https://very-long-example-domain.example.test/login"],
          customFields: [],
          favorite: false,
          notes: "",
          createdAt,
          updatedAt: createdAt,
          providerRefs: []
        }
      });
      if (!first.ok) return first;
      return chrome.runtime.sendMessage({
        type: "VAULT_UPSERT_ITEM",
        item: {
          id: "large-text-login-two",
          kind: "login",
          title: "第二个紧凑列表账号",
          username: "second-user@example.test",
          password: "not-a-real-password",
          uris: ["https://accounts.example.test/sign-in"],
          customFields: [],
          favorite: true,
          notes: "",
          createdAt,
          updatedAt: createdAt,
          providerRefs: []
        }
      });
    }, createdAt);
    expect(setup, JSON.stringify(setup)).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole("button", { name: "概览" }).waitFor();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });

    const drawerWidth = (await page.locator(".sidebar").boundingBox())?.width || 0;
    expect(drawerWidth).toBeGreaterThanOrEqual(350);
    expect(drawerWidth).toBeLessThanOrEqual(361);
    const walletNavLabel = page.getByRole("button", { name: /^钱包与身份/ }).locator(":scope > span").first();
    const walletLabelWidth = await walletNavLabel.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(walletLabelWidth.scroll, JSON.stringify(walletLabelWidth)).toBeLessThanOrEqual(walletLabelWidth.client + 1);

    const metricBoxes = await Promise.all([0, 1, 2].map((index) => page.locator(".metrics > m3e-card").nth(index).boundingBox()));
    expect(metricBoxes.every(Boolean)).toBe(true);
    expect(Math.abs(metricBoxes[0]!.y - metricBoxes[1]!.y)).toBeLessThanOrEqual(1);
    expect(metricBoxes[2]!.y).toBeGreaterThan(metricBoxes[0]!.y + metricBoxes[0]!.height);

    const sections = ["概览", "登录项", "钱包与身份", "安全笔记", "动态验证码", "Steam", "Passkey", "安全发送", "归档", "回收站", "密码源", "设置与备份", "生成器"];
    for (const section of sections) {
      await page.getByRole("button", { name: new RegExp(`^${section}`) }).first().click();
      await expectNoHorizontalOverflow(page.locator("html"));
      await expectVisibleIconsFit(page.locator("#root"));
      await expectVisibleButtonLabelsFit(page.locator("#root"));
    }

    await page.getByRole("button", { name: /^登录项/ }).click();
    const loginCard = page.locator(".login-data-card");
    await expect(loginCard.locator("thead")).toHaveCSS("display", "none");
    const rows = loginCard.locator("tbody tr");
    await expect(rows).toHaveCount(2);
    const longRow = rows.filter({ hasText: "非常长的示例工作账号名称用于检查显示" });
    await expect(longRow.locator(".credential-compact-summary")).toHaveText("demo-long-user@example.test · very-long-example-domain.example.test");
    const firstRow = (await rows.first().boundingBox())!;
    const secondRow = (await rows.nth(1).boundingBox())!;
    const firstRowLayout = await rows.first().evaluate((row) => ({
      rowDisplay: getComputedStyle(row).display,
      rowGrid: getComputedStyle(row).gridTemplateColumns,
      cells: [...row.children].map((cell) => {
        const rect = cell.getBoundingClientRect();
        const style = getComputedStyle(cell);
        return { className: cell.className, display: style.display, width: rect.width, height: rect.height, padding: style.padding };
      })
    }));
    expect(firstRow.height, JSON.stringify(firstRowLayout, null, 2)).toBeLessThanOrEqual(128);
    expect(secondRow.y - (firstRow.y + firstRow.height)).toBeLessThanOrEqual(10);
    const details = await longRow.locator(".credential-detail-cell").evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).display));
    expect(details).toEqual(["none", "none", "none"]);
    const actions = (await rows.first().locator(".action-cell").boundingBox())!;
    expect(actions.y).toBeGreaterThanOrEqual(firstRow.y - 1);
    expect(actions.y + actions.height).toBeLessThanOrEqual(firstRow.y + firstRow.height + 1);
    await expectNoHorizontalOverflow(loginCard);
    await page.screenshot({ path: testInfo.outputPath("manager-large-text-login.png"), animations: "disabled" });

    await page.getByRole("button", { name: "密码源" }).click();
    const sourceCards = page.locator(".provider-connect-grid .connect-source-card");
    const firstSource = await sourceCards.nth(0).boundingBox();
    const secondSource = await sourceCards.nth(1).boundingBox();
    expect(secondSource!.y).toBeGreaterThan(firstSource!.y + firstSource!.height);
    await page.screenshot({ path: testInfo.outputPath("manager-large-text-providers.png"), animations: "disabled" });

    await page.getByRole("button", { name: "设置与备份" }).click();
    const selectedPalette = page.locator(".palette-button.selected");
    const paletteWidth = await selectedPalette.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(paletteWidth.scroll, JSON.stringify(paletteWidth)).toBeLessThanOrEqual(paletteWidth.client + 1);
  } finally { await context?.close(); }
});

test("manager keeps wheel scrolling without native scrollbar gutters or horizontal jitter", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("manager-scrollbar-profile"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 1100, height: 720 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "scrollbar polish password" }))).toMatchObject({ ok: true });
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "密码源" }).click();

    const initial = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>(".sidebar nav")!;
      const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
      return {
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentScrollbarWidth: getComputedStyle(document.documentElement).scrollbarWidth,
        documentWebkitScrollbarWidth: getComputedStyle(document.documentElement, "::-webkit-scrollbar").width,
        documentWebkitScrollbarHeight: getComputedStyle(document.documentElement, "::-webkit-scrollbar").height,
        navScrollbarWidth: getComputedStyle(nav).scrollbarWidth,
        navWebkitScrollbarWidth: getComputedStyle(nav, "::-webkit-scrollbar").width,
        navScrollbarGutter: getComputedStyle(nav).scrollbarGutter,
        navClientHeight: nav.clientHeight,
        navScrollHeight: nav.scrollHeight,
        navClientWidth: nav.clientWidth,
        sidebarWidth: sidebar.getBoundingClientRect().width
      };
    });
    expect(initial.documentScrollWidth).toBeLessThanOrEqual(initial.documentClientWidth + 1);
    expect(initial.documentScrollbarWidth).toBe("none");
    expect(initial.documentWebkitScrollbarWidth).toBe("0px");
    expect(initial.documentWebkitScrollbarHeight).toBe("0px");
    expect(initial.navScrollbarWidth).toBe("none");
    expect(initial.navWebkitScrollbarWidth).toBe("0px");
    expect(initial.navScrollbarGutter).toBe("auto");
    expect(initial.navScrollHeight).toBeGreaterThan(initial.navClientHeight);

    await page.mouse.move(900, 500);
    await page.mouse.wheel(0, 900);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    const nav = page.locator(".sidebar nav");
    await nav.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(() => nav.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    const finalLayout = await page.evaluate(() => {
      const nav = document.querySelector<HTMLElement>(".sidebar nav")!;
      const sidebar = document.querySelector<HTMLElement>(".sidebar")!;
      return {
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        navClientWidth: nav.clientWidth,
        sidebarWidth: sidebar.getBoundingClientRect().width
      };
    });
    expect(finalLayout.documentScrollWidth).toBeLessThanOrEqual(finalLayout.documentClientWidth + 1);
    expect(finalLayout.navClientWidth).toBe(initial.navClientWidth);
    expect(finalLayout.sidebarWidth).toBe(initial.sidebarWidth);
    await page.screenshot({ path: testInfo.outputPath("manager-hidden-scrollbars.png"), animations: "disabled" });
  } finally { await context?.close(); }
});

test("mobile manager actions remain complete with 200% text", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("m"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 1000 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    const setup = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mobile large text password" }));
    expect(setup, JSON.stringify(setup)).toMatchObject({ ok: true });
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });

    const sections = ["概览", "登录项", "钱包与身份", "安全笔记", "动态验证码", "Steam", "Passkey", "安全发送", "归档", "回收站", "密码源", "设置与备份", "生成器"];
    const clipped: Array<{ section: string; text: string; clientWidth: number; scrollWidth: number }> = [];
    const overflow: Array<{ section: string; selector: string; text: string; left: number; right: number; width: number; scrollWidth: number }> = [];
    const scrollOffsets: Array<{ section: string; scrollX: number; scrollY: number }> = [];
    for (const section of sections) {
      await page.getByRole("button", { name: "打开导航" }).click();
      await page.getByRole("button", { name: new RegExp(`^${section}`) }).first().click();
      const offset = await page.evaluate(() => ({ scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) }));
      if (offset.scrollX || offset.scrollY) scrollOffsets.push({ section, ...offset });
      clipped.push(...(await visibleButtonLabelIssues(page.locator("#root"))).map((issue) => ({ section, ...issue })));
      overflow.push(...(await visibleHorizontalOverflowIssues(page.locator("#root"))).map((issue) => ({ section, ...issue })));
      await expectVisibleIconsFit(page.locator("#root"));
      if (["Steam", "安全发送", "密码源", "设置与备份"].includes(section)) {
        await page.screenshot({ path: testInfo.outputPath(`mobile-large-text-${section}.png`), animations: "disabled" });
      }
    }
    expect({ clipped, overflow, scrollOffsets }, JSON.stringify({ clipped, overflow, scrollOffsets })).toEqual({ clipped: [], overflow: [], scrollOffsets: [] });
  } finally { await context?.close(); }
});

test("mobile manager dialogs remain complete with 200% text", async ({}, testInfo) => {
  test.slow();
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("d"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 1000 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    const setup = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "dialog mobile large text password" }));
    expect(setup, JSON.stringify(setup)).toMatchObject({ ok: true });
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });

    const clipped: Array<{ surface: string; text: string; clientWidth: number; scrollWidth: number }> = [];
    const overflow: Array<{ surface: string; selector: string; text: string; left: number; right: number; width: number; scrollWidth: number }> = [];
    const audit = async (surface: string, root: Locator) => {
      clipped.push(...(await visibleButtonLabelIssues(root)).map((issue) => ({ surface, ...issue })));
      overflow.push(...(await visibleHorizontalOverflowIssues(root)).map((issue) => ({ surface, ...issue })));
      await expectVisibleIconsFit(root);
    };
    const openSection = async (name: string) => {
      await page.getByRole("button", { name: "打开导航" }).click();
      await page.getByRole("button", { name: new RegExp(`^${name}`) }).first().click();
    };

    await openSection("密码源");
    await page.getByRole("button", { name: /连接 MDBX2 保险库/ }).click();
    let dialog = page.getByRole("dialog", { name: "打开 MDBX2 保险库" });
    await audit("MDBX2 本机", dialog);
    await dialog.getByRole("button", { name: "从 WebDAV 加入" }).click();
    dialog = page.getByRole("dialog", { name: "从 WebDAV 加入 MDBX2" });
    await audit("MDBX2 WebDAV", dialog);
    await dialog.getByRole("button", { name: "关闭 MDBX2 设置" }).click();

    await page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).click();
    dialog = page.getByRole("dialog", { name: "连接 Monica Android WebDAV" });
    await audit("Android WebDAV", dialog);
    await dialog.getByRole("button", { name: "关闭 WebDAV 设置" }).click();

    await page.getByRole("button", { name: /连接 KeePass/ }).click();
    dialog = page.getByRole("dialog", { name: /KeePass/ });
    await audit("KeePass", dialog);
    await dialog.getByRole("button", { name: "关闭 KeePass 设置" }).click();

    await page.getByRole("button", { name: /连接 Bitwarden/ }).click();
    dialog = page.getByRole("dialog", { name: "连接 Bitwarden" });
    await audit("Bitwarden", dialog);
    await dialog.getByRole("button", { name: "关闭" }).click();

    await openSection("登录项");
    await page.getByRole("button", { name: "添加登录项" }).first().click();
    dialog = page.getByRole("dialog", { name: "添加登录项" });
    await audit("登录项", dialog);
    await dialog.getByRole("button", { name: "关闭" }).click();

    for (const [section, action, dialogName, surface] of [["钱包与身份", "添加钱包项目", "添加银行卡", "钱包"], ["安全笔记", "添加安全笔记", "添加安全笔记", "笔记"], ["动态验证码", "添加验证码", "添加动态验证码", "验证码"]] as const) {
      await openSection(section);
      await page.getByRole("button", { name: action }).first().click();
      dialog = page.getByRole("dialog", { name: dialogName });
      await audit(surface, dialog);
      await dialog.getByRole("button", { name: "关闭" }).click();
    }

    await openSection("设置与备份");
    await page.getByRole("button", { name: "导出加密整库备份" }).click();
    dialog = page.getByRole("dialog", { name: "导出加密整库备份" });
    await audit("备份", dialog);

    expect({ clipped, overflow }, JSON.stringify({ clipped, overflow })).toEqual({ clipped: [], overflow: [] });
  } finally { await context?.close(); }
});

test("manager dialogs use one-column large-text forms", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("dialog-large-text-profile"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 800, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "dialog large text password" }))).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole("button", { name: "打开导航" }).waitFor();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });

    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).click();
    const webDavDialog = page.getByRole("dialog", { name: "连接 Monica Android WebDAV" });
    await expect(webDavDialog).toBeVisible();
    await expectDirectChildrenSeparated(webDavDialog.locator(".provider-form"));
    const displayName = await webDavDialog.getByLabel("显示名称").boundingBox();
    const webDavAddress = await webDavDialog.getByLabel("WebDAV 地址 *").boundingBox();
    expect(webDavAddress!.y).toBeGreaterThan(displayName!.y + displayName!.height);
    await expectNoHorizontalOverflow(webDavDialog);
    await webDavDialog.getByRole("button", { name: "关闭 WebDAV 设置" }).click();

    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: /^登录项/ }).click();
    await page.getByRole("button", { name: "添加登录项" }).first().click();
    const editor = page.getByRole("dialog", { name: "添加登录项" });
    await expect(editor).toBeVisible();
    await expectDirectChildrenSeparated(editor.locator(".login-item-form"));
    const loginTypes = editor.locator(".login-type-segments label");
    const firstType = await loginTypes.nth(0).boundingBox();
    const fourthType = await loginTypes.nth(3).boundingBox();
    expect(fourthType!.y).toBeGreaterThan(firstType!.y + firstType!.height);
    await expectVisibleIconsFit(editor);
    await expectNoHorizontalOverflow(editor);
    await page.screenshot({ path: testInfo.outputPath("manager-large-text-editor.png"), animations: "disabled" });
  } finally { await context?.close(); }
});

test("MDBX2 WebDAV join dialog keeps large-text controls separated at 800px", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("join-profile"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      deviceScaleFactor: 1.5,
      viewport: { width: 800, height: 900 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    const setup = await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 webdav visual password" }));
    expect(setup, JSON.stringify(setup)).toMatchObject({ ok: true });
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const navigationButton = page.getByRole("button", { name: "打开导航" });
    if (await navigationButton.isVisible()) await navigationButton.click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: /连接 MDBX2 保险库/ }).click();
    await page.getByRole("dialog", { name: "打开 MDBX2 保险库" }).getByRole("button", { name: "从 WebDAV 加入" }).evaluate((button) => (button as HTMLButtonElement).click());

    const dialog = page.getByRole("dialog", { name: "从 WebDAV 加入 MDBX2" });
    await expect(dialog).toBeVisible();
    const modeButtons = dialog.locator(".mdbx2-mode-picker button");
    const firstMode = await modeButtons.nth(0).boundingBox();
    const secondMode = await modeButtons.nth(1).boundingBox();
    expect(firstMode).not.toBeNull();
    expect(secondMode).not.toBeNull();
    expect(secondMode!.y, "large-text join modes should use separate rows").toBeGreaterThan(firstMode!.y + firstMode!.height);
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-webdav-join-large-text.png") });
    const form = dialog.locator(".mdbx2-form");
    await expectDirectChildrenSeparated(form);
    await form.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(dialog.getByRole("button", { name: "取消" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "下载并加入" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mdbx2-webdav-join-large-text-bottom.png") });
  } finally { await context?.close(); }
});

test("MDBX2 conflict manager is flat explicit and usable at 375px with large text", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-conflict-polish-profile"), { channel: "chromium", headless: true, colorScheme: "dark", viewport: { width: 375, height: 900 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 conflict visual password" }))).toMatchObject({ ok: true });
    await installMdbx2TigaMock(page);
    await page.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      let conflictResolved = false;
      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: { type?: string; choice?: "local-wins" | "incoming-wins" }) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, { id: "mdbx2-conflict-demo", kind: "mdbx2", name: "冲突演示库", enabled: true, isDefaultSaveTarget: false, config: { remotePath: "Monica/MDBX2/demo.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true } }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "974c517465e7b6cac0947d2d59875aa4211fa16b" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "11111111-1111-4111-8111-111111111111", open: true, available: true } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") return { ok: true, data: {
            checkedAtUnixSeconds: 1785648000, fileSizeBytes: 4096, formatVersion: "MDBX-2", schemaVersion: 17,
            health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
            diagnostics: { commitCount: 1, tombstoneCount: 0, branchCount: 1, deviceCount: 2, snapshotCount: 0, unresolvedConflictCount: conflictResolved ? 0 : 1, projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: 1, deletedEntryCount: 0, attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0 }
          } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: conflictResolved, pendingBootstrap: false, pendingSegment: false, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 3 } };
          if (message.type === "MDBX2_CONFLICT_LIST") return { ok: true, data: { items: conflictResolved ? [] : [{ conflictId: "22222222-2222-4222-8222-222222222222", objectType: "entry", objectId: "33333333-3333-4333-8333-333333333333", displayTitle: "工作账号", contentType: "login", conflictingFields: ["title_ct", "payload", "project_id"], createdAt: "2026-08-02T00:00:00Z" }] } };
          if (message.type === "MDBX2_CONFLICT_RESOLVE") {
            conflictResolved = true;
            return { ok: true, data: { resolved: true, alreadyResolved: false, conflictId: "22222222-2222-4222-8222-222222222222", objectType: "entry", objectId: "33333333-3333-4333-8333-333333333333", choice: message.choice, resolvedAt: "2026-08-02T00:01:00Z" } };
          }
          return originalSend(message);
        }
      });
    });
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: "管理 MDBX2" }).click();

    const dialog = page.getByRole("dialog", { name: "管理 冲突演示库" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /工作账号/ })).toBeVisible();
    await expect(dialog).not.toContainText("22222222-2222-4222-8222-222222222222");
    await expect(dialog).not.toContainText("33333333-3333-4333-8333-333333333333");
    const panel = dialog.locator(".mdbx2-conflict-panel");
    await expect(panel).toHaveCSS("border-radius", "8px");
    await expect(panel).toHaveCSS("background-image", "none");
    await expectCentered(dialog.locator(".mdbx2-conflict-icon"), dialog.locator(".mdbx2-conflict-icon m3e-icon"));
    const closeButton = dialog.getByRole("button", { name: "关闭 MDBX2 设置" });
    const closeIcon = closeButton.locator("m3e-icon");
    await expect(closeButton).toHaveCSS("width", "44px");
    await expect(closeButton).toHaveCSS("height", "44px");
    await expect(closeIcon).toHaveCSS("font-size", "20px");
    await expectCentered(closeButton, closeIcon);

    const conflictRow = dialog.getByRole("button", { name: /工作账号/ });
    await conflictRow.scrollIntoViewIfNeeded();
    await conflictRow.click();
    await expect(dialog.getByText("标题", { exact: true })).toBeVisible();
    await expect(dialog.getByText("内容", { exact: true })).toBeVisible();
    await expect(dialog.getByText("位置", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "采用传入版本" }).click();
    const confirm = dialog.getByRole("button", { name: "确认采用传入版本" });
    await expect(confirm).toBeFocused();
    await expect(dialog.getByText("当前浏览器中的并发修改会被替换", { exact: false })).toBeVisible();
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-conflict-manager.png"), fullPage: true });
    await confirm.click();
    await expect(dialog.getByText("没有待处理的同步冲突。")).toBeVisible();
  } finally { await context?.close(); }
});

test("MDBX2 snapshot manager is flat bounded and usable at 375px with large text", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-snapshot-polish-profile"), { channel: "chromium", headless: true, colorScheme: "dark", viewport: { width: 375, height: 1000 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 snapshot visual password" }))).toMatchObject({ ok: true });
    await installMdbx2TigaMock(page);
    await page.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      const goodSnapshotId = "22222222-2222-4222-8222-222222222222";
      const badSnapshotId = "33333333-3333-4333-8333-333333333333";
      let snapshots = [
        { snapshotId: goodSnapshotId, baseCommitId: "44444444-4444-4444-8444-444444444444", name: "发布前", kind: "manual", isFull: true, payloadBytes: 4096, createdAt: "2026-08-02T00:00:00Z", createdByDeviceId: "device-a", autoPrune: false, integrityOk: true },
        { snapshotId: badSnapshotId, baseCommitId: "55555555-5555-4555-8555-555555555555", name: "每日保留点", kind: "automatic", isFull: true, payloadBytes: 8192, createdAt: "2026-08-01T00:00:00Z", createdByDeviceId: "device-b", autoPrune: true, integrityOk: false }
      ];
      let restoreAttempts = 0;
      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: { type?: string; operationId?: string; snapshotId?: string; side?: "current" | "snapshot"; name?: string }) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, { id: "mdbx2-snapshot-demo", kind: "mdbx2", name: "快照演示库", enabled: true, isDefaultSaveTarget: false, config: { remotePath: "Monica/MDBX2/demo.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true } }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "974c517465e7b6cac0947d2d59875aa4211fa16b" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "11111111-1111-4111-8111-111111111111", open: true, available: true } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") return { ok: true, data: {
            checkedAtUnixSeconds: 1785648000, fileSizeBytes: 4096, formatVersion: "MDBX-2", schemaVersion: 17,
            health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
            diagnostics: { commitCount: 1, tombstoneCount: 0, branchCount: 1, deviceCount: 2, snapshotCount: snapshots.length, unresolvedConflictCount: 0, projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: 0, deletedEntryCount: 0, attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0 }
          } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: false, pendingBootstrap: false, pendingSegment: false, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 3 } };
          if (message.type === "MDBX2_CONFLICT_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_COLLECTION_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_HISTORY_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_SNAPSHOT_LIST") return { ok: true, data: { items: snapshots } };
          if (message.type === "MDBX2_SNAPSHOT_STRUCTURE") {
            const current = message.side === "current";
            return { ok: true, data: {
              snapshotId: message.snapshotId,
              side: message.side,
              currentItemCount: 2,
              snapshotItemCount: 1,
              totalNodes: current ? 2 : 1,
              items: current
                ? [
                    { nodeId: "66666666-6666-4666-8666-666666666666", parentNodeId: null, name: "工作账号", nodeType: "entry", path: "登录/工作账号", status: "modified", childCount: 0 },
                    { nodeId: "77777777-7777-4777-8777-777777777777", parentNodeId: null, name: "新设备账号", nodeType: "entry", path: "登录/新设备账号", status: "added", childCount: 0 }
                  ]
                : [{ nodeId: "66666666-6666-4666-8666-666666666666", parentNodeId: null, name: "工作账号", nodeType: "entry", path: "登录/工作账号", status: "modified", childCount: 0 }]
            } };
          }
          if (message.type === "MDBX2_SNAPSHOT_CREATE") {
            const snapshotId = "88888888-8888-4888-8888-888888888888";
            snapshots = [{ snapshotId, baseCommitId: "99999999-9999-4999-8999-999999999999", name: message.name || "Snapshot 2026-08-02T01:00:00Z", kind: "manual", isFull: true, payloadBytes: 12288, createdAt: "2026-08-02T01:00:00Z", createdByDeviceId: "device-a", autoPrune: false, integrityOk: true }, ...snapshots];
            return { ok: true, data: { operationId: message.operationId, snapshotId, commitId: "99999999-9999-4999-8999-999999999999", alreadyCompleted: false } };
          }
          if (message.type === "MDBX2_SNAPSHOT_RESTORE") {
            restoreAttempts += 1;
            if (restoreAttempts === 1) return { ok: false, error: "无法证明恢复结果。", code: "snapshot-operation-state-unknown" };
            return { ok: true, data: { operationId: message.operationId, snapshotId: message.snapshotId, commitId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", affectedObjectCount: 2, alreadyCompleted: false } };
          }
          if (message.type === "MDBX2_SNAPSHOT_DELETE") {
            snapshots = snapshots.filter((item) => item.snapshotId !== message.snapshotId);
            return { ok: true, data: { operationId: message.operationId, snapshotId: message.snapshotId, commitId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", alreadyCompleted: false } };
          }
          return originalSend(message);
        }
      });
    });
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: "管理 MDBX2" }).click();

    const dialog = page.getByRole("dialog", { name: "管理 快照演示库" });
    const panel = dialog.locator(".mdbx2-snapshot-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("border-radius", "8px");
    await expect(panel).toHaveCSS("background-image", "none");
    await expect(dialog.getByText("发布前", { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText("22222222-2222-4222-8222-222222222222");
    await expect(dialog).not.toContainText("33333333-3333-4333-8333-333333333333");
    await expectCentered(dialog.locator(".mdbx2-snapshot-icon").first(), dialog.locator(".mdbx2-snapshot-icon m3e-icon").first());

    await dialog.getByLabel("快照名称（可留空）").fill("升级前");
    await dialog.getByRole("button", { name: "创建完整快照" }).click();
    await expect(dialog.getByText("升级前", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: /发布前/ }).click();
    await expect(dialog.getByText("工作账号", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "与现版本比较" }).click();
    await expect(dialog.getByText("新设备账号", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(dialog);

    await dialog.getByRole("button", { name: "恢复此快照", exact: true }).click();
    const restoreConfirm = dialog.getByRole("button", { name: "确认恢复此快照" });
    await expect(restoreConfirm).toBeFocused();
    await expect(dialog.getByText("当前保险库将恢复到此快照记录的完整状态", { exact: false })).toBeVisible();
    await restoreConfirm.click();
    await expect(dialog.getByText("不要立即重复恢复或删除", { exact: false })).toBeVisible();
    await panel.getByRole("button", { name: "刷新" }).click();
    await dialog.getByRole("button", { name: /发布前/ }).click();
    await dialog.getByRole("button", { name: "恢复此快照", exact: true }).click();
    await dialog.getByRole("button", { name: "确认恢复此快照" }).click();

    await dialog.getByRole("button", { name: /每日保留点/ }).click();
    await expect(dialog.getByText("完整性校验失败", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "恢复此快照", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "删除快照" }).click();
    const deleteConfirm = dialog.getByRole("button", { name: "确认永久删除快照" });
    await expect(deleteConfirm).toBeFocused();
    await expect(dialog.getByText("此快照及其加密内容将从本地保险库永久删除", { exact: false })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mdbx2-snapshot-manager.png"), fullPage: true });
    await deleteConfirm.click();
    await expect(dialog.getByText("每日保留点", { exact: true })).toHaveCount(0);
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

test("compact login list actions remain fully visible at a 1280px store viewport", async ({}, testInfo) => {
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
    await expect(page.locator(".login-data-card thead")).toHaveCSS("display", "none");
    const row = page.locator(".login-data-card tbody tr");
    await expect(row.locator(".credential-compact-summary")).toHaveText("demo@example.test · shop-demo.example.test");
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(84);
    expect(await row.locator(".credential-detail-cell").evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).display))).toEqual(["none", "none", "none"]);
    const tableLayout = await tableWrap.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, tableWidth: element.querySelector("table")?.getBoundingClientRect().width }));
    expect(tableLayout.scrollWidth, JSON.stringify(tableLayout)).toBeLessThanOrEqual(tableLayout.clientWidth);
    const finalAction = page.getByRole("button", { name: "删除登录项" });
    const bounds = await finalAction.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280);
    await expect(page.locator(".sidebar-brand small")).toHaveCSS("display", "block");
    await page.setViewportSize({ width: 375, height: 900 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const mobileRow = (await row.boundingBox())!;
    const mobileActions = (await row.locator(".action-cell").boundingBox())!;
    expect(mobileRow.height).toBeLessThanOrEqual(144);
    expect(mobileActions.x + mobileActions.width).toBeLessThanOrEqual(375);
    expect(mobileActions.y + mobileActions.height).toBeLessThanOrEqual(mobileRow.y + mobileRow.height + 1);
    await expectNoHorizontalOverflow(page.locator("html"));
    await row.locator(".action-cell").evaluate((cell) => {
      const buttons = [...cell.querySelectorAll("m3e-icon-button")];
      for (const button of buttons) cell.append(button.cloneNode(true));
    });
    await expect(row.locator(".action-cell m3e-icon-button")).toHaveCount(4);
    const fourActionRow = (await row.boundingBox())!;
    const fourActions = (await row.locator(".action-cell").boundingBox())!;
    expect(fourActionRow.height).toBeLessThanOrEqual(144);
    expect(fourActions.x + fourActions.width).toBeLessThanOrEqual(375);
    await expectNoHorizontalOverflow(page.locator("html"));
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
  expect(dimensions.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectDirectChildrenSeparated(root: Locator): Promise<void> {
  const geometry = await root.evaluate((element) => {
    const children = [...element.children].filter((child) => {
      const style = getComputedStyle(child);
      const rect = child.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    const items = children.map((child, index) => {
      const rect = child.getBoundingClientRect();
      const visibleDescendants = [child, ...child.querySelectorAll("*")].filter((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      });
      const paint = visibleDescendants.reduce((bounds, node) => {
        const box = node.getBoundingClientRect();
        return {
          left: Math.min(bounds.left, box.left),
          right: Math.max(bounds.right, box.right),
          top: Math.min(bounds.top, box.top),
          bottom: Math.max(bounds.bottom, box.bottom)
        };
      }, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      return { index, label: `${child.tagName.toLowerCase()}.${child.className}`, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, paint };
    });
    const overflow = items.filter((item) => item.paint.left < item.rect.left - 1 || item.paint.right > item.rect.right + 1 || item.paint.top < item.rect.top - 1 || item.paint.bottom > item.rect.bottom + 1);
    const overlaps = items.flatMap((item, index) => items.slice(index + 1).flatMap((candidate) => {
      const width = Math.min(item.paint.right, candidate.paint.right) - Math.max(item.paint.left, candidate.paint.left);
      const height = Math.min(item.paint.bottom, candidate.paint.bottom) - Math.max(item.paint.top, candidate.paint.top);
      return width > 1 && height > 1 ? [`${item.label} ${JSON.stringify(item.paint)} <> ${candidate.label} ${JSON.stringify(candidate.paint)}`] : [];
    }));
    return { overflow, overlaps };
  });
  expect(geometry.overflow, JSON.stringify(geometry)).toEqual([]);
  expect(geometry.overlaps, JSON.stringify(geometry)).toEqual([]);
}

async function expectAllRoundedAndClipped(cards: Locator): Promise<void> {
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) await expectRoundedAndClipped(cards.nth(index));
}

async function expectVisibleIconsFit(root: Locator): Promise<void> {
  const clipped = await root.evaluate((element) => [...element.querySelectorAll("m3e-icon")].flatMap((icon) => {
    const hostRect = icon.getBoundingClientRect();
    const hostStyle = getComputedStyle(icon);
    if (hostRect.width <= 0 || hostRect.height <= 0 || hostStyle.display === "none" || hostStyle.visibility === "hidden") return [];
    const glyph = icon.shadowRoot?.querySelector<HTMLElement>(".icon");
    const glyphSize = Number.parseFloat(glyph ? getComputedStyle(glyph).fontSize : hostStyle.fontSize);
    return glyphSize <= Math.max(hostRect.width, hostRect.height) + 0.5 ? [] : [{
      name: glyph?.textContent?.trim() || icon.textContent?.trim() || "unknown",
      host: `${icon.parentElement?.tagName || "unknown"}.${icon.parentElement?.className || ""}`,
      hostWidth: hostRect.width,
      hostHeight: hostRect.height,
      glyphSize
    }];
  }));
  expect(clipped, JSON.stringify(clipped)).toEqual([]);
}

async function expectVisibleButtonLabelsFit(root: Locator): Promise<void> {
  const clipped = await visibleButtonLabelIssues(root);
  expect(clipped, JSON.stringify(clipped)).toEqual([]);
}

async function visibleButtonLabelIssues(root: Locator): Promise<Array<{ text: string; clientWidth: number; scrollWidth: number; clientHeight: number; scrollHeight: number }>> {
  return root.evaluate((element) => [...element.querySelectorAll("m3e-button")].flatMap((button) => {
    const hostRect = button.getBoundingClientRect();
    const hostStyle = getComputedStyle(button);
    const label = button.shadowRoot?.querySelector<HTMLElement>(".label");
    if (!label || hostRect.width <= 0 || hostRect.height <= 0 || hostStyle.display === "none" || hostStyle.visibility === "hidden") return [];
    return label.scrollWidth <= label.clientWidth + 1 && label.scrollHeight <= label.clientHeight + 1 ? [] : [{
      text: button.textContent?.trim().replace(/\s+/g, " ") || "unknown",
      clientWidth: label.clientWidth,
      scrollWidth: label.scrollWidth,
      clientHeight: label.clientHeight,
      scrollHeight: label.scrollHeight
    }];
  }));
}

async function visibleHorizontalOverflowIssues(root: Locator): Promise<Array<{ selector: string; text: string; left: number; right: number; width: number; scrollWidth: number }>> {
  return root.evaluate((element) => {
    const viewportWidth = document.documentElement.clientWidth;
    const candidates = element.id === "root"
      ? [document.documentElement, element, ...element.querySelectorAll<HTMLElement>("*")]
      : [element, ...element.querySelectorAll<HTMLElement>("*")];
    return candidates.flatMap((candidate) => {
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return [];
      const intersectsViewport = rect.right > 1 && rect.left < viewportWidth - 1;
      const outside = intersectsViewport && (rect.left < -1 || rect.right > viewportWidth + 1);
      const ownOverflow = candidate === document.documentElement && candidate.scrollWidth > candidate.clientWidth + 1;
      if (!outside && !ownOverflow) return [];
      const name = candidate.id ? `#${candidate.id}` : `${candidate.tagName.toLowerCase()}.${String(candidate.className || "").trim().replace(/\s+/g, ".")}`;
      return [{ selector: name, text: (candidate.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: candidate.scrollWidth }];
    }).slice(0, 20);
  });
}
