import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { loginEditor, save, readItem } from './interop-315-edge-features.mjs';

export async function runProjectSingletonUi({ page, evidence, screenshot }) {
  const project = randomUUID(), group = randomUUID(), now = new Date().toISOString();
  const row = index => ({ kind: 'login', id: randomUUID(), title: 'Singleton project fixture',
    username: 'shared', password: `synthetic-password-${index}`, notes: 'Shared note', uris: [], favorite: false,
    providerRefs: [], createdAt: now, updatedAt: now, passwordGroupId: project,
    customFields: [{ name: 'monica.content.credential', protected: true,
      value: JSON.stringify({ version: 1, projectId: project, groupId: group, passwordId: randomUUID(),
        label: 'Primary account', primary: true, groupOrder: 0, passwordOrder: index }).replace(/}$/, ',"future":9007199254740993}') }] });
  const seeded = await page.evaluate(items => chrome.runtime.sendMessage({ type: 'VAULT_IMPORT_ITEMS', items }), [row(0)]);
  assert.equal(seeded.ok, true); const original = seeded.data[0];
  await page.reload(); await page.getByRole('heading', { name: '全部项目', exact: true }).waitFor();
  const open = async () => {
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.getByLabel('搜索密码库', { exact: true }).fill(original.title);
    await page.getByLabel(`查看${original.title}详情`, { exact: true }).first().click();
    await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button', { name: '编辑', exact: true }).click();
    const form = loginEditor(page); await expect(form.locator('[data-credential-group]')).toHaveCount(1); return form;
  };
  let form = await open();
  await expect(form.getByLabel('密码 1', { exact: true })).toHaveValue(original.password);
  await form.getByLabel('恢复备注与笔记', { exact: true }).fill('Singleton edited in Edge');
  await save(form);
  const saved = await readItem(page, original.id);
  assert.equal(saved.notes, 'Singleton edited in Edge');
  assert.equal(saved.passwordGroupId, original.passwordGroupId);
  assert.deepEqual(saved.customFields, original.customFields);
  assert.equal(saved.password, original.password);

  form = await open();
  await form.getByLabel('恢复备注与笔记', { exact: true }).fill('Stale draft must stay unsaved');
  // Represents another sync arriving while the actual editor holds its snapshot.
  const incoming = { ...row(1), notes: saved.notes };
  const imported = await page.evaluate(items => chrome.runtime.sendMessage({ type: 'VAULT_IMPORT_ITEMS', items }), [incoming]);
  assert.equal(imported.ok, true);
  const incomingBeforeSave = await readItem(page, incoming.id);
  await page.setViewportSize({ width: 320, height: 950 });
  await form.getByRole('button', { name: '加密保存', exact: true }).click();
  await expect(form.getByText('分组成员已变化，请重新打开整个项目。', { exact: true })).toBeVisible();
  assert.deepEqual(await readItem(page, saved.id), saved);
  assert.deepEqual(await readItem(page, incoming.id), incomingBeforeSave);
  await screenshot(page, 'project-singleton-stale-320.png');
  await form.getByRole('button', { name: '取消', exact: true }).click(); await form.waitFor({ state: 'hidden' });
  // Reload the complete project and save again using the visible two-row editor.
  await page.reload(); await page.getByRole('heading', { name: '全部项目', exact: true }).waitFor();
  form = await open();
  await expect(form.getByLabel('密码 2', { exact: true })).toHaveValue(incoming.password);
  await form.getByLabel('恢复备注与笔记', { exact: true }).fill('Complete project edited in Edge');
  await save(form);
  const final = await Promise.all([saved.id, incoming.id].map(id => readItem(page, id)));
  for (const item of final) assert.equal(item.notes, 'Complete project edited in Edge');
  for (const [index, item] of final.entries()) assert.deepEqual(item.customFields, index ? incoming.customFields : original.customFields);
  evidence.projectSingleton = { status: 'passed', saved: final, checks: [
    'explicit singleton save', 'exact protected and future metadata', 'concurrent membership rejects stale UI save',
    'failed draft cancellation', 'reopen complete project and reconcile shared fields', '320px error visibility'
  ] };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('搜索密码库', { exact: true }).fill('');
}

export async function verifyProjectSingletonUi(page, evidence) {
  for (const item of evidence.projectSingleton.saved) assert.deepEqual(await readItem(page, item.id), item);
  evidence.projectSingleton.restartVerified = true;
}
