import { expect, test } from '@playwright/test';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { launchEdgeContext } from './fixtures/edge';
import { bitwardenSteamFixture, STEAM_ID, STEAM_SECRET } from '../fixtures/bitwarden-steam';
import { BitwardenClient } from '../../src/providers/bitwarden/bitwarden-client';
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey } from '../../src/providers/bitwarden/bitwarden-crypto';

function expectedCode(now: number) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const bytes = createHmac('sha1', Buffer.from(STEAM_SECRET, 'base64')).update(counter).digest();
  let value = bytes.readUInt32BE(bytes[19] & 15) & 0x7fffffff, result = '';
  for (let index = 0; index < 5; index++) { result += '23456789BCDFGHJKMNPQRTVWXY'[value % 26]; value = Math.floor(value / 26); }
  return result;
}

test('Bitwarden standard maFile recovers after download failure and generates Steam codes without session tokens', async ({}, info) => {
  const fixture = await bitwardenSteamFixture({ raw: `{"account_name":"synthetic","steamid":${STEAM_ID},"shared_secret":"${STEAM_SECRET}"}` });
  const host = String(fixture.account.config.vaultUrl), email = String(fixture.account.config.email), password = 'Synthetic Steam test password';
  const key = { encKey: new Uint8Array(Buffer.from(String(fixture.account.config.vaultKeyEnc), 'base64')), macKey: new Uint8Array(Buffer.from(String(fixture.account.config.vaultKeyMac), 'base64')) };
  const stretched = await stretchBitwardenMasterKey(await deriveBitwardenMasterKey(password, email, { type: 0, iterations: 10_000 }));
  const protectedKey = await new BitwardenClient().protectVaultKey(key, stretched, new Uint8Array(16));
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce', viewport: { width: 1180, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  let failedDownload = true, downloaded = 0;
  const unexpected: string[] = [];
  try {
    await context.route(`${host}/**`, async route => {
      const request = route.request(), url = new URL(request.url());
      const json = (value: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/identity/accounts/prelogin/password') return json({ Kdf: 0, KdfIterations: 10_000 });
      if (url.pathname === '/identity/connect/token') return json({ access_token: 'synthetic', refresh_token: 'synthetic', expires_in: 3600, Key: protectedKey });
      if (url.pathname === '/api/sync') return json(fixture.payload);
      if (url.pathname === '/api/accounts/revision-date') return json(Date.parse('2026-10-10T00:00:00.000Z'));
      if (url.pathname === '/api/ciphers/steam-cipher/attachment/steam-attachment') return json({ ...fixture.descriptor, Url: 'https://objects.example.test/steam' });
      unexpected.push(`${request.method()} ${url.pathname}`); return route.abort('failed');
    });
    await context.route('https://objects.example.test/steam', async route => {
      downloaded++;
      expect(route.request().headers().authorization).toBeUndefined();
      return failedDownload ? route.fulfill({ status: 403 }) : route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from(fixture.body) });
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const send = async (message: object) => {
      const response = await page.evaluate(value => chrome.runtime.sendMessage(value), message);
      expect(response.ok, response.error).toBe(true); return response.data;
    };
    await send({ type: 'VAULT_SETUP', masterPassword: '' });
    await page.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
    const { providerId } = await send({ type: 'BITWARDEN_LOGIN', name: 'Synthetic Bitwarden', vaultUrl: host, email, masterPassword: password });
    await send({ type: 'PROVIDER_SYNC', providerId });
    await page.reload();
    await page.locator('.nav-item').filter({ hasText: 'Steam' }).click();
    const tile = page.locator('.vault-tile').filter({ hasText: 'Android Steam attachment' });
    await expect(tile.locator('.totp-code-cell')).toContainText('不可用');
    failedDownload = false;
    const synchronized = await send({ type: 'PROVIDER_SYNC', providerId });
    const items = await send({ type: 'VAULT_LIST_ITEMS' });
    await info.attach('synthetic-sync-result', { body: JSON.stringify({ synchronized, downloaded,
      rows: items.map((item: any) => ({ kind: item.kind, title: item.title, steamId: item.steamId, hasSecret: !!item.steamSharedSecretBase64 })) }), contentType: 'application/json' });
    expect(items.find((item: any) => item.title === 'Android Steam attachment')).toMatchObject({ kind: 'login', steamId: STEAM_ID, steamSharedSecretBase64: STEAM_SECRET, categoryName: 'Games' });
    await expect.poll(async () => {
      const observed = await tile.locator('.otp-copy-button strong').evaluate(node => ({ code: node.textContent, now: Date.now() }));
      return observed.code === expectedCode(observed.now);
    }).toBe(true);
    await page.getByRole('button', { name: '查看Android Steam attachment详情', exact: true }).click();
    const panel = page.locator('.steam-account-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(STEAM_ID);
    await expect(panel).not.toContainText('SteamID 未识别');
    await panel.getByRole('button', { name: '刷新待批准操作', exact: true }).click();
    await expect(page.locator('.steam-account-dialog')).toContainText('Steam 项目缺少 access token 或 refresh token');
    await page.screenshot({ path: info.outputPath('bitwarden-steam-standard-attachment.png') });
    expect(downloaded).toBeGreaterThanOrEqual(2);
    expect(unexpected).toEqual([]); expect(errors).toEqual([]);
  } finally { await context.close(); }
});
