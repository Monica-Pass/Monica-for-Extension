import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const extensionPath = resolve(root, "dist");
const output = resolve(root, "store-assets");
const temporaryRoot = await realpath(tmpdir());
const profile = await mkdtemp(join(temporaryRoot, "monica-store-assets-"));
const version = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version;
const evidence = resolve(root, `.artifacts/brand-${version}`);
const logoChecks = [];
await mkdir(output, { recursive: true });
await mkdir(evidence, { recursive: true });

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true, locale: "zh-CN",
    viewport: { width: 1280, height: 800 },
    colorScheme: "light",
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  await manager.locator(".login-brand .brand-logo").waitFor();
  await inspectPageLogo(manager, ".login-brand .brand-logo", 48, "setup");
  await manager.evaluate(() => localStorage.setItem("monica.scheme", "light"));
  const setup = await manager.evaluate(async (items) => {
    const created = await chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "store asset fixture password" });
    if (!created.ok) return created;
    for (const item of items) {
      const result = await chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item, ...(item.id === "store-login-work" ? { allowLockedAutofill: true } : {}) });
      if (!result.ok) return result;
    }
    return { ok: true };
  }, fixtures());
  if (!setup.ok) throw new Error(setup.error || "Unable to seed store assets.");
  await manager.reload();
  await manager.locator(".vault-home").waitFor();
  await settle(manager);
  await inspectPageLogo(manager, ".sidebar-brand .brand-logo", 40, "overview");
  await manager.screenshot({ path: resolve(output, "01-vault-overview.png"), animations: "disabled" });

  await manager.getByRole("navigation").getByRole("button", { name: /^登录项/ }).click();
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
  await inspectPageLogo(popup, ".popup-brand .brand-logo", 36, "toolbar-popup");
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
  await inspectPromptLogo(site, "monica-save-prompt-host", 44, "save-light");
  await site.screenshot({ path: resolve(output, "05-save-password-prompt.png"), animations: "disabled" });
  for (const theme of ["light", "dark"]) {
    await site.emulateMedia({ colorScheme: theme });
    await site.setViewportSize({ width: 320, height: 720 });
    await inspectPromptLogo(site, "monica-save-prompt-host", 44, `save-${theme}-320`);
    await site.screenshot({ path: resolve(evidence, `save-${theme}-320.png`), animations: "disabled" });
  }
  await site.setViewportSize({ width: 1280, height: 800 });
  await site.emulateMedia({ colorScheme: "light" });
  await site.reload();
  await site.getByLabel("示例邮箱").click();
  await site.locator("#monica-inline-autofill-host").waitFor();
  await inspectPromptLogo(site, "monica-inline-autofill-host", 24, "inline-menu");
  await site.screenshot({ path: resolve(output, "06-form-autofill.png"), animations: "disabled" });

  await context.route("https://passkey-demo.example.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: passkeyDemoPage() }));
  const passkey = await context.newPage();
  await passkey.goto("https://passkey-demo.example.test/");
  await passkey.locator("#register").click();
  await passkey.locator("#monica-passkey-prompt-host").waitFor();
  await inspectPromptLogo(passkey, "monica-passkey-prompt-host", 44, "passkey-create");
  await passkey.screenshot({ path: resolve(output, "07-passkey-create.png"), animations: "disabled" });
  for (const theme of ["light", "dark"]) {
    await passkey.emulateMedia({ colorScheme: theme });
    await passkey.setViewportSize({ width: 320, height: 720 });
    await inspectPromptLogo(passkey, "monica-passkey-prompt-host", 44, `passkey-create-${theme}-320`);
    await passkey.screenshot({ path: resolve(evidence, `passkey-create-${theme}-320.png`), animations: "disabled" });
  }
  await passkey.setViewportSize({ width: 1280, height: 800 });
  await passkey.emulateMedia({ colorScheme: "light" });
  const createControl = await inspectPromptLogo(passkey, "monica-passkey-prompt-host", 44, "passkey-create-confirm");
  await passkey.mouse.click(createControl.confirm.x, createControl.confirm.y);
  await passkey.locator("#result").filter({ hasText: /^registered$/ }).waitFor();
  await passkey.locator("#authenticate").click();
  await passkey.locator("#monica-passkey-prompt-host").waitFor();
  const getControl = await inspectPromptLogo(passkey, "monica-passkey-prompt-host", 44, "passkey-sign-in");
  await passkey.screenshot({ path: resolve(output, "08-passkey-sign-in.png"), animations: "disabled" });
  await passkey.mouse.click(getControl.confirm.x, getControl.confirm.y);
  await passkey.locator("#result").filter({ hasText: /^authenticated$/ }).waitFor();
  await writeFile(resolve(evidence, "store-capture-checks.json"), JSON.stringify({ version, source: "isolated browser and synthetic fixtures only", logoChecks }, null, 2) + "\n");
} finally {
  await context?.close();
  const safeProfile = await realpath(profile);
  assert.equal(dirname(safeProfile), temporaryRoot);
  assert.ok(basename(safeProfile).startsWith("monica-store-assets-"));
  await rm(safeProfile, { recursive: true, force: true, maxRetries: 3 });
}
console.log(`Captured eight sanitized screenshots and verified ${logoChecks.length} original Monica logo displays.`);

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function validateLogo(data, size, scenario) {
  assert.equal(data.path, "/icons/logo-256.png", scenario);
  assert.equal(data.naturalWidth, 256, scenario);
  assert.equal(data.naturalHeight, 256, scenario);
  assert.equal(data.width, size, scenario);
  assert.equal(data.height, size, scenario);
  assert.equal(data.objectFit, "contain", scenario);
  assert.equal(data.filter, "none", scenario);
  assert.equal(data.borderRadius, "0px", scenario);
  logoChecks.push({ scenario, ...data });
  return data;
}

