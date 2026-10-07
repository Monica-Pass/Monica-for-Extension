import { launchEdgeContext } from "./fixtures/edge";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";
import { dialogContent } from "./fixtures/material";
import { projectLogins } from './fixtures/project-logins';

const masterPassword = "locked autofill test master password";
const site = "https://selected.example.test/login";
const extensionPath = path.resolve("dist");

test('project labels remain identifiable in popup search, locked grant subsets and a real browser restart', async ({}, info) => {
  const profile = info.outputPath('project-profile');
  let fixture = await launch(profile);
  try {
    expect(await request(fixture.manager, {type: 'VAULT_SETUP', masterPassword})).toMatchObject({ok: true});
    expect(await request(fixture.manager, {type: 'VAULT_IMPORT_ITEMS', items: projectLogins(site)})).toMatchObject({ok: true});
    const summaries = await request(fixture.manager, {type: 'VAULT_LIST_LOGIN_SUMMARIES'});
    expect(summaries).toMatchObject({ok: true});
    expect(summaries.data.find((item: {id: string}) => item.id === 'project-password-2').credentialIdentity).toEqual({passwordNumber: 2, groupLabel: '工作账户'});
    expect(summaries.data.find((item: {id: string}) => item.id === 'independent-project')).not.toHaveProperty('credentialIdentity');
    expect(JSON.stringify(summaries)).not.toMatch(/project-secret-|monica.content|private-project-note/);
    const target = await fixture.context.newPage();
    await target.goto(site);
    const popup = await openPopup(fixture.context, fixture.extensionId, target);
    await popup.setViewportSize({width: 320, height: 880});
    const search = popup.getByRole('searchbox');
    await search.fill('备用账户');
    await expect(popup.locator('.login-row')).toHaveCount(1);
    await expect(popup.locator('.popup-credential-identity')).toHaveText('密码 3 · 备用账户');
    await search.fill('密码 2');
    await expect(popup.locator('.login-row')).toHaveCount(1);
    await popup.screenshot({path: info.outputPath('project-popup-320.png'), animations: 'disabled'});
    expect(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const chosen = popup.getByRole('button', {name: /填充到当前页面.*密码 2/});
    await chosen.focus();
    await popup.keyboard.press('Enter');
    await expect(target.locator('#password')).toHaveValue('project-secret-2');
    expect(await request(fixture.manager, {type: 'VAULT_SET_LOCKED_AUTOFILL', itemId: 'project-password-2', enabled: true})).toMatchObject({ok: true});
    expect(await request(fixture.manager, {type: 'VAULT_LOCK'})).toMatchObject({ok: true});
    await fixture.context.close();
    fixture = await launch(profile);
    expect(await request(fixture.manager, {type: 'VAULT_STATUS'})).toMatchObject({ok: true, data: 'locked'});
    const restarted = await fixture.context.newPage();
    await restarted.goto(site);
    const lockedPopup = await openPopup(fixture.context, fixture.extensionId, restarted);
    await lockedPopup.setViewportSize({width: 320, height: 880});
    await expect(lockedPopup.locator('.login-row')).toHaveCount(1);
    await expect(lockedPopup.locator('.popup-credential-identity')).toHaveText('密码 2 · 工作账户');
    await lockedPopup.screenshot({path: info.outputPath('project-locked-320.png'), animations: 'disabled'});
    await lockedPopup.getByRole('button', {name: /填充到当前页面.*密码 2/}).click();
    await expect(restarted.locator('#password')).toHaveValue('project-secret-2');
    expect(await request(fixture.manager, {type: 'VAULT_UNLOCK', masterPassword})).toMatchObject({ok: true});
    expect(await request(fixture.manager, {type: 'VAULT_SET_LOCKED_AUTOFILL', itemId: 'project-password-2', enabled: false})).toMatchObject({ok: true});
    expect(await request(fixture.manager, {type: 'VAULT_LOCK'})).toMatchObject({ok: true});
    expect(await request(fixture.manager, {type: 'VAULT_MATCH_LOGINS', pageUrl: site})).toEqual({ok: true, data: []});
  } finally { await fixture.context.close(); }
});

async function launch(profile: string) {
  const context = await launchEdgeContext(profile, {
    channel: "chromium", headless: true, locale: "zh-CN",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  await context.route(/https?:\/\/(selected|other)\.example\.test\/.*/, (route) => route.fulfill({
    contentType: "text/html",
    body: '<!doctype html><title>Autofill fixture</title><form><label>Username<input id="username" autocomplete="username"></label><label>Password<input id="password" type="password" autocomplete="current-password"></label><label>Code<input id="otp" autocomplete="one-time-code"></label><label>Private field<input id="custom" aria-label="Private field"></label></form>'
  }));
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  return { context, manager, extensionId };
}

async function request(page: Page, message: Record<string, unknown>) {
  return page.evaluate((value) => chrome.runtime.sendMessage(value), message);
}

async function seed(manager: Page) {
  expect(await request(manager, { type: "VAULT_SETUP", masterPassword })).toMatchObject({ ok: true });
  const now = new Date().toISOString();
  for (const id of ["selected", "protected"]) {
    expect(await request(manager, { type: "VAULT_UPSERT_ITEM", item: {
      id, kind: "login", title: id === "selected" ? "Marked account" : "Protected account",
      username: `${id}-user`, password: `${id}-secret`, uris: [site], uriRules: [{ uri: site, matchType: "exact" }],
      favorite: false, notes: "Private note", createdAt: now, updatedAt: now, providerRefs: [],
      totpSecret: "JBSWY3DPEHPK3PXP", customFields: [{ name: "Private field", value: "private-custom-value", protected: true }]
    } })).toMatchObject({ ok: true });
  }
}

async function openPopup(context: BrowserContext, extensionId: string, target: Page) {
  const popup = await context.newPage();
  await target.bringToFront();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  return popup;
}

test("locking discards delayed unlocked matches in an already open popup", async ({}, testInfo) => {
  const { context, manager, extensionId } = await launch(testInfo.outputPath("delayed-match-profile"));
  try {
    await seed(manager);
    expect(await request(manager, { type: "VAULT_SET_LOCKED_AUTOFILL", itemId: "selected", enabled: true })).toMatchObject({ ok: true });
    const target = await context.newPage();
    await target.goto(site);
    const popup = await context.newPage();
    await popup.addInitScript(() => {
      const state = window as typeof window & { heldMatches?: boolean; releaseMatches?: () => void };
      const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
      let delayed = false;
      chrome.runtime.sendMessage = (async (message: { type?: string }) => {
        const response = await sendMessage(message);
        if (message.type !== "VAULT_MATCH_LOGINS" || delayed) return response;
        delayed = true;
        return new Promise((resolve) => {
          state.releaseMatches = () => resolve(response);
          state.heldMatches = true;
        });
      }) as typeof chrome.runtime.sendMessage;
    });
    await target.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(() => (window as typeof window & { heldMatches?: boolean }).heldMatches);
    expect(await request(manager, { type: "VAULT_LOCK" })).toMatchObject({ ok: true });
    await expect(popup.locator(".locked-autofill-section").getByRole("button", { name: /Marked account/ })).toBeVisible();
    await popup.evaluate(async () => {
      (window as typeof window & { releaseMatches?: () => void }).releaseMatches!();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(popup.getByText("Protected account", { exact: true })).toHaveCount(0);
    await expect(popup.getByLabel("搜索全部登录项")).toHaveCount(0);
    await expect(popup.locator(".locked-autofill-section").getByRole("button", { name: /Marked account/ })).toBeVisible();
  } finally { await context.close(); }
});

test("editor opt-in fills only the selected password while locked, survives browser restart and can be revoked", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const profile = testInfo.outputPath("locked-fill-profile");
  let context: BrowserContext | undefined;
  try {
    let fixture = await launch(profile);
    context = fixture.context;
    await seed(fixture.manager);
    await fixture.manager.reload();
    await fixture.manager.locator(".sidebar").getByRole("button", { name: /^登录项/ }).click();
    const row = fixture.manager.locator(".row-clickable").filter({ hasText: "Marked account" });
    await row.getByRole("button", { name: "编辑登录项", exact: true }).click();
    const editor = fixture.manager.locator("m3e-dialog.material-editor-dialog");
    await expect(editor.getByRole("heading", { name: /^编辑/ })).toBeVisible();
    await editor.locator(".editor-disclosure [slot=\"header\"]").filter({ hasText: "更多选项" }).click();
    await editor.getByRole("checkbox", { name: /允许免解锁填写/ }).check();
    await editor.getByRole("button", { name: "加密保存", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(row.locator(".locked-autofill-badge")).toContainText("免解锁填写");
    expect(await request(fixture.manager, { type: "VAULT_LOCK" })).toMatchObject({ ok: true });

    const target = await context.newPage();
    await target.goto(site);
    const popup = await openPopup(context, fixture.extensionId, target);
    await expect(popup.getByRole("button", { name: /Marked account/ })).toBeVisible();
    await expect(popup.getByText("Protected account", { exact: true })).toHaveCount(0);
    await popup.getByRole("button", { name: /Marked account/ }).click();
    await expect(target.locator("#username")).toHaveValue("selected-user");
    await expect(target.locator("#password")).toHaveValue("selected-secret");
    await expect(target.locator("#otp")).toHaveValue("");
    await expect(target.locator("#custom")).toHaveValue("");
    expect(await request(fixture.manager, { type: "VAULT_STATUS" })).toMatchObject({ ok: true, data: "locked" });
    for (const message of [
      { type: "VAULT_LIST_ITEMS" },
      { type: "VAULT_LIST_LOGIN_SUMMARIES" },
      { type: "VAULT_LOGIN_SECRET", itemId: "selected", field: "password" },
      { type: "VAULT_MATCH_PASSKEYS", pageUrl: site },
      { type: "VAULT_SET_LOCKED_AUTOFILL", itemId: "protected", enabled: true }
    ]) expect(await request(fixture.manager, message)).toMatchObject({ ok: false });
    await popup.screenshot({ path: testInfo.outputPath("locked-autofill-popup.png") });

    await context.close();
    fixture = await launch(profile);
    context = fixture.context;
    expect(await request(fixture.manager, { type: "VAULT_STATUS" })).toMatchObject({ ok: true, data: "locked" });
    const restartedTarget = await context.newPage();
    await restartedTarget.goto(site);
    const restartedPopup = await openPopup(context, fixture.extensionId, restartedTarget);
    await restartedPopup.getByRole("button", { name: /Marked account/ }).click();
    await expect(restartedTarget.locator("#password")).toHaveValue("selected-secret");
    expect(await request(fixture.manager, { type: "VAULT_STATUS" })).toMatchObject({ ok: true, data: "locked" });

    expect(await request(fixture.manager, { type: "VAULT_UNLOCK", masterPassword })).toMatchObject({ ok: true });
    expect(await request(fixture.manager, { type: "VAULT_SET_LOCKED_AUTOFILL", itemId: "selected", enabled: false })).toMatchObject({ ok: true });
    expect(await request(fixture.manager, { type: "VAULT_LOCK" })).toMatchObject({ ok: true });
    await restartedTarget.bringToFront();
    await restartedPopup.reload();
    await expect(restartedPopup.getByText("Marked account", { exact: true })).toHaveCount(0);
  } finally { await context?.close(); }
});

test("locked fills enforce matching, document identity, secure origins and website and field exclusions", async ({}, testInfo) => {
  const fixture = await launch(testInfo.outputPath("locked-policy-profile"));
  const { context, manager } = fixture;
  try {
    await seed(manager);
    expect(await request(manager, { type: "VAULT_SET_LOCKED_AUTOFILL", itemId: "selected", enabled: true })).toMatchObject({ ok: true });
    expect(await request(manager, { type: "VAULT_LOCK" })).toMatchObject({ ok: true });
    const target = await context.newPage();
    await target.goto(site);
    await target.bringToFront();
    const tabId = await manager.evaluate(async () => (await chrome.tabs.query({ url: "https://selected.example.test/*" }))[0].id!);
    const fill = (extra = {}) => request(manager, { type: "VAULT_FILL_LOGIN", itemId: "selected", tabId, ...extra });
    for (const extra of [{ itemId: "protected" }, { documentId: "stale-document" }, { expectedOrigin: "https://other.example.test" }]) {
      expect(await fill(extra)).toMatchObject({ ok: false });
      await expect(target.locator("#password")).toHaveValue("");
    }
    for (const url of ["https://other.example.test/login", "http://selected.example.test/login"]) {
      await target.goto(url);
      await target.bringToFront();
      expect(await fill()).toMatchObject({ ok: false });
      await expect(target.locator("#password")).toHaveValue("");
    }
    await target.goto(site);
    await target.bringToFront();
    expect(await request(manager, { type: "VAULT_UNLOCK", masterPassword })).toMatchObject({ ok: true });
    expect(await request(manager, { type: "AUTOFILL_SITE_POLICY_SET", policy: { blockedHosts: ["selected.example.test"], saveBlockedHosts: [] } })).toMatchObject({ ok: true });
    expect(await request(manager, { type: "VAULT_LOCK" })).toMatchObject({ ok: true });
    expect(await fill()).toMatchObject({ ok: false });
    expect(await request(manager, { type: "VAULT_MATCH_LOGINS", pageUrl: site })).toMatchObject({ ok: true, data: [] });

    expect(await request(manager, { type: "VAULT_UNLOCK", masterPassword })).toMatchObject({ ok: true });
    expect(await request(manager, { type: "AUTOFILL_SITE_POLICY_SET", policy: { blockedHosts: [], saveBlockedHosts: [] } })).toMatchObject({ ok: true });
    await target.locator("#password").focus();
    expect(await request(manager, { type: "AUTOFILL_FIELD_POLICY_SET_CURRENT", blocked: true, tabId })).toMatchObject({ ok: true });
    expect(await request(manager, { type: "VAULT_LOCK" })).toMatchObject({ ok: true });
    expect(await fill()).toMatchObject({ ok: false });
    await expect(target.locator("#password")).toHaveValue("");
  } finally { await context.close(); }
});
