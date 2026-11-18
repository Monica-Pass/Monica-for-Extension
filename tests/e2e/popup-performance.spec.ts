import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

async function setup(context: BrowserContext, count = 2) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const root = `chrome-extension://${new URL(worker.url()).host}`;
  const manager = await context.newPage();
  await manager.goto(`${root}/index.html`);
  expect(await manager.evaluate(async count => {
    const setup = await chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: 'Synthetic performance acceptance password' });
    if (!setup.ok) return setup;
    const now = new Date().toISOString();
    const items = Array.from({ length: count }, (_, index) => ({
      id: `performance-${index}`, kind: 'login', title: index === 0 ? 'Fast candidate' : `Account ${String(index).padStart(5, '0')}`,
      username: `synthetic-${index}`, password: 'synthetic-password', uris: [index === 0 ? 'https://login.example.test' : 'https://unrelated.invalid'],
      favorite: false, notes: '', providerRefs: [], customFields: [], createdAt: now, updatedAt: now
    }));
    return chrome.runtime.sendMessage({ type: 'VAULT_IMPORT_ITEMS', items });
  }, count)).toMatchObject({ ok: true });
  return { root, manager };
}

async function delayedPopup(context: BrowserContext, root: string): Promise<Page> {
  await context.route('https://login.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><label>Username<input autocomplete="username"></label><label>Password<input type="password" autocomplete="current-password"></label>' }));
  const site = await context.newPage(); await site.goto('https://login.example.test');
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 390, height: 600 });
  await popup.addInitScript(() => {
    const held: Array<() => void> = [];
    let released = false;
    (window as any).__releasePopupQueries = () => { released = true; for (const done of held.splice(0).reverse()) done(); };
    (window as any).__heldPopupQueries = () => held.length;
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = ((request: { type: string }) => {
      const response = send(request);
      if (!released && ['VAULT_MATCH_PASSKEYS', 'VAULT_LIST_LOGIN_SUMMARIES'].includes(request.type)) {
        return response.then(value => new Promise(resolve => { held.push(() => resolve(value)); }));
      }
      return response;
    }) as typeof chrome.runtime.sendMessage;
  });
  await site.bringToFront();
  await popup.goto(`${root}/popup.html`);
  return popup;
}

