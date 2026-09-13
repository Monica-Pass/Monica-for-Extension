import { chromium, expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";

const extension = path.resolve("dist");
const masterPassword = "responsive synthetic master password";
const sizes = [
  [320, 568, 100], [360, 640, 100], [390, 844, 100], [768, 600, 100],
  [1024, 600, 100], [1366, 768, 100], [1920, 1080, 100], [2560, 1440, 100],
  [320, 480, 200], [800, 360, 200]
] as const;

async function launch(testInfo: TestInfo, width: number, height: number, scale: number, locale = "en-US") {
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium", headless: true, locale, reducedMotion: "reduce",
    colorScheme: scale === 200 ? "dark" : "light", viewport: { width, height },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  expect(await page.evaluate((password) => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: password }), masterPassword)).toMatchObject({ ok: true });
  const now = new Date().toISOString();
  const common = { favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], customFields: [] };
  for (const item of [
    { ...common, id: "responsive-login", kind: "login", title: "Design workspace account with a long title", username: "design.workspace@example.test", password: "synthetic-secret", uris: ["https://responsive.example.test"] },
    { ...common, id: "responsive-note", kind: "secure-note", title: "Recovery instructions for the design workspace", content: "Synthetic fixture with a long unbroken token: abcdef0123456789".repeat(4), tags: ["work", "recovery"] },
    { ...common, id: "responsive-card", kind: "card", title: "Workspace payment card", cardholderName: "DESIGN WORKSPACE", number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", securityCode: "123", brand: "Visa" },
    { ...common, id: "responsive-otp", kind: "totp", title: "Workspace verification", secret: "JBSWY3DPEHPK3PXP", issuer: "Workspace", accountName: "design.workspace@example.test", otpType: "TOTP", digits: 6, period: 30, algorithm: "SHA1" },
    { ...common, id: "responsive-passkey", kind: "passkey", title: "Workspace device-bound Passkey", credentialId: "AQID", rpId: "responsive.example.test", rpName: "Workspace", userHandle: "dXNlcg", userName: "design.workspace@example.test", algorithm: -7, publicKey: "metadata-only", signCount: 0, discoverable: true, sourceMode: "android-keystore" }
  ]) expect(await page.evaluate((item) => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), item)).toMatchObject({ ok: true });
  await page.reload();
  await expect(page.locator(".page-heading h1")).toBeVisible();
  await page.evaluate((value) => { document.documentElement.style.fontSize = `${value}%`; }, scale);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, extensionId };
}

async function navigate(page: Page, name: string, openLabel = "Open navigation") {
  const menu = page.getByRole("button", { name: openLabel, exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.locator(".sidebar").getByRole("button", { name: new RegExp(`^${name}`) }).click();
}

// Check actual controls, including Shadow DOM hit areas. Root scrollWidth alone
// can miss a control clipped by a card or an invisible oversized touch target.
async function expectUsableControls(root: Locator) {
  const problems = await root.evaluate((root) => {
    const problems: string[] = [];
    const viewport = document.documentElement.clientWidth;
    for (const element of root.querySelectorAll<HTMLElement>("button, m3e-button, m3e-icon-button, input, select, textarea, summary")) {
      if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || element.closest("[inert]")) continue;
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue; // Deliberately hidden file/radio inputs.
      const name = element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 65) || element.tagName;
      if (box.left < -1 || box.right > viewport + 1) problems.push(`Outside window: ${name}`);
      if (element.matches("button, m3e-button, m3e-icon-button") && (box.width < 43.5 || box.height < 43.5)) problems.push(`Small target: ${name}`);
      const label = element.shadowRoot?.querySelector<HTMLElement>(".label");
      if (label && (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1)) problems.push(`Clipped label: ${name}`);
      const target = element.shadowRoot?.querySelector(".touch")?.getBoundingClientRect();
      if (target && (target.left < box.left - 1 || target.right > box.right + 1 || target.top < box.top - 1 || target.bottom > box.bottom + 1)) problems.push(`Overlapping hit area: ${name}`);
    }
    return problems;
  });
  expect(problems).toEqual([]);
}

