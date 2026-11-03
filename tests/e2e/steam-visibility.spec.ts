import { expect, test } from '@playwright/test';
import path from 'node:path';
import { createHmac, createHash } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { launchEdgeContext } from './fixtures/edge';

function expectedSteamCode(now: number) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const bytes = createHmac('sha1', Buffer.from('QUJDREVGR0hJSktMTU5PUFFSU1Q=', 'base64')).update(counter).digest();
  let value = bytes.readUInt32BE(bytes[19] & 15) & 0x7fffffff, code = '';
  const alphabet = '23456789BCDFGHJKMNPQRTVWXY';
  for (let index = 0; index < 5; index++) { code += alphabet[value % alphabet.length]; value = Math.floor(value / alphabet.length); }
  return code;
}

test('Steam section shows stored authenticators and login projections', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce',
    viewport: { width: 1180, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const setup = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: '' }));
    expect(setup.ok, setup.error).toBe(true);
    const now = new Date().toISOString();
    const base = { favorite: false, notes: '', createdAt: now, updatedAt: now, providerRefs: [] };
    const login = { ...base, kind: 'login', username: 'synthetic', password: '', uris: [], customFields: [] };
    const rows = [
      { ...base, id: 'local-steam', title: 'Local Steam', kind: 'totp', otpType: 'STEAM', secret: 'QUJDREVGR0hJSktMTU5PUFFSU1Q=', algorithm: 'SHA1', digits: 5, period: 30 },
      { ...login, id: 'bw-steam', title: 'Bitwarden Steam URI', totpSecret: 'steam://QUJDREVGR0hJSktMTU5PUFFSU1Q=' },
      { ...login, id: 'kdbx-steam', title: 'KeePass Steam URI', totpSecret: 'otpauth://totp/Steam:synthetic?secret=IFBEGRCFIZDUQSKKJNGE2TSPKBIVEU2U&issuer=Steam&encoder=steam&digits=5' },
      { ...login, id: 'attachment-steam', title: 'Hydrated Steam maFile', loginType: 'STEAM_MAFILE', steamSharedSecretBase64: 'QUJDREVGR0hJSktMTU5PUFFSU1Q=', steamAccountName: 'synthetic' },
    ];
    const imported = await page.evaluate(items => chrome.runtime.sendMessage({ type: 'VAULT_IMPORT_ITEMS', items }), rows);
    expect(imported.ok, imported.error).toBe(true);
    await page.reload();
    await expect(page.locator('.nav-item').filter({ hasText: 'Steam' })).toBeVisible();
    await page.locator('.nav-item').filter({ hasText: 'Steam' }).click();
    await page.screenshot({ path: info.outputPath('steam-visibility.png') });
    await info.attach('page-errors', { body: JSON.stringify(errors), contentType: 'application/json' });
    for (const item of rows) {
      const tile = page.locator('.vault-tile').filter({ hasText: item.title });
      await expect(tile, item.title).toBeVisible();
      await expect(tile.locator('.totp-code-cell')).toContainText(/[23456789BCDFGHJKMNPQRTVWXY]{5}/);
      await expect.poll(async () => {
        const observed = await tile.locator('.otp-copy-button strong').evaluate(node => ({ code: node.textContent, now: Date.now() }));
        return observed.code === expectedSteamCode(observed.now);
      }).toBe(true);
    }
    await page.getByRole('button', { name: '查看Local Steam详情', exact: true }).click();
    await expect(page.locator('.steam-account-panel')).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('Android marked KDBX maFile is visible with a usable code after opening the encrypted file', async ({}, info) => {
  const helper = info.outputPath('fixture.cjs');
  await build({ stdin: { contents: "export {buildKeePassFixture} from './src/providers/keepass/keepass-fixture';", resolveDir: process.cwd() },
    outfile: helper, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { buildKeePassFixture } = createRequire(import.meta.url)(helper) as typeof import('../../src/providers/keepass/keepass-fixture');
  const raw = JSON.stringify({ account_name: 'synthetic', steamid: '76561198000000000', shared_secret: 'QUJDREVGR0hJSktMTU5PUFFSU1Q=', future_field: 'keep' });
  const bytes = await buildKeePassFixture({ password: 'Synthetic Steam KDBX password', entries: [{ title: 'Android Steam maFile', group:'Games/Steam',
    fields: { UserName: 'synthetic', 'Monica.Type': 'steam_mafile_v1', MonicaLoginType: 'STEAM_MAFILE', Notes: 'Original Steam note' },
    binaries: { 'synthetic.maFile': new TextEncoder().encode(raw), 'unrelated.txt': Uint8Array.of(1, 2, 3) } },
    {title:'Root Steam maFile',fields:{'Monica.Type':'steam_mafile_v1',MonicaLoginType:'STEAM_MAFILE'},binaries:{'root.maFile':new TextEncoder().encode(raw)}}] });
  const file = info.outputPath('steam.kdbx'); await writeFile(file, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', reducedMotion: 'reduce',
    viewport: { width: 1180, height: 900 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const setup = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: '' }));
    expect(setup.ok, setup.error).toBe(true); await page.reload();
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    await page.locator('m3e-list-action').filter({ hasText: '连接 KeePass' }).click();
    const dialog = page.locator('.keepass-provider-dialog[role="dialog"]');
    await dialog.getByLabel('显示名称', { exact: true }).fill('Synthetic Steam source');
    await dialog.getByLabel('KeePass 数据库文件', { exact: true }).setInputFiles(file);
    await dialog.getByLabel('数据库密码（可留空）', { exact: true }).fill('Synthetic Steam KDBX password');
    await dialog.getByRole('button', { name: '解锁并连接', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    // A local KDBX connect only opens an in-memory session; entries reach the vault after 立即同步.
    const source = page.locator('.source-card').filter({ hasText: 'Synthetic Steam source' });
    await source.getByRole('button', { name: '立即同步', exact: true }).click();
    const steamNav = page.locator('.nav-item').filter({ hasText: 'Steam' });
    await expect(steamNav.locator('.nav-count')).toHaveText('2', { timeout: 30_000 });
    await steamNav.click();
    await page.getByRole('button',{name:'筛选',exact:true}).click();
    const filter=page.locator('.filter-dialog');
    await filter.locator('.folder-scope-list button').filter({hasText:'Games'}).click();
    await page.setViewportSize({width:320,height:900});
    expect(await filter.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath('steam-folder-filter-320.png')});
    await filter.getByRole('button',{name:'完成',exact:true}).click();
    await page.setViewportSize({width:1180,height:900});
    await expect(page.locator('.vault-tile').filter({hasText:'Root Steam maFile'})).toHaveCount(0);
    const tile = page.locator('.vault-tile').filter({ hasText: 'Android Steam maFile' });
    await expect(tile).toBeVisible();
    await expect.poll(async () => {
      const observed = await tile.locator('.otp-copy-button strong').evaluate(node => ({ code: node.textContent, now: Date.now() }));
      return observed.code === expectedSteamCode(observed.now);
    }).toBe(true);
    await page.screenshot({ path: info.outputPath('steam-kdbx-desktop.png') });
    await page.reload(); await page.locator('.nav-item').filter({ hasText: 'Steam' }).click();
    await expect(tile).toBeVisible();
    await expect(page.locator('.vault-tile').filter({hasText:'Root Steam maFile'})).toHaveCount(0);
    await page.getByRole('button',{name:'筛选',exact:true}).click();
    await expect(filter.locator('.folder-scope-list button').filter({hasText:'Games'})).toHaveAttribute('aria-pressed','true');
    await filter.locator('.folder-scope-list button').filter({hasText:'未分类'}).click();
    await filter.getByRole('button',{name:'完成',exact:true}).click();
    await expect(page.locator('.vault-tile').filter({hasText:'Root Steam maFile'})).toBeVisible();
    await expect(tile).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 900 });
    await page.screenshot({ path: info.outputPath('steam-kdbx-320.png') });
    const stored = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' }));
    expect(stored.ok).toBe(true);
    const login = stored.data.find((item: any) => item.title === 'Android Steam maFile');
    expect(login).toMatchObject({ kind: 'login', notes: 'Original Steam note', steamSharedSecretBase64: 'QUJDREVGR0hJSktMTU5PUFFSU1Q=' });
    expect(createHash('sha256').update(await readFile(file)).digest('hex')).toBe(digest);
  } finally { await context.close(); }
});
