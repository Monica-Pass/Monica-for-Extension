import { expect, test } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { createEmptyVaultState, createLoginItem } from '../../src/core/model';
import { decodeBitwardenCipher, encodeBitwardenCipher } from '../../src/providers/bitwarden/bitwarden-cipher-codec';
import { deriveVaultKey, encryptVaultState } from '../../src/security/vault-crypto';

test('one Bitwarden cipher has one authenticator tile while preserving its login and OTP projection', async ({}, info) => {
  const extension = path.resolve('dist');
  const key = { encKey: new Uint8Array(32).fill(7), macKey: new Uint8Array(32).fill(12) };
  const state = createEmptyVaultState();
  state.providers.push({ id: 'synthetic-bw', kind: 'bitwarden', name: 'Bitwarden', enabled: false, isDefaultSaveTarget: false, config: {} });
  for (const title of ['Synthetic AstrBot', 'Synthetic Epic']) {
    const login = { ...createLoginItem({ title, username: 'synthetic-user', password: 'synthetic-password',
      uris: ['https://otp.example.test'] }), totpSecret: 'otpauth://totp/Synthetic:user?secret=JBSWY3DPEHPK3PXP&issuer=Synthetic' };
    const raw = { ...await encodeBitwardenCipher(login, key), id: login.id, revisionDate: login.updatedAt };
    state.items.push(...(await decodeBitwardenCipher(raw, 'synthetic-bw', key)).items);
  }
  expect(state.items.map(item => item.kind)).toEqual(['login', 'totp', 'login', 'totp']);
  const password = 'synthetic duplicate TOTP backup password';
  const { key: vaultKey, kdf } = await deriveVaultKey(password);
  const backup = { magic: 'MONICA_EXTENSION_BACKUP', version: 1, exportedAt: new Date().toISOString(), envelope: await encryptVaultState(state, vaultKey, kdf) };
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce',
    viewport: { width: 1000, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const restored = await page.evaluate(({ backup, password }) => chrome.runtime.sendMessage({ type: 'VAULT_RESTORE_ENCRYPTED', backup, backupPassword: password }), { backup, password });
    expect(restored.ok).toBe(true);
    await page.reload();
    const navigation = page.getByRole('navigation', { name: '主导航' });
    await navigation.getByRole('button', { name: /^动态验证码/ }).click();
    await expect(page.locator('.vault-tile')).toHaveCount(2);
    await expect(navigation.getByRole('button', { name: /^动态验证码/ }).locator('.nav-count')).toHaveText('2');
    for (const title of ['Synthetic AstrBot', 'Synthetic Epic']) {
      const tile = page.locator('.vault-tile').filter({ hasText: title });
      await expect(tile).toHaveCount(1);
      await expect(tile).toHaveClass(/vault-tile--totp/);
      await expect(tile.locator('.otp-copy-button strong')).toHaveText(/^\d{3} \d{3}$/);
    }
    const firstCode = page.locator('.vault-tile .otp-copy-button').first();
    const beforeCopy = (await firstCode.locator('strong').innerText()).replace(/\s/g, '');
    await firstCode.click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect([beforeCopy, (await firstCode.locator('strong').innerText()).replace(/\s/g, '')]).toContain(copied);
    // Only the parent carries this URL. Filtering must retain an inline fallback.
    await page.getByRole('searchbox', { name: '搜索密码库' }).fill('otp.example.test');
    await expect(page.locator('.vault-tile')).toHaveCount(2);
    await expect(page.locator('.vault-tile--login')).toHaveCount(2);
    await page.getByRole('searchbox', { name: '搜索密码库' }).fill('');
    await expect(page.locator('.vault-tile--totp')).toHaveCount(2);
    await page.getByRole('button', { name: '多选', exact: true }).click();
    await page.getByRole('button', { name: '全选当前页', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '已选择 2 个项目' })).toBeVisible();
    await page.getByRole('button', { name: '退出多选', exact: true }).click();
    const stored = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' }));
    expect(stored.ok).toBe(true);
    expect(stored.data).toEqual(state.items);
    await page.reload();
    await navigation.getByRole('button', { name: /^动态验证码/ }).click();
    await expect(page.locator('.vault-tile')).toHaveCount(2);
    await page.screenshot({ path: info.outputPath('authenticators.png'), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
