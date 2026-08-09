import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
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
  assert(metrics.text.includes("Monica") && metrics.text.includes("管理密码库"), "Action Popup did not render the expected Monica controls.");
  console.log(`Verified real Action Popup: ${metrics.innerWidth}x${metrics.innerHeight}px, root ${metrics.rootWidth}px, no horizontal overflow.`);
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
