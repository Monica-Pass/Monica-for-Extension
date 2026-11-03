import { expect, test } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { normalizeImportedVaultItem } from '../../src/manager/import-items';

test('Bitwarden JSON imports are editable and old local readonly imports can be removed and restored in Edge', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', viewport: { width: 1180, height: 950 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const send = async (request: object) => {
      const response = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
      expect(response.ok, response.error).toBe(true);
      return response.data;
    };
    await send({ type: 'VAULT_SETUP', masterPassword: 'synthetic issue16 password' });
    await page.reload();
    await page.getByRole('button', { name: '设置与备份', exact: true }).click();
    await page.locator('[data-settings-entry="transfer"]').click();
    await page.locator('[data-transfer-file]').setInputFiles({ name: 'bitwarden.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ encrypted: false, items: [
      { type: 1, name: 'Issue16 login', login: { username: 'synthetic', password: 'synthetic password', uris: [{ uri: 'https://example.test' }] } },
      { type: 2, name: 'Issue16 note', notes: 'synthetic note' }
    ] })) });
    await page.getByRole('button', { name: '读取并预览', exact: true }).click();
    await expect(page.locator('[data-transfer-preview]')).toContainText('可导入 2 个项目');
    await page.getByRole('button', { name: '导入 2 个项目', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('已加密导入 2 个密码库项目');
    const items = await send({ type: 'VAULT_LIST_ITEMS' });
    expect(items.map((item: { kind: string }) => item.kind).sort()).toEqual(['login', 'secure-note']);
    const note = items.find((item: { kind: string }) => item.kind === 'secure-note');
    await send({ type: 'VAULT_UPSERT_ITEM', item: { ...note, content: 'edited synthetic note' }, expectedUpdatedAt: note.updatedAt });
    await send({ type: 'VAULT_DELETE_ITEM', itemId: note.id });
    const legacy = normalizeImportedVaultItem({ id: 'legacy-bitwarden-import', name: 'Legacy name', type: 1, login: { password: 'synthetic legacy secret' } })!;
    legacy.title = 'Legacy Bitwarden readonly';
    await send({ type: 'VAULT_IMPORT_ITEMS', items: [legacy] });
    await page.reload();
    const row = page.locator('article.item-card').filter({ hasText: 'Legacy Bitwarden readonly' });
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: /编辑/ })).toHaveCount(0);
    page.on('dialog', dialog => dialog.accept());
    await row.getByRole('button', { name: /删除/ }).click();
    await expect(row).toHaveCount(0);
    await page.locator('button.nav-item').filter({ hasText: '回收站' }).click();
    const deleted = page.locator('article.item-card').filter({ hasText: 'Legacy Bitwarden readonly' });
    await expect(deleted).toBeVisible();
    await deleted.getByRole('button', { name: /恢复/ }).click();
    await expect(deleted).toHaveCount(0);
    await page.locator('button.nav-item').filter({ hasText: '全部项目' }).click();
    await expect(row).toBeVisible();
    await page.screenshot({ path: info.outputPath('issue16-local-readonly.png'), fullPage: true });
    expect((await send({ type: 'VAULT_LIST_ITEMS' })).find((item: { id: string }) => item.id === legacy.id).originalPayload).toBe(legacy.originalPayload);
  } finally { await context.close(); }
});
