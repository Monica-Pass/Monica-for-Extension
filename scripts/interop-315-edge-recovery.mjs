import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function runRecoveryUiCheck({ page, fixture, evidence, screenshot }) {
  await page.getByRole("button", { name: "密码源", exact: true }).click();
  const section = page.locator(".pending-moves"), row = section.locator(`[data-move-operation="${fixture.operationId}"]`);
  await expect(row).toBeVisible();
  await screenshot(page, "recovery-locked.png");
  const vaultCount = new Set([fixture.sourceProviderId, fixture.targetProviderId]).size;
  for (let index = 0; index < vaultCount; index++) {
    await row.getByRole("button", { name: "解锁并设置", exact: true }).click();
    const dialog = page.locator(".mdbx2-dialog");
    await dialog.getByLabel("保险库密码（可留空）", { exact: true }).fill("Synthetic transfer fixture password");
    await dialog.getByRole("button", { name: "解锁本机副本", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "解锁本机副本", exact: true })).toHaveCount(0, { timeout: 60000 });
    await dialog.getByRole("button", { name: "关闭 MDBX2 设置", exact: true }).click();
  }
  await row.getByRole("button", { name: "查看并继续", exact: true }).click();
  const continueButton = row.getByRole("button", { name: "核对并继续", exact: true });
  await expect(continueButton).toBeDisabled();
  const checkbox = row.locator("m3e-checkbox");
  await expect(checkbox).toBeFocused();
  await page.keyboard.press("Space");
  await expect(continueButton).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(row.locator(".pending-confirm")).toHaveCount(0);
  await expect(row.locator("[data-move-open]")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(checkbox).toBeFocused();
  await expect(continueButton).toBeDisabled();
  await row.locator(".pending-confirm").scrollIntoViewIfNeeded();
  await screenshot(page, "recovery-confirm.png");
  await page.setViewportSize({ width: 420, height: 920 });
  await row.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await screenshot(page, "recovery-confirm-narrow.png");
  await row.getByRole("button", { name: "稍后处理", exact: true }).click();
  await expect(row.locator(".pending-confirm")).toHaveCount(0);
  const before = await page.evaluate(() => chrome.runtime.sendMessage({ type: "MDBX2_PENDING_MOVES" }));
  assert.equal(before.ok, true); assert.equal(before.data.length, 1);
  await row.getByRole("button", { name: "查看并继续", exact: true }).click();
  await row.locator(".pending-check").click();
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(row).toHaveCount(0, { timeout: 60000 });
  await expect(section.getByText("移动已恢复。", { exact: true })).toBeVisible();
  await expect(section.locator("[data-move-refresh]")).toBeFocused();
  const after = await page.evaluate(() => chrome.runtime.sendMessage({ type: "MDBX2_PENDING_MOVES" }));
  assert.equal(after.ok, true); assert.equal(after.data.length, 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await screenshot(page, "recovery-completed.png");
  evidence.recoveryUi = { passed: true, operationId: fixture.operationId, lockedVaultsOpenedThroughUi: true,
    unlockedVaultCount: vaultCount,
    explicitConfirmationRequired: true, cancelPreservesJournal: true, keyboardConfirmationAndEscape: true,
    focusRestored: true, narrowNoOverflow: true, resumedViaActualNative: true };
}