for (const [width, height, scale] of sizes) {
  test(`populated pages and actions fit ${width}x${height} at ${scale}% text`, async ({}, testInfo) => {
    const { context, page } = await launch(testInfo, width, height, scale);
    try {
      await expect(page.locator(".home-module")).toHaveCount(6);
      await expect(page.locator(".home-featured-card")).toHaveCount(1);
      await expect(page.locator(".home-type-button")).toHaveCount(8);
      for (const section of ["Overview", "Login", "Wallet and identity", "Secure Note", "Verification codes", "Steam", "Passkey", "Secure Send", "Archive", "Recycle Bin", "Timeline", "Sources", "Settings and backups", "Generator"]) {
        await navigate(page, section);
        if (section === "Settings and backups") await page.locator(".settings-disclosure").evaluateAll((items) => items.forEach((item) => { (item as HTMLDetailsElement).open = true; }));
        await expectUsableControls(page.locator("#main-content"));
        if (["Login", "Wallet and identity", "Secure Note", "Verification codes", "Passkey"].includes(section)) {
          await page.getByRole("button", { name: /^View details for / }).first().click();
          const detail = page.getByRole("dialog");
          await expect(detail).toBeVisible();
          await expectUsableControls(detail);
          await detail.getByRole("button", { name: "Close", exact: true }).click();
        }
      }
      await navigate(page, "Login");
      const actions = page.locator(".appbar-actions m3e-button");
      const boxes = await actions.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));
      expect(boxes).toHaveLength(2);
      expect(boxes[1].left - boxes[0].right >= 7 || boxes[1].top - boxes[0].bottom >= 7).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("login.png"), animations: "disabled" });
    } finally { await context.close(); }
  });
}

test("narrow navigation closes, traps focus, and survives a desktop resize", async ({}, testInfo) => {
  const { context, page } = await launch(testInfo, 390, 640, 200);
  try {
    const menu = page.getByRole("button", { name: "Open navigation", exact: true });
    const sidebar = page.locator(".sidebar");
    await expect(sidebar).toBeHidden();
    await menu.click();
    await expect(sidebar).toHaveAttribute("aria-modal", "true");
    await expect(page.locator("#main-content")).toHaveAttribute("inert", "");
    const close = page.getByRole("button", { name: "Close navigation", exact: true });
    const lock = sidebar.getByRole("button", { name: "Lock now", exact: true });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(lock).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sidebar).toBeHidden();
    await expect(menu).toBeFocused();
    await menu.click();
    await page.locator(".navigation-scrim").click({ position: { x: 382, y: 20 } });
    await expect(sidebar).toBeHidden();
    await menu.click();
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await expect(page.locator("#main-content")).not.toHaveAttribute("inert", "");
    await expect(page.locator(".navigation-scrim")).toHaveCount(0);
    await expect(sidebar).toBeVisible();
    await page.setViewportSize({ width: 800, height: 360 });
    await menu.click();
    await lock.scrollIntoViewIfNeeded();
    await expect(lock).toBeInViewport({ ratio: 1 });
    await expectUsableControls(sidebar);
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await menu.click();
    await lock.click();
    await page.getByLabel("Master password", { exact: true }).fill(masterPassword);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(page.locator(".page-heading h1")).toBeVisible();
    await expect(sidebar).toBeHidden();
    await expect(page.locator("#main-content")).not.toHaveAttribute("inert", "");
  } finally { await context.close(); }
});

