import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(root, "dist");
const output = resolve(root, "store-assets");
const profile = await mkdtemp(join(tmpdir(), "monica-store-assets-"));
await mkdir(output, { recursive: true });

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  await manager.evaluate(() => localStorage.setItem("monica.scheme", "light"));
  const setup = await manager.evaluate(async (items) => {
    const created = await chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "store asset fixture password" });
    if (!created.ok) return created;
    for (const item of items) {
      const result = await chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item });
      if (!result.ok) return result;
    }
    return { ok: true };
  }, fixtures());
  if (!setup.ok) throw new Error(setup.error || "Unable to seed store assets.");
  await manager.reload();
  await manager.getByRole("heading", { name: "密码库概览" }).waitFor();
  await settle(manager);
  await manager.screenshot({ path: resolve(output, "01-vault-overview.png"), animations: "disabled" });

  await manager.getByRole("button", { name: /^登录项/ }).click();
  await manager.getByText("示例工作账号", { exact: true }).waitFor();
  await settle(manager);
  await manager.screenshot({ path: resolve(output, "02-login-items.png"), animations: "disabled" });

  await manager.getByRole("button", { name: "密码源" }).click();
  await manager.getByRole("button", { name: /连接 Monica Android WebDAV/ }).waitFor();
  await settle(manager);
  await manager.screenshot({ path: resolve(output, "03-password-sources.png"), animations: "disabled" });

  await context.route("https://shop-demo.example.test/**", (route) => route.fulfill({
    contentType: "text/html; charset=utf-8",
    body: demoLoginPage()
  }));
  const site = await context.newPage();
  await site.goto("https://shop-demo.example.test/login");
  const popup = await context.newPage();
  await site.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByText("示例工作账号", { exact: true }).waitFor();
  const popupCapture = resolve(profile, "popup.png");
  await popup.locator(".popup-shell").screenshot({ path: popupCapture, animations: "disabled" });
  const popupData = (await readFile(popupCapture)).toString("base64");
  const showcase = await context.newPage();
  await showcase.setViewportSize({ width: 1280, height: 800 });
  await showcase.setContent(popupShowcase(popupData));
  await showcase.screenshot({ path: resolve(output, "04-explicit-autofill-popup.png"), animations: "disabled" });

  await site.bringToFront();
  await site.getByLabel("示例邮箱").fill("new-demo@example.test");
  await site.getByLabel("示例密码").fill("not-a-real-password");
  await site.getByRole("button", { name: "登录示例网站" }).click();
  await site.locator("#monica-save-prompt-host").waitFor();
  await settle(site);
  await site.screenshot({ path: resolve(output, "05-save-password-prompt.png"), animations: "disabled" });
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
console.log(`Captured five sanitized 1280x800 store screenshots in ${output}.`);

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function fixtures() {
  const common = { favorite: false, notes: "", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", providerRefs: [] };
  return [
    { ...common, id: "store-login-work", kind: "login", title: "示例工作账号", username: "demo@example.test", password: "not-a-real-password", uris: ["https://shop-demo.example.test"], totpSecret: "JBSWY3DPEHPK3PXP", customFields: [] },
    { ...common, id: "store-login-finance", kind: "login", title: "示例财务账号", username: "finance@example.test", password: "not-a-real-password", uris: ["https://billing-demo.example.test"], customFields: [] },
    { ...common, id: "store-card", kind: "card", title: "示例 Visa", cardholderName: "DEMO USER", number: "4111111111111111", expiryMonth: "12", expiryYear: "2030", securityCode: "123", brand: "Visa" },
    { ...common, id: "store-identity", kind: "identity", title: "示例护照", documentType: "PASSPORT", documentNumber: "P00000000", firstName: "Demo", middleName: "", lastName: "User", fullName: "Demo User" },
    { ...common, id: "store-address", kind: "billing-address", title: "示例账单地址", fullName: "Demo User", company: "Example Studio", streetAddress: "1 Example Road", apartment: "", city: "Shanghai", stateProvince: "Shanghai", postalCode: "200000", country: "China", phone: "", email: "demo@example.test" },
    { ...common, id: "store-note", kind: "secure-note", title: "示例安全笔记", content: "Only synthetic content is used in store screenshots." },
    { ...common, id: "store-passkey", kind: "passkey", title: "示例 Passkey", credentialId: "fixture-credential", rpId: "passkey-demo.example.test", rpName: "Passkey Demo", userHandle: "fixture-user", userName: "demo@example.test", userDisplayName: "Demo User", algorithm: -7, publicKey: "", signCount: 2, discoverable: true, sourceMode: "android-metadata-only" }
  ];
}

function demoLoginPage() {
  return `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width"><title>示例登录页</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:linear-gradient(135deg,#eef8f5,#dceeff);font:16px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif;color:#1d2b2a}.shell{width:min(1080px,calc(100% - 48px));display:grid;grid-template-columns:1.2fr .8fr;gap:64px;align-items:center}.copy h1{font-size:52px;line-height:1.1;margin:0 0 18px}.copy p{font-size:20px;color:#526361}.card{display:grid;gap:18px;padding:34px;border-radius:32px;background:#fff;box-shadow:0 24px 64px #24403c22}.card h2{margin:0}.field{display:grid;gap:7px;font-weight:600}.field input{height:52px;border:1px solid #a9bbb8;border-radius:16px;padding:0 16px;font:inherit}.card button{height:52px;border:0;border-radius:26px;background:#0b6f69;color:white;font:inherit;font-weight:800}</style></head><body><main class="shell"><section class="copy"><h1>示例账号登录</h1><p>这是专用于 Monica 商店截图的合成页面，不包含真实网站或用户数据。</p></section><form class="card" onsubmit="event.preventDefault()"><h2>欢迎回来</h2><label class="field">示例邮箱<input aria-label="示例邮箱" name="username" autocomplete="username"></label><label class="field">示例密码<input aria-label="示例密码" name="password" type="password" autocomplete="current-password"></label><button type="submit">登录示例网站</button></form></main></body></html>`;
}

function popupShowcase(image) {
  return `<!doctype html><html lang="zh-CN"><style>*{box-sizing:border-box}body{margin:0;width:1280px;height:800px;overflow:hidden;background:radial-gradient(circle at 80% 10%,#cdeeea 0,transparent 36%),linear-gradient(135deg,#f7fbf9,#e8f0ff);font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;color:#163330}.stage{height:100%;display:grid;grid-template-columns:1fr 480px;align-items:center;gap:80px;padding:72px 110px}.copy small{color:#0b6f69;font-size:18px;font-weight:800;letter-spacing:.08em}.copy h1{font-size:54px;line-height:1.12;margin:18px 0}.copy p{font-size:21px;line-height:1.7;color:#526361}.frame{justify-self:end;padding:18px;border:1px solid #bfded9;border-radius:38px;background:#ffffffaa;box-shadow:0 30px 80px #24403c2b}.frame img{display:block;width:390px;border-radius:24px}</style><body><main class="stage"><section class="copy"><small>MONICA 自动填充</small><h1>只在你点击后<br>解密并填充</h1><p>Popup 只显示当前网站的匹配摘要。完整密码库和 Provider 凭据不会进入网页。</p></section><div class="frame"><img alt="Monica 自动填充 Popup" src="data:image/png;base64,${image}"></div></main></body></html>`;
}