function launch(profile: string) {
  const extension = path.resolve('dist');
  return launchEdgeContext(profile, { locale: 'en-US', reducedMotion: 'reduce', viewport: { width: 1366, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
}

test('current-site logins appear while optional popup queries are still pending', async ({}, info) => {
  const context = await launch(info.outputPath('profile'));
  try {
    const { root } = await setup(context);
    const popup = await delayedPopup(context, root);
    await expect.poll(() => popup.evaluate(() => (window as any).__heldPopupQueries())).toBeGreaterThan(0);
    await expect(popup.locator('#popup-matches').getByText('Fast candidate', { exact: true })).toBeVisible();
    await expect(popup.getByRole('searchbox')).toBeVisible();
    await expect(popup.locator('.popup-supplement-loading')).toBeVisible();
    await popup.screenshot({ path: info.outputPath('popup-primary-ready.png') });
    await popup.locator('#popup-matches .credential-card').getByRole('button').click();
    const site = context.pages().find(page => page.url().startsWith('https://login.example.test'))!;
    await expect(site.locator('input[type="password"]')).toHaveValue('synthetic-password');
    await popup.evaluate(() => (window as any).__releasePopupQueries());
    await expect(popup.locator('#popup-login-results').getByText('Account 00001', { exact: true })).toBeVisible();
    await expect(popup.locator('.popup-supplement-loading')).toHaveCount(0);
  } finally { await context.close(); }
});

test('a replaced refresh cannot overwrite newer fallback summaries', async ({}, info) => {
  const context = await launch(info.outputPath('profile'));
  try {
    const { root, manager } = await setup(context);
    const popup = await delayedPopup(context, root);
    await expect.poll(() => popup.evaluate(() => (window as any).__heldPopupQueries())).toBeGreaterThanOrEqual(2);
    expect(await manager.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ type: 'VAULT_GET_ITEM', itemId: 'performance-1' });
      if (!response.ok) return response;
      return chrome.runtime.sendMessage({ type: 'VAULT_UPSERT_ITEM', item: { ...response.data, title: 'Fresh fallback' } });
    })).toMatchObject({ ok: true });
    await popup.evaluate(() => { void (window as any).__monicaPopupRefresh(); });
    await expect.poll(() => popup.evaluate(() => (window as any).__heldPopupQueries())).toBeGreaterThanOrEqual(4);
    await popup.evaluate(() => (window as any).__releasePopupQueries());
    await expect(popup.locator('#popup-login-results').getByText('Fresh fallback', { exact: true })).toBeVisible();
    await expect(popup.getByText('Account 00001', { exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

test('locking a progressively loaded popup rejects late optional results', async ({}, info) => {
  const context = await launch(info.outputPath('profile'));
  try {
    const { root, manager } = await setup(context);
    const popup = await delayedPopup(context, root);
    await expect(popup.locator('#popup-matches').getByText('Fast candidate', { exact: true })).toBeVisible();
    expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LOCK' }))).toMatchObject({ ok: true });
    await expect(popup.locator('.popup-unlock')).toBeVisible();
    await popup.evaluate(() => (window as any).__releasePopupQueries());
    await expect(popup.getByText('Fast candidate', { exact: true })).toHaveCount(0);
    await expect(popup.getByText('Account 00001', { exact: true })).toHaveCount(0);
    await expect(popup.locator('#popup-login-results')).toHaveCount(0);
  } finally { await context.close(); }
});

test('large page counts stay bounded and support arbitrary keyboard page jumps', async ({}, info) => {
  const context = await launch(info.outputPath('profile'));
  try {
    const { manager } = await setup(context, 1101);
    await manager.reload();
    await manager.locator('.sidebar .nav-item').nth(1).click();
    await expect(manager.locator('.vault-list-card .item-card')).toHaveCount(50);
    const pagination = manager.locator('.list-pagination').filter({ visible: true });
    await expect(pagination).toHaveCount(1);
    await expect(pagination.locator('m3e-option')).toHaveCount(0);
    const page = pagination.getByRole('spinbutton', { name: 'Page', exact: true });
    await page.fill('23'); await page.press('Enter');
    await expect(manager.locator('.vault-list-card .item-card')).toHaveCount(1);
    await expect(page).toHaveValue('23');
    await page.fill(''); await page.press('Enter');
    await expect(page).toHaveValue('23');
    await page.fill('1'); await page.press('Tab');
    await expect(manager.locator('.vault-list-card .item-card')).toHaveCount(50);
    await manager.setViewportSize({ width: 320, height: 560 });
    await manager.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    await expect(page).toBeVisible();
    expect(await pagination.evaluate(root => [...root.querySelectorAll('input, m3e-button')].every(control => {
      const rect = control.getBoundingClientRect();
      return rect.width >= 44 && rect.height >= 44 && rect.left >= 0 && rect.right <= document.documentElement.clientWidth;
    }))).toBe(true);
    await pagination.screenshot({ path: info.outputPath('pagination-200-percent.png') });
  } finally { await context.close(); }
});

test('popup searches the complete vault across fields while transporting only one fallback page', async ({}, info) => {
  const context = await launch(info.outputPath('profile'));
  try {
    const { root } = await setup(context, 1101);
    const popup = await delayedPopup(context, root);
    await popup.evaluate(() => (window as any).__releasePopupQueries());
    await expect(popup.locator('#popup-login-results .credential-card')).toHaveCount(20);
    const measured = await popup.evaluate(async () => {
      const reply = await chrome.runtime.sendMessage({ type: 'VAULT_LIST_LOGIN_SUMMARIES', query: { page: 1, text: '', excludeMatchingUrl: 'https://login.example.test' } });
      return { ok: reply.ok, total: reply.data?.total, rows: reply.data?.items?.length, bytes: JSON.stringify(reply).length };
    });
    expect(measured).toMatchObject({ ok: true, total: 1100, rows: 20 });
    expect(measured.bytes).toBeLessThan(20000);
    const pagination = popup.locator('#popup-login-results .list-pagination');
    const page = pagination.getByRole('spinbutton', { name: 'Page', exact: true });
    await page.fill('55'); await page.press('Enter');
    await expect(page).toHaveValue('55');
    await expect(popup.locator('#popup-login-results .credential-card')).toHaveCount(20);
    await popup.getByRole('searchbox').fill('Account 01099 synthetic-1099');
    await expect(popup.locator('#popup-login-results .credential-card')).toHaveCount(1);
    await expect(popup.getByText('Account 01099', { exact: true })).toBeVisible();
    await popup.screenshot({ path: info.outputPath('cross-field-search.png') });
    await popup.getByRole('searchbox').fill('not-a-fixture');
    await expect(popup.locator('#popup-login-results')).toHaveCount(0);
  } finally { await context.close(); }
});

test('new search terms and locking revoke delayed fallback search results', async ({}, info) => {
  const context = await launch(info.outputPath('profile'));
  try {
    const { root, manager } = await setup(context, 3);
    const popup = await delayedPopup(context, root);
    await popup.evaluate(() => (window as any).__releasePopupQueries());
    await expect(popup.locator('#popup-login-results .credential-card')).toHaveCount(2);
    await popup.evaluate(() => {
      let pending: (() => void) | undefined;
      (window as any).__searchHeld = () => Boolean(pending);
      (window as any).__releaseSearch = () => { pending?.(); pending = undefined; };
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = ((request: any) => {
        const response = send(request);
        return request.type === 'VAULT_LIST_LOGIN_SUMMARIES' && request.query?.text === 'Account 00001'
          ? response.then(value => new Promise(resolve => { pending = () => resolve(value); })) : response;
      }) as typeof chrome.runtime.sendMessage;
    });
    const search = popup.getByRole('searchbox');
    await search.fill('Account 00001');
    await expect.poll(() => popup.evaluate(() => (window as any).__searchHeld())).toBe(true);
    await search.fill('Account 00002');
    await expect(popup.locator('#popup-login-results').getByText('Account 00002', { exact: true })).toBeVisible();
    await popup.evaluate(() => (window as any).__releaseSearch());
    await expect(popup.locator('#popup-login-results .credential-card')).toHaveCount(1);
    await expect(popup.getByText('Account 00001', { exact: true })).toHaveCount(0);
    await search.fill('Account 00001');
    await expect.poll(() => popup.evaluate(() => (window as any).__searchHeld())).toBe(true);
    expect(await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LOCK' }))).toMatchObject({ ok: true });
    await expect(popup.locator('.popup-unlock')).toBeVisible();
    await popup.evaluate(() => (window as any).__releaseSearch());
    await expect(popup.locator('#popup-login-results')).toHaveCount(0);
  } finally { await context.close(); }
});
