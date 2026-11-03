import { launchEdgeContext } from "./fixtures/edge";
import { expect, test as base, type BrowserContext, type Page, type Worker } from "@playwright/test";
import path from "node:path";
import { projectLogins } from './fixtures/project-logins';

const hostSelector = "#monica-inline-autofill-host";
const secret = "inline-secret-alpha";
const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body{margin:0;background:#f5f5f3;color:#191919;font:16px system-ui}main{max-width:720px;margin:60px auto;padding:24px}
  form{margin:32px 0 70px;max-width:350px;display:grid;gap:12px}label{display:grid;gap:6px}input{box-sizing:border-box;width:100%;height:46px;border:1px solid #aaa;border-radius:8px;padding:10px;font:inherit;background:white}
  button{height:44px}h1{font-weight:500}#outside{margin:20px 0}#spacer{height:650px}
</style></head><body><main><h1>Monica · Inline autofill</h1><p id="outside">Synthetic sign-in forms</p>
<form id="first"><label>First email<input id="first-user" autocomplete="username"></label><label>First password<input id="first-password" type="password" autocomplete="current-password"></label></form>
<form id="second"><label>Email<input id="username" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label><label>Authenticator<input id="otp" autocomplete="one-time-code"></label><button type="submit">Sign in</button></form>
<div id="spacer"></div><form id="last"><label>Last password<input id="last-password" type="password" autocomplete="current-password"></label></form></main>
<script>document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',event=>event.preventDefault()))</script></body></html>`;

interface App { context: BrowserContext; manager: Page; worker: Worker; extensionId: string; }
const test = base.extend<{ app: App }>({
  app: async ({}, use, info) => {
    const extension = path.resolve("dist");
    const context = await launchEdgeContext(info.outputPath("p"), {
      channel: "chromium", headless: true, locale: "zh-CN", viewport: { width: 1100, height: 1000 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
      const extensionId = new URL(worker.url()).host;
      const manager = await context.newPage();
      await manager.goto(`chrome-extension://${extensionId}/index.html`);
      expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "Inline autofill synthetic password" }))).toMatchObject({ ok: true });
      const now = new Date().toISOString();
      for (const [id, title, username, password, uri, favorite] of [
        ["inline-alpha", "Mail account", "alpha@example.test", secret, "https://inline.example.test", true],
        ["inline-bravo", "Work account", "bravo@example.test", "inline-secret-bravo", "https://inline.example.test", false],
        ["inline-frame", "Frame account", "frame-user", "frame-secret", "https://frame.example.net", false]
      ] as const) {
        expect(await manager.evaluate(item => chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item }), {
          id, kind: "login", title, username, password, uris: [uri], favorite, notes: "", createdAt: now, updatedAt: now,
          providerRefs: [], customFields: [], ...(id === "inline-alpha" ? { totpSecret: "JBSWY3DPEHPK3PXP" } : {})
        })).toMatchObject({ ok: true });
      }
      await context.route("https://inline.example.test/**", route => route.fulfill({ contentType: "text/html", body: pageHtml }));
      await use({ context, manager, worker, extensionId });
    } finally { await context.close(); }
  }
});

