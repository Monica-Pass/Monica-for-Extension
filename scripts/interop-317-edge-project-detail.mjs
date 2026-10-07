import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { readItem } from './interop-315-edge-features.mjs';

/** Inspect the exact, previously verified Android-return rows without editing them. */
export async function runProjectDetailUi({ page, evidence, screenshot }) {
  const saved = evidence.projectCredentialReturn?.saved;
  assert.ok(saved?.length, 'Run --project-credentials-return before --project-detail');
  const projects = [...new Set(saved.map(item => item.passwordGroupId))];
  if (evidence.projectSingleton) {
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.getByLabel('搜索密码库', { exact: true }).fill('');
    const nav = page.getByRole('button', { name: /^登录项/ });
    await expect(nav.locator('.nav-count')).toHaveText('3');
    await nav.click();
    await expect(page.locator('.credential-table tbody tr')).toHaveCount(3);
    await expect(page.locator('.credential-table').getByText('5 条密码', { exact: false })).toHaveCount(2);
    await page.getByRole('button', { name: /^全部项目/ }).click();
  }
  for (const [projectIndex, projectId] of projects.entries()) {
    const rows = saved.filter(item => item.passwordGroupId === projectId);
    const metadata = item => JSON.parse(item.customFields.find(field => field.name === 'monica.content.credential').value);
    const groupIds = [...new Set(rows.map(item => metadata(item).groupId))].sort((a, b) => metadata(rows.find(row => metadata(row).groupId === a)).groupOrder - metadata(rows.find(row => metadata(row).groupId === b)).groupOrder);
    const title = rows[0].title;
    await page.setViewportSize({ width: 1280, height: 950 });
    await page.getByLabel('搜索密码库', { exact: true }).fill(title);
    await page.getByLabel(`查看${title}详情`, { exact: true }).first().click();
    const detail = page.locator('[role="dialog"][data-item-kind="login"]');
    const navigation = detail.locator('[data-project-navigation]');
    await expect(navigation.getByText(`${groupIds.length} 个凭据组 · ${rows.length} 条密码`, { exact: true })).toBeVisible();
    await expect(navigation.locator('[data-project-group]')).toHaveCount(groupIds.length);
    for (const [groupIndex, groupId] of groupIds.entries()) {
      const groupRows = rows.filter(item => metadata(item).groupId === groupId).sort((a, b) => metadata(a).passwordOrder - metadata(b).passwordOrder);
      const groupLabel = metadata(groupRows[0]).label || `凭据组 ${groupIndex + 1}`;
      for (const [passwordIndex, row] of groupRows.entries()) {
        const button = navigation.locator(`[data-password-member-id="${row.id}"]`).getByRole('button');
        await button.focus(); await button.press('Enter');
        await expect(button).toHaveAttribute('aria-current', 'true');
        await expect(button).toBeFocused();
        await expect(detail.getByRole('heading', { name: `${groupLabel} · 密码 ${passwordIndex + 1}`, exact: true })).toBeVisible();
        assert.equal(await navigation.locator('[aria-current="true"]').count(), 1);
        // Selecting a different row remounts the protected values in a hidden state.
        await expect(detail.getByRole('button', { name: '显示密码', exact: true })).toBeVisible();
        await detail.getByRole('button', { name: '显示密码', exact: true }).click();
        await expect(detail.locator('.detail-field-value').filter({ hasText: row.password })).toContainText(row.password);
        assert.ok(!(await navigation.innerText()).includes(row.password));
        await detail.getByRole('button', { name: '隐藏密码', exact: true }).click();
      }
    }
    for (const width of [420, 320]) {
      await page.setViewportSize({ width, height: 950 });
      await navigation.scrollIntoViewIfNeeded();
      const geometry = await navigation.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      assert.ok(geometry.scroll <= geometry.client + 1);
      for (const target of await navigation.locator('[data-password-member-id]').all()) {
        const box = await target.boundingBox(); assert.ok(box.height >= 48 && box.width >= 48);
      }
      await screenshot(page, `android-project-detail-${projectIndex}-${width}.png`);
    }
    await detail.getByRole('button', { name: '关闭', exact: true }).last().click(); await detail.waitFor({ state: 'hidden' });
  }
  for (const item of saved) assert.deepEqual(await readItem(page, item.id), item);
  evidence.projectDetail = { status: 'passed', archiveSha256: evidence.projectCredentialReturn.archiveSha256,
    checks: ['actual Android-return rows', 'group and password counts', 'ordered labeled groups',
      'keyboard selection and retained focus', 'one accessible current row', 'correct password reveal per original row',
      'no secrets in navigation', '420/320px no overflow and 48px targets', 'all rows remain byte-for-byte unchanged'] };
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('搜索密码库', { exact: true }).fill('');
}