async function inspectPageLogo(page, selector, size, scenario) {
  const logo = page.locator(selector);
  await logo.waitFor();
  const data = await logo.evaluate(async image => {
    await image.decode();
    const style = getComputedStyle(image), rect = image.getBoundingClientRect();
    return { path: new URL(image.currentSrc).pathname, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: rect.width, height: rect.height, objectFit: style.objectFit, filter: style.filter, borderRadius: style.borderRadius };
  });
  return validateLogo(data, size, scenario);
}

function allNodes(node) { return [node, ...(node.children || []).flatMap(allNodes), ...(node.shadowRoots || []).flatMap(allNodes)]; }
async function inspectPromptLogo(page, hostId, size, scenario) {
  await settle(page);
  const cdp = await page.context().newCDPSession(page);
  try {
    const tree = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const host = allNodes(tree.root).find(node => node.attributes?.includes(hostId));
    assert.ok(host?.shadowRoots?.[0], `Missing prompt: ${hostId}`);
    const resolved = await cdp.send("DOM.resolveNode", { nodeId: host.shadowRoots[0].nodeId });
    const result = await cdp.send("Runtime.callFunctionOn", { objectId: resolved.object.objectId, awaitPromise: true, returnByValue: true, functionDeclaration: `async function() {
      const image = this.querySelector('header img.brand-logo');
      if (!image) throw new Error('Prompt is missing the official logo');
      await image.decode();
      const style = getComputedStyle(image), rect = image.getBoundingClientRect();
      const button = this.querySelector('button.primary')?.getBoundingClientRect();
      return { path: new URL(image.currentSrc).pathname, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, width: rect.width, height: rect.height, objectFit: style.objectFit, filter: style.filter, borderRadius: style.borderRadius, confirm: button ? {x:button.x+button.width/2,y:button.y+button.height/2} : null };
    }` });
    assert.ok(result.result.value, "Logo verification failed");
    return validateLogo(result.result.value, size, scenario);
  } finally { await cdp.detach(); }
}

function passkeyDemoPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Monica Passkey 演示</title><style>body{margin:0;background:#f5f5f3;color:#191919;font:16px/1.6 system-ui}main{max-width:760px;margin:80px auto;padding:24px}button{padding:14px 20px;margin:8px 8px 8px 0;border:1px solid #ccc;border-radius:8px;background:white;font:inherit}h1{font-size:38px;font-weight:500}p{color:#666}output{display:block;margin-top:20px}</style><main><h1>使用 Passkey 登录</h1><p>演示页面 · 所有账户均为虚构数据</p><button id="register">创建示例 Passkey</button><button id="authenticate">使用示例 Passkey</button><output id="result"></output></main><script>
    register.onclick=async()=>{try{await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rp:{id:'passkey-demo.example.test',name:'Monica Demo'},user:{id:new Uint8Array([1,2,3,4]),name:'demo@example.test',displayName:'Demo User'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'preferred',userVerification:'discouraged'},timeout:120000}});result.textContent='registered'}catch(error){result.textContent=error.name}};
    authenticate.onclick=async()=>{try{await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),rpId:'passkey-demo.example.test',userVerification:'discouraged',timeout:120000}});result.textContent='authenticated'}catch(error){result.textContent=error.name}};
  </script></html>`;
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
  return `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width"><title>示例登录页</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f3ef;font:16px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif;color:#1a1a1a}.shell{width:min(1080px,calc(100% - 48px));display:grid;grid-template-columns:1.2fr .8fr;gap:64px;align-items:center}.copy h1{font-size:52px;line-height:1.1;margin:0 0 18px}.copy p{font-size:20px;color:#62625e}.card{display:grid;gap:18px;padding:34px;border:1px solid #cdcdc7;border-radius:12px;background:#fff}.card h2{margin:0}.field{display:grid;gap:7px;font-weight:600}.field input{height:52px;border:1px solid #cdcdc7;border-radius:8px;padding:0 16px;font:inherit}.card button{height:52px;border:0;border-radius:26px;background:#1a1a1a;color:white;font:inherit;font-weight:800}</style></head><body><main class="shell"><section class="copy"><h1>示例账号登录</h1><p>这是专用于 Monica 商店截图的合成页面，不包含真实网站或用户数据。</p></section><form class="card" onsubmit="event.preventDefault()"><h2>欢迎回来</h2><label class="field">示例邮箱<input aria-label="示例邮箱" name="username" autocomplete="username"></label><label class="field">示例密码<input aria-label="示例密码" name="password" type="password" autocomplete="current-password"></label><button type="submit">登录示例网站</button></form></main></body></html>`;
}

function popupShowcase(image) {
  return `<!doctype html><html lang="zh-CN"><style>*{box-sizing:border-box}body{margin:0;width:1280px;height:800px;overflow:hidden;background:#f3f3ef;font-family:"Segoe UI","Microsoft YaHei UI",sans-serif;color:#1a1a1a}.stage{height:100%;display:grid;grid-template-columns:1fr 480px;align-items:center;gap:80px;padding:72px 110px}.copy small{color:#1a1a1a;font-size:18px;font-weight:800;letter-spacing:.08em}.copy h1{font-size:54px;line-height:1.12;margin:18px 0}.copy p{font-size:21px;line-height:1.7;color:#62625e}.frame{justify-self:end;padding:18px;border:1px solid #cdcdc7;border-radius:16px;background:#fff}.frame img{display:block;width:390px;border-radius:12px}</style><body><main class="stage"><section class="copy"><small>MONICA 自动填充</small><h1>你的账号<br>随手填写</h1><p>选择账号，一次点击填写。为常用账号开启免解锁填写，密码库锁定时也能使用。</p></section><div class="frame"><img alt="Monica 自动填充 Popup" src="data:image/png;base64,${image}"></div></main></body></html>`;
}