test('distinguishes project passwords before site filtering and fills the chosen member by keyboard', async ({ app }, info) => {
  expect(await app.manager.evaluate(items => chrome.runtime.sendMessage({type: 'VAULT_IMPORT_ITEMS', items}), projectLogins('https://inline.example.test'))).toMatchObject({ok: true});
  const page = await target(app);
  await page.setViewportSize({width: 320, height: 880});
  await page.emulateMedia({colorScheme: 'dark'});
  await open(page);
  const state = await menu(page);
  expect(state.text).toContain('密码 2 · 工作账户');
  expect(state.text).toContain('密码 3 · 备用账户');
  expect(state.text).not.toContain('密码 1');
  for (const privateValue of ['project-secret-', 'private-project-note', 'monica.content.', '00000000-']) expect(state.text).not.toContain(privateValue);
  await page.screenshot({path: info.outputPath('project-inline-320.png'), animations: 'disabled'});
  const selectedIndex = state.buttons.slice(1, -1).findIndex(button => button.text.includes('密码 2'));
  expect(selectedIndex).toBeGreaterThanOrEqual(0);
  for (let index = 0; index <= selectedIndex; index++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#password')).toHaveValue('project-secret-2');
  await expect(page.locator('#username')).toHaveValue('same-account@example.test');
  expect(await app.manager.evaluate(() => chrome.runtime.sendMessage({type: 'VAULT_SET_LOCKED_AUTOFILL', itemId: 'project-password-2', enabled: true}))).toMatchObject({ok: true});
  expect(await app.manager.evaluate(() => chrome.runtime.sendMessage({type: 'VAULT_LOCK'}))).toMatchObject({ok: true});
  await open(page);
  const locked = await menu(page);
  expect(locked.suggestions).toBe(1);
  expect(locked.text).toContain('密码 2 · 工作账户');
  expect(locked.text).not.toContain('备用账户');
  await page.locator('#password').fill('');
  await open(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#password')).toHaveValue('project-secret-2');
});

async function target(app: App) {
  const page = await app.context.newPage();
  await page.goto("https://inline.example.test/login");
  return page;
}
async function open(page: Page, selector = "#username") {
  await page.bringToFront();
  await page.locator(selector).click();
  await expect(page.locator(hostSelector)).toBeVisible();
}

interface DomNode { nodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[]; }
function flatten(node: DomNode): DomNode[] { return [node, ...(node.children || []).flatMap(flatten), ...(node.shadowRoots || []).flatMap(flatten)]; }
async function closedRoot(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const document = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const host = flatten(document.root).find(node => node.attributes?.includes("monica-inline-autofill-host"));
  expect(host?.shadowRoots?.[0]).toBeTruthy();
  const node = await cdp.send("DOM.resolveNode", { nodeId: host!.shadowRoots![0].nodeId });
  return { cdp, objectId: node.object.objectId! };
}
async function menu(page: Page): Promise<{ text: string; language: string; suggestions: number; buttons: Array<{ text: string; x: number; y: number }> }> {
  const { cdp, objectId } = await closedRoot(page);
  try {
    const result = await cdp.send("Runtime.callFunctionOn", { objectId, returnByValue: true, functionDeclaration: `function(){ return {text:this.querySelector('.panel').textContent,language:this.querySelector('.panel').lang,suggestions:this.querySelectorAll('.suggestion').length,buttons:[...this.querySelectorAll('button')].map(button=>{const r=button.getBoundingClientRect();return {text:button.textContent,x:r.x+r.width/2,y:r.y+r.height/2}})}; }` });
    return result.result.value;
  } finally { await cdp.detach(); }
}
async function clickMenu(page: Page, text: string) {
  const entry = (await menu(page)).buttons.find(button => button.text.includes(text));
  expect(entry).toBeDefined();
  await page.mouse.click(entry!.x, entry!.y);
}

test('HOTP autofill preserves intervening edits and advances only the used Android credential group', async ({ app }, info) => {
  const otp = 'otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=0';
  const rows = projectLogins('https://inline.example.test').map(item => ({ ...item, totpSecret: otp }));
  expect(await app.manager.evaluate(items => chrome.runtime.sendMessage({ type: 'VAULT_IMPORT_ITEMS', items }), rows)).toMatchObject({ ok: true });
  await app.worker.evaluate(() => {
    const gate = globalThis as unknown as { hotpFillGate: { pending: boolean; release?: () => void; restore: () => void } };
    const send = chrome.tabs.sendMessage;
    gate.hotpFillGate = { pending: false, restore: () => { chrome.tabs.sendMessage = send; } };
    chrome.tabs.sendMessage = (async (...args: unknown[]) => {
      const response = await Reflect.apply(send, chrome.tabs, args);
      if ((args[1] as { type?: string })?.type === 'MONICA_FILL_INLINE_CREDENTIAL') {
        gate.hotpFillGate.pending = true;
        await new Promise<void>(resolve => { gate.hotpFillGate.release = resolve; });
      }
      return response;
    }) as typeof chrome.tabs.sendMessage;
  });
  const page = await target(app);
  try {
    await open(page, '#otp');
    await clickMenu(page, '密码 2');
    await expect(page.locator('#otp')).toHaveValue('755224'); // RFC 4226 vector, actual content-script write.
    await expect(page.locator('#password')).toHaveValue('');
    await expect.poll(() => app.worker.evaluate(() => (globalThis as unknown as { hotpFillGate: { pending: boolean } }).hotpFillGate.pending)).toBe(true);
    expect(await app.manager.evaluate(async () => {
      const current = (await chrome.runtime.sendMessage({ type: 'VAULT_GET_ITEM', itemId: 'project-password-2' })).data;
      return chrome.runtime.sendMessage({ type: 'VAULT_UPSERT_ITEM', item: { ...current, password: 'edited-during-fill', notes: 'later notes retained' } });
    })).toMatchObject({ ok: true });
    await app.worker.evaluate(() => {
      const gate = (globalThis as unknown as { hotpFillGate: { release?: () => void; restore: () => void } }).hotpFillGate;
      gate.restore(); gate.release!();
    });
    const read = () => app.manager.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' })).data);
    await expect.poll(async () => {
      const current = await read();
      return ['project-password-1', 'project-password-2'].map(id => new URL(current.find((row: { id: string }) => row.id === id).totpSecret).searchParams.get('counter'));
    }).toEqual(['1', '1']);
    const current = await read();
    expect(current.find((row: { id: string }) => row.id === 'project-password-2')).toMatchObject({ password: 'edited-during-fill', notes: 'later notes retained' });
    for (const id of ['project-password-3', 'independent-project']) {
      expect(new URL(current.find((row: { id: string }) => row.id === id).totpSecret).searchParams.get('counter')).toBe('0');
    }
    await open(page, '#otp');
    await clickMenu(page, '密码 2');
    await expect(page.locator('#otp')).toHaveValue('287082');
    await expect.poll(async () => new URL((await read()).find((row: { id: string }) => row.id === 'project-password-2').totpSecret).searchParams.get('counter')).toBe('2');
    // A successful password fill that has no OTP field must not consume HOTP.
    await page.locator('#otp').evaluate(input => input.remove());
    await open(page);
    await clickMenu(page, '密码 2');
    await expect(page.locator('#password')).toHaveValue('edited-during-fill');
    await expect(page.locator(hostSelector)).toHaveCount(0);
    expect(new URL((await read()).find((row: { id: string }) => row.id === 'project-password-2').totpSecret).searchParams.get('counter')).toBe('2');
    const popup = await app.context.newPage();
    await popup.goto(`chrome-extension://${app.extensionId}/popup.html`);
    expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_CONSUME_HOTP', usage: {} }))).toMatchObject({ ok: false });
    await popup.close();
    await page.screenshot({ path: info.outputPath('hotp-real-fill.png') });
    await info.attach('hotp-current-synthetic-state', { body: JSON.stringify(await read(), null, 2), contentType: 'application/json' });
  } finally {
    await app.worker.evaluate(() => {
      const gate = (globalThis as unknown as { hotpFillGate?: { release?: () => void; restore: () => void } }).hotpFillGate;
      gate?.restore(); gate?.release?.();
    });
  }
  await app.context.close();
  const extension = path.resolve('dist');
  const restarted = await launchEdgeContext(info.outputPath('p'), {
    locale: 'zh-CN', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = restarted.serviceWorkers()[0] || await restarted.waitForEvent('serviceworker');
    const manager = await restarted.newPage();
    await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_UNLOCK', masterPassword: 'Inline autofill synthetic password' }))).toMatchObject({ ok: true });
    for (const itemId of ['project-password-1', 'project-password-2']) {
      const result = await manager.evaluate(itemId => chrome.runtime.sendMessage({ type: 'VAULT_GET_ITEM', itemId }), itemId);
      expect(result.ok).toBe(true);
      expect(new URL(result.data.totpSecret).searchParams.get('counter')).toBe('2');
      if (itemId === 'project-password-2') expect(result.data).toMatchObject({ password: 'edited-during-fill', notes: 'later notes retained' });
    }
  } finally { await restarted.close(); }
});

test("anchors to the selected form, supports keyboard filling and sends no secrets in menu markup", async ({ app }, info) => {
  const page = await target(app);
  await open(page);
  const field = await page.locator("#username").boundingBox();
  const box = await page.locator(hostSelector).boundingBox();
  expect(Math.abs(box!.x - field!.x)).toBeLessThan(2);
  expect(Math.abs(box!.y - field!.y - field!.height - 6)).toBeLessThan(2);
  const state = await menu(page);
  expect(state.suggestions).toBe(2);
  expect(state.text).toContain("Mail account");
  for (const value of [secret, "inline-secret-bravo", "JBSWY3DPEHPK3PXP", "Frame account"]) expect(state.text).not.toContain(value);
  expect(await page.locator(hostSelector).evaluate(host => host.shadowRoot)).toBeNull();
  await page.screenshot({ path: info.outputPath("inline-light.png"), animations: "disabled" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("#username")).toHaveValue("alpha@example.test");
  await expect(page.locator("#password")).toHaveValue(secret);
  await expect(page.locator("#first-user")).toHaveValue("");
  await expect(page.locator("#first-password")).toHaveValue("");
  await expect(page.locator(hostSelector)).toHaveCount(0);
  await open(page);
  await clickMenu(page, "Work account");
  await expect(page.locator("#username")).toHaveValue("bravo@example.test");
  await expect(page.locator("#password")).toHaveValue("inline-secret-bravo");
});

test("flips above a bottom field, follows scrolling, and dismisses on escape, typing and removal", async ({ app }, info) => {
  const page = await target(app);
  await page.setViewportSize({ width: 390, height: 700 });
  await page.locator("#last-password").evaluate(input => input.scrollIntoView({ block: "end" }));
  await open(page, "#last-password");
  await expect(page.locator(hostSelector)).toHaveAttribute("data-placement", "above");
  const before = await page.locator(hostSelector).boundingBox();
  expect(before!.x).toBeGreaterThanOrEqual(8);
  expect(before!.x + before!.width).toBeLessThanOrEqual(382);
  await page.evaluate(() => window.scrollBy(0, -30));
  await expect.poll(async () => {
    const box = await page.locator(hostSelector).boundingBox();
    const input = await page.locator("#last-password").boundingBox();
    return Math.abs(input!.y - box!.y - box!.height - 6);
  }).toBeLessThan(2);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({ path: info.outputPath("inline-dark-narrow.png"), animations: "disabled" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.locator(hostSelector)).toHaveCount(0);
  await expect(page.locator("#last-password")).toBeFocused();
  await open(page, "#last-password");
  await page.keyboard.type("x");
  await expect(page.locator(hostSelector)).toHaveCount(0);
  await open(page, "#last-password");
  await page.locator("#last").evaluate(form => form.remove());
  await expect(page.locator(hostSelector)).toHaveCount(0);
});

test("settings switch persists and disables existing pages while toolbar filling remains available", async ({ app }) => {
  const page = await target(app);
  await open(page);
  await app.worker.evaluate(() => chrome.storage.local.set({ "monica.autofill.inline.enabled": false }));
  await expect(page.locator(hostSelector)).toHaveCount(0);
  await page.locator("#password").click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(hostSelector)).toHaveCount(0);
  await app.manager.reload();
  await app.manager.getByRole("button", { name: "设置与备份", exact: true }).click();
  const toggle = app.manager.getByRole("switch", { name: "表单旁自动填充" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.focus();
  await app.manager.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toBeFocused();
  await app.manager.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeFocused();
  await app.manager.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(toggle).toBeFocused();
  await open(page);
  await app.worker.evaluate(() => chrome.storage.local.set({ "monica.autofill.inline.enabled": false }));
  await page.reload();
  await page.locator("#username").click();
  await expect(page.locator(hostSelector)).toHaveCount(0);
  const tabId = await app.manager.evaluate(async () => (await chrome.tabs.query({ url: "https://inline.example.test/*" }))[0].id);
  expect(await app.manager.evaluate(tabId => chrome.runtime.sendMessage({ type: "VAULT_FILL_LOGIN", itemId: "inline-alpha", tabId }), tabId)).toMatchObject({ ok: true });
  await expect(page.locator("#password")).toHaveValue(secret);
});

test("locked menus expose only explicit grants and open the trusted manager to unlock other logins", async ({ app }) => {
  expect(await app.manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_SET_LOCKED_AUTOFILL", itemId: "inline-alpha", enabled: true }))).toMatchObject({ ok: true });
  expect(await app.manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
  const page = await target(app);
  await open(page);
  expect((await menu(page)).suggestions).toBe(1);
  expect((await menu(page)).text).toContain("免解锁填写");
  expect((await menu(page)).text).not.toContain("Work account");
  await clickMenu(page, "Mail account");
  await expect(page.locator("#password")).toHaveValue(secret);
  await expect(page.locator("#otp")).toHaveValue("");
  await open(page, "#otp");
  expect((await menu(page)).suggestions).toBe(0);
  const opened = app.context.waitForEvent("page");
  await clickMenu(page, "解锁 Monica");
  const manager = await opened;
  await expect(manager).toHaveURL(`chrome-extension://${app.extensionId}/index.html`);
  await expect(manager.getByRole("heading", { name: "解锁 Monica" })).toBeVisible();
});

test("OTP selection preserves typed login fields and block rules suppress the menu", async ({ app }) => {
  const page = await target(app);
  await page.locator("#username").fill("keep-this-user");
  await page.locator("#password").fill("keep-this-password");
  await open(page, "#otp");
  expect((await menu(page)).suggestions).toBe(1);
  await clickMenu(page, "Mail account");
  await expect(page.locator("#otp")).toHaveValue(/^\d{6}$/);
  await expect(page.locator("#username")).toHaveValue("keep-this-user");
  await expect(page.locator("#password")).toHaveValue("keep-this-password");
  const tabId = await app.manager.evaluate(async () => (await chrome.tabs.query({ url: "https://inline.example.test/*" }))[0].id);
  await open(page);
  expect(await app.manager.evaluate(tabId => chrome.runtime.sendMessage({ type: "AUTOFILL_FIELD_POLICY_SET_CURRENT", tabId, blocked: true }), tabId)).toMatchObject({ ok: true });
  await expect(page.locator(hostSelector)).toHaveCount(0);
  await page.locator("#username").click();
  await page.waitForTimeout(200);
  await expect(page.locator(hostSelector)).toHaveCount(0);
  expect(await app.manager.evaluate(() => chrome.runtime.sendMessage({ type: "AUTOFILL_SITE_POLICY_SET", policy: { blockedHosts: ["inline.example.test"], saveBlockedHosts: [] } }))).toMatchObject({ ok: true });
  await page.locator("#password").click();
  await page.waitForTimeout(200);
  await expect(page.locator(hostSelector)).toHaveCount(0);
});

test("dynamic open shadow forms use the focused component and frames match their own origin", async ({ app }) => {
  const page = await target(app);
  await page.evaluate(() => {
    document.querySelector("main")!.replaceChildren();
    const host = document.createElement("div");
    document.querySelector("main")!.append(host);
    host.attachShadow({ mode: "open" }).innerHTML = '<form><label>Shadow email<input autocomplete="username" style="height:44px;width:260px"></label><input aria-label="Shadow password" type="password" autocomplete="current-password" style="height:44px;width:260px"></form>';
  });
  await page.getByLabel("Shadow email").click();
  await expect(page.locator(hostSelector)).toBeVisible();
  await clickMenu(page, "Mail account");
  await expect(page.getByLabel("Shadow password")).toHaveValue(secret);
  await app.context.route("https://frame.example.net/**", route => route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><form><input id="frame-user" autocomplete="username" style="height:44px"><input id="frame-password" type="password" autocomplete="current-password" style="height:44px"></form></body></html>' }));
  await page.evaluate(() => { const frame = document.createElement("iframe"); frame.src = "https://frame.example.net/login"; frame.width = "360"; frame.height = "400"; document.querySelector("main")!.append(frame); });
  const frame = page.frameLocator("iframe");
  await frame.locator("#frame-user").click();
  await expect(frame.locator(hostSelector)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(frame.locator("#frame-user")).toHaveValue("frame-user");
  await expect(frame.locator("#frame-password")).toHaveValue("frame-secret");
});

test("untrusted clicks and manager impersonation cannot fill, and locking clears visible summaries", async ({ app }) => {
  const page = await target(app);
  await open(page);
  const { cdp, objectId } = await closedRoot(page);
  await cdp.send("Runtime.callFunctionOn", { objectId, functionDeclaration: "function(){this.querySelector('.suggestion').click();}" });
  await cdp.detach();
  await expect(page.locator("#password")).toHaveValue("");
  expect(await app.manager.evaluate(() => chrome.runtime.sendMessage({ type: "AUTOFILL_INLINE_FILL", sessionId: crypto.randomUUID(), itemId: "inline-alpha" }))).toMatchObject({ ok: false });
  expect(await app.manager.evaluate(() => chrome.runtime.sendMessage({ type: "AUTOFILL_INLINE_QUERY", sessionId: crypto.randomUUID() }))).toMatchObject({ ok: false });
  expect(await app.manager.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LOCK" }))).toMatchObject({ ok: true });
  await expect(page.locator(hostSelector)).toHaveCount(0);
  await open(page);
  expect((await menu(page)).suggestions).toBe(0);
  expect((await menu(page)).text).not.toContain("alpha@example.test");
});

test("eight languages fit a narrow menu in both themes without changing account names", async ({ app }, info) => {
  const items = projectLogins('https://inline.example.test').map(item => ({...item, customFields: item.customFields.map(field => {
    const metadata = JSON.parse(field.value);
    return {...field, value: JSON.stringify({...metadata, label: metadata.primary ? 'Work team account' : 'Backup team account'})};
  })}));
  expect(await app.manager.evaluate(items => chrome.runtime.sendMessage({type: 'VAULT_IMPORT_ITEMS', items}), items)).toMatchObject({ok: true});
  const numbered: Record<string, string> = {'zh-CN': '密码 2', en: 'Password 2', ja: 'パスワード 2', ko: '비밀번호 2',
    de: 'Passwort 2', es: 'Contraseña 2', ru: 'Пароль 2', vi: 'Mật khẩu 2'};
  const page = await target(app);
  await page.setViewportSize({ width: 320, height: 568 });
  await open(page, "#first-user");
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const locale of ["zh-CN", "en", "ja", "ko", "de", "es", "ru", "vi"]) {
      await app.worker.evaluate(locale => chrome.storage.local.set({ "monica.locale": locale }), locale);
      await expect.poll(async () => (await menu(page)).language).toBe(locale);
      const content = await menu(page);
      expect(content.text).toContain("alpha@example.test");
      expect(content.text).toContain(`${numbered[locale]} · Work team account`);
      if (["en", "de", "es", "ru", "vi"].includes(locale)) expect(content.text).not.toMatch(/[\u3400-\u9fff]/);
      const bounds = await page.locator(hostSelector).boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(8);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(312);
      expect(bounds!.y).toBeGreaterThanOrEqual(8);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(560);
      const {cdp, objectId} = await closedRoot(page);
      try {
        await cdp.send('Runtime.callFunctionOn', {objectId, functionDeclaration: "function(){this.querySelector('.credential-identity').scrollIntoView({block:'center'});}"});
      } finally { await cdp.detach(); }
      await page.screenshot({ path: info.outputPath(`inline-${theme}-${locale}.png`), animations: "disabled" });
    }
  }
});

test("large match sets stay bounded and keyboard users can reach the footer", async ({ app }) => {
  const now = new Date().toISOString();
  expect(await app.manager.evaluate(items => chrome.runtime.sendMessage({ type: "VAULT_IMPORT_ITEMS", items }), Array.from({ length: 45 }, (_, index) => ({
    id: `inline-many-${index}`, kind: "login", title: `Additional account ${index}`, username: `user-${index}`, password: "synthetic-many-secret",
    uris: ["https://inline.example.test"], favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: [], customFields: []
  })))).toMatchObject({ ok: true });
  const page = await target(app);
  await open(page);
  expect((await menu(page)).suggestions).toBe(20);
  expect((await menu(page)).text).toContain("共 47 项");
  const box = await page.locator(hostSelector).boundingBox();
  expect(box!.height).toBeLessThanOrEqual(360);
  await page.keyboard.press("ArrowUp");
  const entry = (await menu(page)).buttons.find(button => button.text === "打开 Monica")!;
  expect(entry.y).toBeGreaterThan(box!.y);
  expect(entry.y).toBeLessThan(box!.y + box!.height);
  await page.keyboard.press("Escape");
  await expect(page.locator("#username")).toBeFocused();
});

test("new passwords, readonly fields, offscreen fields and insecure origins do not open suggestions", async ({ app }) => {
  const page = await target(app);
  await page.evaluate(() => {
    document.querySelector("main")!.innerHTML = '<input id="new-password" type="password" autocomplete="new-password" style="height:44px"><input id="readonly" autocomplete="username" readonly style="height:44px"><input id="hidden-password" type="password" autocomplete="current-password" style="position:fixed;left:-2000px;top:100px;height:44px">';
  });
  for (const selector of ["#new-password", "#readonly"]) {
    await page.locator(selector).click();
    await page.waitForTimeout(100);
    await expect(page.locator(hostSelector)).toHaveCount(0);
  }
  await page.locator("#hidden-password").evaluate(input => (input as HTMLInputElement).focus());
  await page.waitForTimeout(100);
  await expect(page.locator(hostSelector)).toHaveCount(0);
  await app.context.route("http://inline.example.test/**", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: pageHtml }));
  await page.goto("http://inline.example.test/login");
  await page.locator("#username").click();
  await page.waitForTimeout(200);
  await expect(page.locator(hostSelector)).toHaveCount(0);
});
