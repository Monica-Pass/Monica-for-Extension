import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { chooseOption, loginEditor, save, fill, readItem, expand } from './interop-315-edge-features.mjs';

export async function runSsoBackendUi({ page, evidence, screenshot }) {
  const fixtures = JSON.parse(await readFile(process.env.MONICA_315_SSO_EDGE_FIXTURES, 'utf8'));
  evidence.ssoBackendUi = [];
  for (const backend of ['keepass', 'vaultwarden']) {
    const fixture = fixtures[backend]; assert.ok(fixture);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    if (backend === 'keepass') {
      await page.locator('m3e-list-action').filter({ hasText: '连接 KeePass' }).click();
      const dialog = page.getByRole('dialog', { name: '连接 KeePass', exact: true });
      await dialog.getByRole('radio', { name: 'WebDAV 文件', exact: true }).click();
      await fill(dialog, { '显示名称': fixture.name, 'WebDAV 地址': fixture.baseUrl, '用户名': fixture.username, 'WebDAV 密码': fixture.password, '远端 .kdbx 位置': fixture.remotePath, '数据库密码（可留空）': fixture.databasePassword });
      await dialog.getByRole('button', { name: '连接并解锁', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 60000 });
    } else {
      await page.locator('m3e-list-action').filter({ hasText: '连接 Bitwarden' }).click();
      const dialog = page.getByRole('dialog', { name: '连接 Bitwarden', exact: true });
      await fill(dialog, { '显示名称': fixture.name, '服务器地址 *': fixture.baseUrl, '邮箱 *': fixture.email, '主密码 *': fixture.password });
      await dialog.getByRole('button', { name: '登录并连接', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 60000 });
    }
    const sourceCard = page.locator('[data-home-provider-id]').filter({ has: page.getByRole('heading', { name: fixture.name, exact: true }) });
    const providerId = await sourceCard.getAttribute('data-home-provider-id'); assert.ok(providerId);
    const find = async title => {
      const listed = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_LIST_ITEMS' })); assert.equal(listed.ok, true);
      const item = listed.data.find(item => item.title === title && item.providerRefs.some(ref => ref.providerId === providerId));
      assert.ok(item, title); return readItem(page, item.id);
    };
    const flush = async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.getByRole('button', { name: '密码源', exact: true }).click();
      const sync = sourceCard.getByRole('button', { name: /^(立即同步|重试同步|写入本机副本)$/ }).first();
      await sync.click(); await expect(sourceCard.getByRole('button', { name: '取消同步', exact: true })).toHaveCount(0, { timeout: 60000 });
      await expect(sync).toBeVisible({ timeout: 60000 }); await expect(sourceCard.locator('.form-error')).toHaveCount(0);
      await page.getByRole('button', { name: /^全部项目/ }).click();
    };
    await flush();
    const account = await find('Account');
    const title = `Edge SSO ${backend}`;
    await page.getByRole('button', { name: '选择新建类型', exact: true }).click();
    await page.locator('m3e-menu-item[data-create-type="PASSWORD"]').click();
    let editor = loginEditor(page);
    await editor.getByLabel('名称 *', { exact: true }).fill(title);
    await chooseOption(editor.getByLabel('保存到', { exact: true }), { label: fixture.name });
    await expand(editor, '登录方式'); await chooseOption(editor.getByLabel('登录方式', { exact: true }), 'SSO');
    await editor.getByLabel('SSO 提供商', { exact: true }).fill('OKTA');
    await chooseOption(editor.getByLabel('关联账号', { exact: true }), { label: `Account · ${account.username}` });
    await page.setViewportSize({ width: 420, height: 920 });
    await editor.getByLabel('关联账号', { exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, `sso-${backend}-picker-420.png`);
    await save(editor); await flush();
    const linked = await find(title);
    assert.equal(linked.ssoRefLogicalId, `password:${backend === 'keepass' ? 'keepass' : 'bitwarden'}:${account.providerRefs[0].remoteId}`);
    assert.equal(linked.ssoRefEntryId, undefined);
    const edit = async () => {
      await page.getByLabel('搜索密码库', { exact: true }).fill(title);
      await page.getByLabel(`查看${title}详情`, { exact: true }).first().click();
      const detail = page.locator('[role="dialog"][data-item-kind="login"]');
      await expect(detail.getByText(`Account · ${account.username}`, { exact: true })).toBeVisible();
      await detail.getByRole('button', { name: '编辑', exact: true }).click();
      const form = loginEditor(page); await expand(form, '登录方式'); return form;
    };
    editor = await edit(); await editor.getByRole('button', { name: '解除账号关联', exact: true }).click();
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await find(title)).ssoRefLogicalId, linked.ssoRefLogicalId);
    editor = await edit(); await editor.getByRole('button', { name: '解除账号关联', exact: true }).click();
    await save(editor); await flush();
    assert.equal((await find(title)).ssoRefLogicalId, undefined);
    assert.equal((await find('Account')).password, account.password);
    await page.getByLabel('搜索密码库', { exact: true }).fill('');
    evidence.ssoBackendUi.push({ backend, status: 'passed', providerId, title, create: true, cancel: true, unlink: true, accountUnchanged: true });
  }
}
