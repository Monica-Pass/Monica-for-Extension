import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const scriptPath = fileURLToPath(import.meta.url);
if (process.platform === "linux" && !process.env.DISPLAY && !process.argv.includes("--xvfb-child")) {
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
    headless: false,
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
  await popup.waitForTimeout(250);
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
      text: document.body.innerText
    };
  });
  assert(metrics.innerWidth >= 370 && metrics.innerWidth <= 410, `Action Popup width must stay near 390px; received ${metrics.innerWidth}px.`);
  assert(metrics.rootWidth >= 370 && metrics.shellWidth >= 370, `Action Popup content collapsed: root=${metrics.rootWidth}px shell=${metrics.shellWidth}px.`);
  assert(metrics.innerHeight >= 480 && metrics.innerHeight <= 600, `Action Popup height is outside the usable range: ${metrics.innerHeight}px.`);
  assert(metrics.scrollWidth <= metrics.clientWidth + 1, `Action Popup has horizontal overflow: client=${metrics.clientWidth}px scroll=${metrics.scrollWidth}px.`);
  assert(metrics.text.includes("Monica") && metrics.text.includes("密码库已锁定") && metrics.text.includes("管理密码库"), "Action Popup did not render the expected locked Monica controls.");
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
} finally {
  await attachedBrowser?.close().catch(() => undefined);
  await ownerContext?.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const popup = browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().endsWith("/popup.html"));
    if (popup) return popup;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("The real chrome.action Popup target did not appear.");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
