import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { loginEditor, readItem } from './interop-315-edge-features.mjs';

export async function runProjectCredentialReturn({ page, evidence, screenshot }) {
  const root = process.env.MONICA_315_APP_FIXTURE;
  assert.ok(root, 'Explicit Android project-credential fixture directory required');
  const fixture = JSON.parse(await readFile(join(root, 'project-credentials-edge-return.json'), 'utf8'));
  const proof = JSON.parse(await readFile(join(root, 'project-credentials-return-codec-evidence.json'), 'utf8'));
  const archive = await readFile(join(root, 'android-project-credentials-return.zip'));
  assert.equal(fixture.synthetic, true); assert.equal(proof.status, 'passed');
  assert.equal(fixture.archiveSha256, createHash('sha256').update(archive).digest('hex'));
  assert.equal(fixture.archiveSha256, proof.inputSha256); assert.equal(fixture.items.length, 10);
  const imported = await page.evaluate(items => chrome.runtime.sendMessage({ type: 'VAULT_IMPORT_ITEMS', items }), fixture.items);
  assert.equal(imported.ok, true, JSON.stringify(imported)); assert.equal(imported.data.length, 10);
  const saved = await Promise.all(imported.data.map(item => readItem(page, item.id)));
  await page.reload(); await page.getByRole('heading', { name: '全部项目', exact: true }).waitFor();
  for (const title of ['Credential project edited', 'Credential project copy']) {
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.getByLabel('搜索密码库', { exact: true }).fill(title);
    await page.getByLabel(`查看${title}详情`, { exact: true }).first().click();
    await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button', { name: '编辑', exact: true }).click();
    const form = loginEditor(page), groups = form.locator('[data-credential-group]');
    await expect(groups).toHaveCount(3);
    const original = title.endsWith('edited');
    await expect(groups.nth(0).getByLabel('用户名', { exact: true })).toHaveValue(original ? 'android-user' : 'browser-user');
    await expect(groups.nth(0).getByLabel('密码 3', { exact: true })).toHaveValue(original ? 'android-final-password' : 'browser-added-password');
    await expect(groups.nth(0).getByLabel('内嵌验证码密钥', { exact: true })).toHaveValue('');
    await expect(groups.nth(0).getByLabel('密码 1', { exact: true })).toHaveValue('second-password');
    await expect(groups.nth(1).getByLabel('用户名', { exact: true })).toHaveValue('third-user');
    await expect(groups.nth(2).getByLabel('用户名', { exact: true })).toHaveValue('recovery-user');
    for (const width of [420, 320]) {
      await page.setViewportSize({ width, height: 950 }); await groups.nth(0).scrollIntoViewIfNeeded();
      const geometries = await form.locator('[data-project-credential-editor]').evaluateAll(elements => elements.map(el => ({ client: el.clientWidth, scroll: el.scrollWidth })));
      assert.ok(geometries.every(geometry => geometry.scroll <= geometry.client + 1));
      await screenshot(page, `android-project-${original ? 'edited' : 'copy'}-${width}.png`);
    }
    await form.getByRole('button', { name: '取消', exact: true }).click(); await form.waitFor({ state: 'hidden' });
  }
  for (const item of saved) assert.deepEqual(await readItem(page, item.id), item);
  evidence.projectCredentialReturn = { status: 'passed', archiveSha256: fixture.archiveSha256, androidVersion: fixture.androidVersion,
    layer: 'Actual Android-return ZIP decoded by production codec; imported via runtime into isolated local extension, inspected in real Edge UI', saved };
  await page.setViewportSize({ width: 1280, height: 900 });
}

export async function verifyProjectCredentialReturn(page, evidence) {
  for (const item of evidence.projectCredentialReturn.saved) assert.deepEqual(await readItem(page, item.id), item);
  evidence.projectCredentialReturn.restartVerified = true;
}
