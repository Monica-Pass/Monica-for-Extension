import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const argument = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const extension = path.resolve(argument('--extension', 'dist'));
const output = path.resolve(argument('--output', '.artifacts/performance/current.json'));
const count = Number(argument('--items', '2000'));
if (!Number.isInteger(count) || count < 100 || count > 10000) throw new Error('Use between 100 and 10000 synthetic items.');
const profile = await mkdtemp(path.join(tmpdir(), 'monica-performance-'));
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, locale: 'de-DE', colorScheme: 'dark', reducedMotion: 'reduce',
  viewport: { width: 1366, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
const result = { version: JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8')).version, browser: context.browser()?.version(), loginItems: count, otpItems: 100, units: { heap: 'bytes of retained V8 heap after requested GC; not total browser RAM', nodes: 'CDP DOM nodes including detached nodes', script: 'seconds of renderer script execution' }, samples: {} };
const resourceRequests = new WeakMap();
function observeResources(page) {
  const urls = new Set();
  resourceRequests.set(page, urls);
  page.on('request', request => urls.add(request.url()));
}
async function sample(page, name) {
  await page.bringToFront();
  await page.mouse.move(1, 1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  result.samples[name] = { heap: heap.usedSize, backingStorage: heap.backingStorageSize, ...dom };
  await cdp.detach();
  console.log(name + ': ' + JSON.stringify(result.samples[name]));
}
async function resources(page) {
  const entries = [...(resourceRequests.get(page) || [])];
  const own = [...new Set(entries.filter(url => url.startsWith('chrome-extension://')).map(url => new URL(url).pathname.slice(1)))];
  const files = [];
  for (const name of own) files.push({ name, bytes: (await stat(path.join(extension, name))).size });
  return { bytes: files.reduce((total, file) => total + file.bytes, 0), files };
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const manager = await context.newPage();
  observeResources(manager);
  await manager.addInitScript(() => {
    const intervals = new Set();
    const originalSet = window.setInterval;
    const originalClear = window.clearInterval;
    window.setInterval = (...args) => { const id = originalSet(...args); intervals.add(id); return id; };
    window.clearInterval = (id) => { intervals.delete(id); originalClear(id); };
    const sign = crypto.subtle.sign;
    let signatures = 0;
    crypto.subtle.sign = function (...args) { signatures++; return sign.apply(this, args); };
    window.__monicaPerformance = () => ({ intervals: intervals.size, signatures });
  });
  await manager.goto(`chrome-extension://${id}/index.html`);
  await expect(manager.locator('.language-picker select')).toBeVisible();
  await expect(manager.locator('input[type="password"]')).toHaveCount(2);
  await manager.evaluate(() => document.fonts.ready);
  await sample(manager, 'managerCold');
  result.managerInitialResources = await resources(manager);
  const setup = await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: 'synthetic performance probe password' }));
  if (!setup.ok) throw new Error(setup.error);
  const imported = await manager.evaluate(async count => {
    const now = new Date().toISOString();
    const common = { notes: '', favorite: false, createdAt: now, updatedAt: now, providerRefs: [], customFields: [] };
    const items = Array.from({ length: count }, (_, index) => ({ ...common, id: `perf-login-${index}`, kind: 'login', title: `Performance account ${String(index).padStart(5, '0')}`, username: `user${index}@example.test`, password: 'synthetic password', uris: [`https://account${index}.example.test`] }));
    for (let index = 0; index < 100; index++) items.push({ ...common, id: `perf-otp-${index}`, kind: 'totp', title: `OTP ${index}`, secret: 'JBSWY3DPEHPK3PXP', issuer: 'Synthetic', accountName: `user${index}`, algorithm: 'SHA1', digits: 6, period: 30, otpType: 'TOTP' });
    const response = await chrome.runtime.sendMessage({ type: 'VAULT_IMPORT_ITEMS', items });
    return { ok: response.ok, error: response.error };
  }, count);
  if (!imported.ok) throw new Error(imported.error);
  await manager.reload();
  await expect(manager.locator('.page-heading h1')).toBeVisible();
  await sample(manager, 'managerVault');
  await manager.locator('.sidebar .nav-item').nth(1).click();
  await expect(manager.locator('.credential-table tbody tr').first()).toBeVisible();
  await sample(manager, 'managerLogins');
  result.renderedLoginRows = await manager.locator('.credential-table tbody tr').count();
  await manager.getByRole('navigation').getByRole('button', { name: /^Bestätigungscodes/ }).click();
  await expect(manager.locator('.totp-code-cell').first()).toBeVisible();
  await manager.waitForTimeout(1100);
  const clock = await manager.evaluate(() => { const fixed = Math.floor(Date.now() / 30000) * 30000 + 15000; Date.now = () => fixed; return window.__monicaPerformance(); });
  await manager.waitForTimeout(1100);
  const before = await manager.evaluate(() => window.__monicaPerformance());
  await manager.waitForTimeout(4000);
  const after = await manager.evaluate(() => window.__monicaPerformance());
  result.otp = { activeIntervals: clock.intervals, signaturesInSamePeriodOverFourSeconds: after.signatures - before.signatures };
  await sample(manager, 'managerOtp');
  await manager.locator('.sidebar-footer > m3e-button').click();
  await expect(manager.locator('.auth-preferences')).toBeVisible();
  await sample(manager, 'managerLocked');
  await manager.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_UNLOCK', masterPassword: 'synthetic performance probe password' }));
  await manager.close();

  await context.route('https://performance.example.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated performance fixture</title><main></main>' }));
  const site = await context.newPage();
  await site.goto('https://performance.example.test/');
  await site.waitForTimeout(700);
  await sample(site, 'websiteBeforeChurn');
  await site.evaluate(async () => {
    for (let cycle = 0; cycle < 5; cycle++) {
      const container = document.createElement('div');
      for (let index = 0; index < 100; index++) {
        const host = document.createElement('section');
        host.attachShadow({ mode: 'open' }).innerHTML = '<form><input autocomplete="username"><input type="password">' + '<span>Dynamic content</span>'.repeat(20) + '</form>';
        container.append(host);
      }
      document.querySelector('main').append(container);
      await new Promise(resolve => setTimeout(resolve, 0));
      container.remove();
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
  await sample(site, 'websiteAfterChurn');
  const popup = await context.newPage();
  observeResources(popup);
  await popup.setViewportSize({ width: 390, height: 600 });
  await site.bringToFront();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.locator('.popup-search')).toBeVisible();
  await popup.evaluate(() => document.fonts.ready);
  await sample(popup, 'popup');
  result.popupResources = await resources(popup);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log('Saved synthetic performance measurements: ' + output);
} finally {
  await context.close();
  if (path.dirname(profile) !== path.resolve(tmpdir()) || !path.basename(profile).startsWith('monica-performance-')) throw new Error('Unexpected performance profile path');
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