for (const [width, height, scale] of [[320, 480, 200], [560, 320, 100], [768, 600, 200], [1366, 768, 100]]) {
  test(`editor actions stay reachable while fields scroll at ${width}x${height}/${scale}%`, async ({}, testInfo) => {
    const { context, page } = await launch(testInfo, width, height, scale, "zh-CN");
    try {
      await navigate(page, "登录项", "打开导航");
      await page.getByRole("button", { name: "新建", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "添加登录项", exact: true });
      const save = dialog.getByRole("button", { name: "加密保存", exact: true });
      await expect(save).toBeInViewport({ ratio: 1 });
      const initial = await save.boundingBox();
      await dialog.getByLabel("名称 *", { exact: true }).fill("跨尺寸保存的项目");
      await dialog.getByRole("button", { name: "添加字段", exact: true }).click();
      await dialog.getByLabel("自定义字段 1 名称").fill("自定义字段");
      await dialog.getByLabel("自定义字段 1 值").fill("synthetic value");
      await dialog.getByLabel("备注", { exact: true }).fill("保留字段滚动与保存操作");
      await expectUsableControls(dialog);
      await expect(save).toBeInViewport({ ratio: 1 });
      const final = await save.boundingBox();
      expect(Math.abs(initial!.y - final!.y)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath("editor.png"), animations: "disabled" });
      await save.click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText("跨尺寸保存的项目", { exact: true })).toBeVisible();
      await navigate(page, "安全笔记", "打开导航");
      await page.getByRole("button", { name: "添加安全笔记", exact: true }).click();
      const note = page.getByRole("dialog", { name: "添加安全笔记", exact: true });
      await note.getByLabel("名称 *").fill("跨尺寸安全笔记");
      await note.getByLabel("笔记内容 *").fill("A complete editable note.");
      await expect(note.getByRole("button", { name: "加密保存" })).toBeInViewport({ ratio: 1 });
      await note.getByRole("button", { name: "加密保存" }).click();
      await expect(page.getByText("跨尺寸安全笔记", { exact: true })).toBeVisible();
    } finally { await context.close(); }
  });
}

test("short popup keeps marked autofill and the unlock form operable", async ({}, testInfo) => {
  const { context, page: manager, extensionId } = await launch(testInfo, 320, 360, 200, "zh-CN");
  try {
    expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SET_LOCKED_AUTOFILL", itemId: "responsive-login", enabled: true }))).toMatchObject({ ok: true });
    await context.route("https://responsive.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: '<!doctype html><label>Username<input autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label>' }));
    const site = await context.newPage();
    await site.goto("https://responsive.example.test/login");
    await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }));
    const popup = await context.newPage();
    await site.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const marked = popup.locator(".locked-autofill-section").getByRole("button", { name: /Design workspace account/ });
    await expect(marked).toBeVisible();
    for (const [width, height, scale] of [[390, 600, 100], [320, 360, 200]]) {
      await popup.setViewportSize({ width, height });
      await popup.evaluate((value) => { document.documentElement.style.fontSize = `${value}%`; }, scale);
      await popup.evaluate(() => document.fonts.ready);
      const copy = await popup.locator(".popup-unlock > div").boundingBox();
      const field = await popup.getByLabel("主密码", { exact: true }).boundingBox();
      // Explanatory text must use the available form width, not a leftover icon column.
      expect(copy!.width, `Unlock copy at ${width}x${height}/${scale}%`).toBeGreaterThanOrEqual(field!.width - 1);
      expect(Math.abs(copy!.x - field!.x)).toBeLessThanOrEqual(1);
      await expectUsableControls(popup.locator("#popup-root"));
    }
    await expect(popup.getByLabel("主密码", { exact: true })).not.toBeFocused();
    await marked.click();
    await expect(site.locator('input[type="password"]')).toHaveValue("synthetic-secret");
    expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_STATUS" }))).toMatchObject({ ok: true, data: "locked" });
    await popup.getByLabel("主密码", { exact: true }).fill(masterPassword);
    await popup.getByRole("button", { name: "解锁", exact: true }).click();
    await expect(popup.locator(".popup-unlock")).toHaveCount(0);
    await expectUsableControls(popup.locator("#popup-root"));
  } finally { await context.close(); }
});
