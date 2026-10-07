import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function runNavigationReview({ page, evidence, screenshot }) {
  const nav = page.locator('.portrait-navigation');
  await expect(nav).toBeHidden();
  await page.setViewportSize({ width: 420, height: 860 });
  await expect(nav).toBeVisible();
  for (const title of ['登录项', '动态验证码', '钱包与身份']) {
    const tab = nav.locator('m3e-nav-item').filter({ hasText: title });
    await tab.click();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(tab).toHaveAttribute('aria-current', 'true');
    await expect.poll(() => tab.evaluate(node => node.selected)).toBe(true);
  }
  const more = nav.locator('.portrait-navigation-more');
  await more.click();
  await expect(page.locator('#primary-navigation')).toHaveAttribute('aria-modal', 'true');
  await expect(nav).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await expect(nav.locator('m3e-nav-item[selected]')).toContainText('钱包与身份');
  await more.press('Enter');
  await page.locator('#primary-navigation').getByRole('button', { name: /^安全笔记/ }).click();
  await expect(page.getByRole('heading', { name: '安全笔记', exact: true })).toBeVisible();
  await expect(page.locator('#main-content')).toBeFocused();
  await nav.locator('m3e-nav-item').filter({ hasText: '钱包与身份' }).click();
  await page.getByRole('button', { name: '选择新建类型', exact: true }).click();
  await page.locator('m3e-menu-item[data-create-type="card"]').click();
  const editor = page.locator('m3e-dialog').filter({ has: page.locator('#vault-item-form') });
  await editor.getByLabel('名称 *', { exact: true }).fill('Synthetic portrait card');
  await editor.getByLabel('银行卡号 *', { exact: true }).fill('4242424242424242');
  await editor.getByLabel('持卡人', { exact: true }).fill('MONICA TEST');
  await editor.getByRole('button', { name: '加密保存', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const tile = page.locator('.vault-tile').filter({ hasText: 'Synthetic portrait card' });
  await expect(tile.locator('.wallet-card-face')).toBeVisible();
  for (const width of [420, 320]) {
    await page.setViewportSize({ width, height: 860 });
    await tile.evaluate(node => node.scrollIntoView({ block: 'end', behavior: 'instant' }));
    const geometry = await page.evaluate(() => {
      const bar = document.querySelector('.portrait-navigation').getBoundingClientRect();
      const face = document.querySelector('.vault-tile').getBoundingClientRect();
      const main = getComputedStyle(document.querySelector('#main-content'));
      return { overflow: document.documentElement.scrollWidth > innerWidth, navTop: bar.top, navBottom: bar.bottom, faceBottom: face.bottom, inset: main.paddingLeft };
    });
    assert.equal(geometry.overflow, false);
    assert.equal(geometry.inset, '12px');
    assert.equal(geometry.navBottom, 860);
    assert.ok(geometry.faceBottom <= geometry.navTop, 'Entire card including its actions must remain above navigation after scrolling');
    await screenshot(page, `navigation-wallet-${width}.png`);
  }
  await page.setViewportSize({ width: 420, height: 860 });
  await tile.getByLabel('查看Synthetic portrait card详情', { exact: true }).click();
  const detail = page.locator('[role="dialog"][data-item-kind="card"]');
  await expect(detail).toBeVisible();
  await expect(nav).toHaveAttribute('inert', '');
  await screenshot(page, 'navigation-wallet-detail-420.png');
  await detail.getByLabel('关闭详情', { exact: true }).click();
  await more.click();
  await page.setViewportSize({ width: 1280, height: 860 });
  await expect(nav).toBeHidden();
  await expect(page.locator('#primary-navigation')).not.toHaveAttribute('aria-modal', 'true');
  await page.locator('#primary-navigation').getByRole('button', { name: /^全部项目/ }).click();
  evidence.navigationChecks = { status: 'passed', widths: [1280, 420, 320], drawerFocus: true, keyboard: true, selectedState: true, cardAboveNavigation: true, desktopRestore: true };
}
