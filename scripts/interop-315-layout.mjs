import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function runLayoutReview({ page, evidence, screenshot }) {
  const before = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
  assert.equal(before.ok, true);
  evidence.layoutChecks = [];
  for (const kind of ["PASSWORD", "GPG_KEY", "API_KEY", "card", "identity", "billing-address"]) {
    await page.getByRole("button", { name: "选择新建类型", exact: true }).click();
    await page.locator(`m3e-menu-item[data-create-type="${kind}"]`).click();
    const editor = page.locator("m3e-dialog").filter({ has: page.locator("#login-item-form, #vault-item-form") });
    const title = editor.getByLabel("名称 *", { exact: true });
    await title.fill(`Synthetic ${kind}`);
    await title.scrollIntoViewIfNeeded();
    await screenshot(page, `layout-${kind}-desktop.png`);
    await page.setViewportSize({ width: 420, height: 860 });
    await title.scrollIntoViewIfNeeded();
    await expect(editor.getByRole("button", { name: "加密保存", exact: true })).toBeVisible();
    const bounds = await editor.locator('dialog').evaluate(node => {
      const rect=node.getBoundingClientRect();
      return {left:rect.left,top:rect.top,width:rect.width,height:rect.height};
    });
    assert.ok(Math.abs(bounds.left)<1 && Math.abs(bounds.top)<1 && Math.abs(bounds.width-420)<1 && Math.abs(bounds.height-860)<1, `${kind} editor must fill the portrait viewport`);
    const overflow = await editor.evaluate(node => [...node.querySelectorAll("m3e-form-field")].filter(field => {
      const rect = field.getBoundingClientRect();
      return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
    }).length);
    assert.equal(overflow, 0, `${kind} fields overflow the narrow viewport`);
    await screenshot(page, `layout-${kind}-narrow.png`);
    await editor.getByRole("button", { name: "取消", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1280, height: 860 });
    evidence.layoutChecks.push({ kind, status: "passed", viewports: [1280, 420], saveVisible: true, fieldOverflow: false });
  }
  const after = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
  assert.deepEqual(after, before, "Cancelled layout drafts changed vault records");
}
