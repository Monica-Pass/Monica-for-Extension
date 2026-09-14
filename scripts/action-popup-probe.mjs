import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const scriptPath = fileURLToPath(import.meta.url);
const headless = process.argv.includes("--headless");
if (!headless && process.platform === "linux" && !process.env.DISPLAY && !process.argv.includes("--xvfb-child")) {
  const child = spawnSync("xvfb-run", ["-a", "-s", "-screen 0 1280x720x24", process.execPath, scriptPath, "--xvfb-child"], { stdio: "inherit", env: process.env });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(root, "dist");
const profile = await mkdtemp(join(tmpdir(), "monica-action-popup-"));
const debuggingPort = await reservePort();
let ownerContext;
let attachedBrowser;

try {
  ownerContext = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless, locale: "zh-CN",
    args: [
      `--remote-debugging-port=${debuggingPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });
  const worker = ownerContext.serviceWorkers()[0] || await ownerContext.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  await ownerContext.route("https://popup-probe.example.test/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: '<!doctype html><html lang="zh-CN"><title>Popup Icon Probe</title><label>用户名<input autocomplete="username"></label><label>密码<input type="password" autocomplete="current-password"></label></html>'
  }));
  const manager = await ownerContext.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  await manager.getByRole("heading", { name: "创建加密密码库", exact: true }).waitFor();
  const setup = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "popup icon probe password" }));
  assert(setup?.ok, "Action Popup probe could not create its temporary vault.");
  const locked = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }));
  assert(locked?.ok, "Action Popup probe could not lock its temporary vault.");
  await manager.close();
  const site = await ownerContext.newPage();
  await site.goto("https://popup-probe.example.test/login");
  await site.locator('input[type="password"]').waitFor();
  await site.bringToFront();
  await worker.evaluate(async () => chrome.action.openPopup());
  attachedBrowser = await connectToBrowser(debuggingPort);
  const popup = await waitForPopup(attachedBrowser);
  await popup.locator(".popup-shell").waitFor({ state: "attached" });
  // Font readiness and animation frames settle layout without masking a
  // persistent intrinsic-size failure with an arbitrary startup delay.
  await popup.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
  });
  const metrics = await popup.evaluate(() => {
    const rootElement = document.querySelector("#popup-root");
    const shell = document.querySelector(".popup-shell");
    return {
      innerWidth,
      innerHeight,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rootWidth: rootElement?.getBoundingClientRect().width || 0,
      shellWidth: shell?.getBoundingClientRect().width || 0,
      shellHeight: shell?.getBoundingClientRect().height || 0,
      text: document.body.innerText
    };
  });
  assert(metrics.innerWidth >= 370 && metrics.innerWidth <= 410, `Action Popup width must stay near 390px; received ${metrics.innerWidth}px.`);
  assert(metrics.rootWidth >= 370 && metrics.shellWidth >= 370, `Action Popup content collapsed: root=${metrics.rootWidth}px shell=${metrics.shellWidth}px.`);
  assert(metrics.innerHeight >= 480 && metrics.innerHeight <= 600, `Action Popup height is outside the usable range: ${metrics.innerHeight}px.`);
  assert(metrics.shellHeight === 600, `Action Popup must reserve its full list height on first paint; received ${metrics.shellHeight}px.`);
  assert(metrics.scrollWidth <= metrics.clientWidth + 1, `Action Popup has horizontal overflow: client=${metrics.clientWidth}px scroll=${metrics.scrollWidth}px.`);
  assert(metrics.text.includes("Monica") && metrics.text.includes("密码库已锁定") && metrics.text.includes("管理密码库"), "Action Popup did not render the expected locked Monica controls.");
  if (process.env.MONICA_POPUP_SCREENSHOT_NORMAL) {
    const screenshotPath = resolve(root, process.env.MONICA_POPUP_SCREENSHOT_NORMAL);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await popup.screenshot({ path: screenshotPath, animations: "disabled" });
    console.log(`Saved normal Action Popup screenshot to ${screenshotPath}.`);
  }
  await popup.emulateMedia({ colorScheme: "dark" });
  await popup.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await popup.waitForTimeout(250);
  const scaledLayout = await popup.evaluate(() => {
    const shell = document.querySelector(".popup-shell");
    const containmentViolations = [".popup-header", ".site-summary", ".popup-unlock", ".popup-footer"].flatMap((selector) => {
      const container = document.querySelector(selector);
      if (!container) return [];
      const containerRect = container.getBoundingClientRect();
      return [...container.children].flatMap((child) => {
        const style = getComputedStyle(child);
        const rect = child.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return [];
        if (rect.left >= containerRect.left - 1 && rect.right <= containerRect.right + 1 && rect.top >= containerRect.top - 1 && rect.bottom <= containerRect.bottom + 1) return [];
        return [{
          container: selector,
          child: child.tagName,
          className: child.className || "",
          containerRect: { left: containerRect.left, right: containerRect.right, top: containerRect.top, bottom: containerRect.bottom },
          childRect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        }];
      });
    });
    return {
      innerWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      shell: shell ? { clientWidth: shell.clientWidth, scrollWidth: shell.scrollWidth } : null,
      containmentViolations
    };
  });
  if (process.env.MONICA_POPUP_DIAGNOSTICS) console.log(JSON.stringify(scaledLayout, null, 2));
  const icons = await popup.evaluate(() => [...document.querySelectorAll("m3e-icon")].map((host) => {
    const hostRect = host.getBoundingClientRect();
    const hostStyle = getComputedStyle(host);
    const glyph = host.shadowRoot?.querySelector(".icon");
    const glyphStyle = glyph ? getComputedStyle(glyph) : null;
    return {
      name: glyph?.textContent?.trim() || host.textContent?.trim() || "unknown",
      hostWidth: hostRect.width,
      hostHeight: hostRect.height,
      hostFontSize: Number.parseFloat(hostStyle.fontSize),
      glyphFontSize: Number.parseFloat(glyphStyle?.fontSize || hostStyle.fontSize),
      overflow: hostStyle.overflow,
      visible: hostRect.width > 0 && hostRect.height > 0 && hostStyle.display !== "none" && hostStyle.visibility !== "hidden"
    };
  }).filter((icon) => icon.visible));
  const clippedIcons = icons.filter((icon) => icon.glyphFontSize > Math.max(icon.hostWidth, icon.hostHeight) + 0.5);
  assert(icons.length >= 3, `Action Popup icon probe found too few visible icons: ${icons.length}.`);
  assert(!clippedIcons.length, `Action Popup icons exceed their hosts at 200% text: ${clippedIcons.map((icon) => `${icon.name} ${icon.glyphFontSize}px in ${icon.hostWidth}x${icon.hostHeight}px`).join(", ")}.`);
  assert(scaledLayout.scrollWidth <= scaledLayout.clientWidth + 1, `Action Popup has horizontal overflow at 200% text: client=${scaledLayout.clientWidth}px scroll=${scaledLayout.scrollWidth}px.`);
  assert(scaledLayout.shell && scaledLayout.shell.scrollWidth <= scaledLayout.shell.clientWidth + 1, `Action Popup shell has horizontal overflow at 200% text: client=${scaledLayout.shell?.clientWidth || 0}px scroll=${scaledLayout.shell?.scrollWidth || 0}px.`);
  assert(!scaledLayout.containmentViolations.length, `Action Popup content overlaps its sections at 200% text: ${scaledLayout.containmentViolations.map((violation) => `${violation.container} > ${violation.child}.${violation.className}`).join(", ")}.`);
  if (process.env.MONICA_POPUP_SCREENSHOT) {
    const screenshotPath = resolve(root, process.env.MONICA_POPUP_SCREENSHOT);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await popup.screenshot({ path: screenshotPath, animations: "disabled" });
    console.log(`Saved Action Popup screenshot to ${screenshotPath}.`);
  }
  console.log(`Verified real Action Popup: ${metrics.innerWidth}x${metrics.innerHeight}px, root ${metrics.rootWidth}px, ${icons.length} icons fit at 200% text.`);

  for (const language of ["ja", "ko", "de", "es", "ru", "vi"]) {
    await popup.evaluate((language) => chrome.storage.local.set({ "monica.locale": language }), language);
    await popup.waitForFunction((language) => document.documentElement.lang === language, language);
    const issues = await popup.evaluate(() => {
      const issues = [];
      const width = document.documentElement.clientWidth;
      for (const control of document.querySelectorAll("m3e-button, m3e-icon-button, input, select")) {
        const box = control.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) continue;
        if (box.left < -1 || box.right > width + 1) issues.push(`Outside window: ${control.tagName}`);
        const label = control.shadowRoot?.querySelector(".label");
        if (label && (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1)) issues.push(`Clipped label: ${control.textContent}`);
      }
      const copy = document.querySelector(".popup-unlock > div").getBoundingClientRect();
      const field = document.querySelector(".popup-unlock input").getBoundingClientRect();
      if (copy.width < field.width - 1) issues.push("Unlock explanation is squeezed");
      return issues;
    });
    assert(!issues.length, `${language} Action Popup layout: ${issues.join(", ")}`);
  }
  await popup.evaluate(() => chrome.storage.local.set({ "monica.locale": "zh-CN" }));
  await popup.waitForFunction(() => document.documentElement.lang === "zh-CN");
  console.log("Verified six additional offline languages in the real Action Popup at 200% text.");

  // Phase 2: unlock, then seed + refresh entirely inside the popup (focus changes close it).
  await popup.getByLabel("主密码").fill("popup icon probe password");
  await popup.getByRole("button", { name: "解锁", exact: true }).click();
  await popup.getByLabel("搜索全部登录项").waitFor({ state: "attached", timeout: 15000 });
  const seeded = await popup.evaluate(async () => {
    const now = new Date().toISOString();
    return chrome.runtime.sendMessage({
      type: "VAULT_IMPORT_ITEMS",
      items: [
        { id: "probe-match", kind: "login", title: "当前网站的工作账号", username: "work@example.test", password: "synthetic-work-secret", totpSecret: "JBSWY3DPEHPK3PXP", uris: ["https://popup-probe.example.test"], favorite: true, notes: "", createdAt: now, updatedAt: now, providerRefs: [], customFields: [] },
        { id: "probe-github", kind: "login", title: "GitHub 账号", username: "joy@github", password: "gh-secret", uris: ["https://github.com"], favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], customFields: [] },
        { id: "probe-forum", kind: "login", title: "论坛账号", username: "ling@forum", password: "forum-secret", uris: ["https://forum.example"], favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], customFields: [] },
        { id: "probe-long", kind: "login", title: "一个非常非常长的登录项标题用来验证列表不会把弹窗撑出横向滚动条", username: "extremely-long-username-for-overflow-regression@example-domain.test", password: "long-secret", uris: ["https://long.example"], favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], customFields: [] }
      ]
    });
  });
  assert(seeded?.ok, `Action Popup search probe could not seed logins: ${seeded?.error || "unknown"}`);
  await popup.evaluate(() => window.__monicaPopupRefresh());
  await popup.getByText("全部登录项").waitFor({ timeout: 15000 });
  await popup.locator("#popup-matches .popup-totp-icon").waitFor({ state: "visible" });
  const overflow = await popup.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert(overflow.scroll <= overflow.client + 1, `Action Popup global list causes horizontal overflow: client=${overflow.client} scroll=${overflow.scroll}`);
  const rowIssues = await popup.locator(".login-row").evaluateAll((rows) => rows.flatMap((row) => {
    const box = row.getBoundingClientRect();
    const issues = [...row.querySelectorAll(".popup-item-title, .popup-item-subtitle, .row-actions")].flatMap((part) => {
      const area = part.getBoundingClientRect();
      return area.left >= box.left - 1 && area.right <= box.right + 1 && area.top >= box.top - 1 && area.bottom <= box.bottom + 1 ? [] : [part.className];
    });
    const icon = row.querySelector(".credential-icon").getBoundingClientRect();
    const title = row.querySelector(".popup-item-title").getBoundingClientRect();
    if (icon.left < box.left + 7 || title.left < icon.right + 7) issues.push("Squeezed website icon");
    return issues;
  }));
  assert(!rowIssues.length, `Action Popup account text and actions overlap at 200% text: ${rowIssues.join(", ")}`);
  await popup.emulateMedia({ colorScheme: "light" });
  await popup.evaluate(() => {
    document.documentElement.style.fontSize = "100%";
    document.querySelector(".popup-shell").scrollTop = 0;
  });
  await saveListScreenshot(popup, "MONICA_POPUP_SCREENSHOT_LIST");
  if (process.env.MONICA_POPUP_DIAGNOSTICS) console.log(JSON.stringify(await popup.locator(".login-row-main").evaluateAll((rows) => rows.map(row => {
    const inner = row.shadowRoot.querySelector("m3e-list-item-button") || row;
    const base = inner.shadowRoot.querySelector(".base");
    const content = inner.shadowRoot.querySelector(".content");
    const leading = inner.shadowRoot.querySelector('slot[name="leading"]');
    const icon = row.querySelector(".credential-icon");
    const title = row.querySelector(".popup-item-title");
    return {
      mainWidth: row.getBoundingClientRect().width,
      padding: getComputedStyle(base).padding,
      gap: getComputedStyle(base).columnGap,
      contentWidth: content.getBoundingClientRect().width,
      contentMinWidth: getComputedStyle(content).minWidth,
      leadingWidth: leading.getBoundingClientRect().width,
      iconWidth: icon.getBoundingClientRect().width,
      iconLeft: icon.getBoundingClientRect().left,
      titleLeft: title.getBoundingClientRect().left,
      titleWidth: title.getBoundingClientRect().width
    };
  })), null, 2));
  await popup.getByLabel("搜索全部登录项").fill("github");
  await popup.waitForTimeout(300);
  const searchText = await popup.locator(".popup-shell").innerText();
  assert(searchText.includes("GitHub 账号"), "Action Popup search did not surface the GitHub login.");
  assert(!searchText.includes("论坛账号"), "Action Popup search leaked a non-matching login.");
  await popup.getByRole("button", { name: "复制用户名" }).first().click();
  await popup.getByText("已复制用户名").waitFor({ timeout: 5000 });
  assert(await site.locator('input[autocomplete="username"]').inputValue() === "" && await site.locator('input[type="password"]').inputValue() === "", "Copying an account must not also fill the webpage.");
  const copyPassword = popup.getByRole("button", { name: "复制密码" }).first();
  await copyPassword.focus();
  await popup.keyboard.press("Enter");
  await popup.getByText("已复制密码").waitFor({ timeout: 5000 });
  assert(await site.locator('input[type="password"]').inputValue() === "", "Keyboard copying must not trigger the neighboring fill action.");
  await popup.getByLabel("搜索全部登录项").fill("");
  await popup.locator("#popup-matches").getByRole("button", { name: /当前网站的工作账号/ }).click();
  await popup.getByText(/已填充 当前网站的工作账号/).waitFor({ timeout: 5000 });
  assert(await site.locator('input[autocomplete="username"]').inputValue() === "work@example.test" && await site.locator('input[type="password"]').inputValue() === "synthetic-work-secret", "The M3E account row did not fill the selected login.");

  await site.goto("chrome://version/");
  await popup.evaluate(() => window.__monicaPopupRefresh());
  await popup.getByText("此浏览器页面不允许自动填充").waitFor({ timeout: 15000 });
  await popup.getByLabel("搜索全部登录项").fill("");
  await popup.waitForTimeout(300);
  const unsupportedText = await popup.locator(".popup-shell").innerText();
  assert(unsupportedText.includes("全部登录项"), "Action Popup hid the global login list on an unsupported page.");
  assert(await popup.locator(".login-row-main").getByRole("button").count() === 0, "An unsupported page must expose account information without an active fill button.");
  await popup.evaluate(() => { document.querySelector(".popup-shell").scrollTop = 0; });
  await saveListScreenshot(popup, "MONICA_POPUP_SCREENSHOT_LIST_UNSUPPORTED");
  await popup.getByLabel("搜索全部登录项").fill("论坛");
  await popup.waitForTimeout(300);
  const unsupportedFiltered = await popup.locator(".popup-shell").innerText();
  assert(unsupportedFiltered.includes("论坛账号"), "Action Popup search failed on an unsupported page.");
  await popup.getByRole("button", { name: "复制密码" }).first().click();
  await popup.getByText("已复制密码").waitFor({ timeout: 5000 });
  console.log("Verified Action Popup global search and copy fallback on an unsupported page.");
} finally {
  await attachedBrowser?.close().catch(() => undefined);
  await ownerContext?.close().catch(() => undefined);
  const resolvedProfile = await realpath(profile);
  const profileTempRoot = await realpath(tmpdir());
  assert(dirname(resolvedProfile) === profileTempRoot && basename(resolvedProfile).startsWith("monica-action-popup-"), "Refusing to remove an unexpected Popup profile directory.");
  await rm(resolvedProfile, { recursive: true, force: true });
}

async function saveListScreenshot(popup, variable) {
  if (!process.env[variable]) return;
  const screenshotPath = resolve(root, process.env[variable]);
  await mkdir(dirname(screenshotPath), { recursive: true });
  await popup.evaluate(() => { document.scrollingElement.scrollTop = 0; document.querySelector(".popup-shell").scrollTop = 0; });
  await popup.mouse.move(0, 0);
  await popup.screenshot({ path: screenshotPath, animations: "disabled" });
  console.log(`Saved account list screenshot to ${screenshotPath}.`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a Chromium debugging port.");
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function connectToBrowser(port) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError || new Error("Could not connect to Chromium debugging endpoint.");
}

async function waitForPopup(browser) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const popup = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().endsWith("/popup.html"));
    if (popup) return popup;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("The real chrome.action Popup target did not appear.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
