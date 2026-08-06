import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, test, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import path from "node:path";
import { installMdbx2TigaMock } from "./fixtures/mdbx2";

const PROVIDER_ID = "mdbx2-health-repair-demo";
const PLAN_HANDLE = "11111111-1111-4111-8111-111111111111";
const FIRST_ITEM_HANDLE = "22222222-2222-4222-8222-222222222222";
const SECOND_ITEM_HANDLE = "33333333-3333-4333-8333-333333333333";

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const result = await locator.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const offenders = [element, ...element.querySelectorAll<HTMLElement>("*")]
      .map((child) => {
        const rect = child.getBoundingClientRect();
        return {
          tag: child.tagName.toLowerCase(),
          className: typeof child.className === "string" ? child.className : "",
          text: child.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) || "",
          clientWidth: child.clientWidth,
          scrollWidth: child.scrollWidth,
          rightOverflow: Math.round((rect.right - root.right) * 10) / 10
        };
      })
      .filter((item) => item.scrollWidth > item.clientWidth + 1 || item.rightOverflow > 1)
      .sort((left, right) => Math.max(right.scrollWidth - right.clientWidth, right.rightOverflow) - Math.max(left.scrollWidth - left.clientWidth, left.rightOverflow))
      .slice(0, 8);
    return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, offenders };
  });
  expect(result.scrollWidth, JSON.stringify(result.offenders, null, 2)).toBeLessThanOrEqual(result.clientWidth + 1);
}

async function launchManager(testInfo: TestInfo, profileName: string): Promise<{ context: BrowserContext; page: Page }> {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath(profileName), {
    channel: "chromium",
    headless: true,
    colorScheme: "dark",
    reducedMotion: "reduce",
    viewport: { width: 375, height: 1100 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  expect(await page.evaluate(async (masterPassword) => {
    const status = await chrome.runtime.sendMessage({ type: "VAULT_STATUS" }) as { ok: boolean; data?: "uninitialized" | "locked" | "unlocked" };
    if (status.data === "uninitialized") return chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword });
    if (status.data === "locked") return chrome.runtime.sendMessage({ type: "VAULT_UNLOCK", masterPassword });
    return { ok: true };
  }, "mdbx2 health repair e2e password")).toMatchObject({ ok: true });
  await installMdbx2TigaMock(page);
  return { context, page };
}

async function openMdbx2Manager(page: Page): Promise<Locator> {
  await page.reload();
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  await page.getByRole("button", { name: "打开导航" }).click();
  await page.getByRole("button", { name: "密码源" }).click();
  await page.getByRole("button", { name: "管理 MDBX2" }).click();
  const dialog = page.getByRole("dialog", { name: "管理 健康修复演示库" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("MDBX2 health repair reviews conflicts sequentially and safely recovers a lost response", async ({}, testInfo) => {
  test.setTimeout(90_000);
  let context: BrowserContext | undefined;
  try {
    const launched = await launchManager(testInfo, "mdbx2-health-repair-conflicts");
    context = launched.context;
    const page = launched.page;
    await page.addInitScript(({ providerId, planHandle, firstItemHandle, secondItemHandle }) => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>;
      let planRequests = 0;
      let applyRequests = 0;
      let repaired = false;
      const applyPayloads: Record<string, unknown>[] = [];
      const counts = {
        commitCount: 12, tombstoneCount: 4, branchCount: 1, deviceCount: 2, snapshotCount: 2,
        unresolvedConflictCount: 0, projectCount: 4, folderCount: 3, deletedProjectCount: 0,
        entryCount: 20, deletedEntryCount: 2, attachmentCount: 3, deletedAttachmentCount: 1,
        externalAttachmentCount: 2, originalAttachmentBytes: 4096, storedAttachmentBytes: 3072
      };
      const unhealthy = {
        checkedAtUnixSeconds: 1785648000,
        fileSizeBytes: 8192,
        formatVersion: "MDBX-2",
        schemaVersion: 17,
        health: {
          healthy: false,
          issueCount: 3,
          infoCount: 0,
          warningCount: 0,
          errorCount: 3,
          criticalCount: 0,
          categories: [{ category: "tombstones", count: 3, highestSeverity: "error" }],
          issueKinds: [
            { kind: "tombstone-missing", count: 1, highestSeverity: "error" },
            { kind: "tombstone-stale", count: 2, highestSeverity: "error" }
          ]
        },
        diagnostics: counts
      };
      const healthy = {
        ...unhealthy,
        checkedAtUnixSeconds: 1785648060,
        health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
        diagnostics: { ...counts, commitCount: 13, tombstoneCount: 2, snapshotCount: 3, deletedEntryCount: 3 }
      };
      const plan = {
        planHandle,
        canApply: true,
        itemCount: 3,
        automaticCount: 1,
        conflictCount: 2,
        blockerCount: 0,
        automatic: [{ kind: "missing-tombstone", objectType: "entry", itemCount: 1, tombstoneCount: 0 }],
        conflicts: [
          { itemHandle: firstItemHandle, kind: "active-object-tombstone-conflict", objectType: "entry", tombstoneCount: 1 },
          { itemHandle: secondItemHandle, kind: "active-object-tombstone-conflict", objectType: "attachment", tombstoneCount: 2 }
        ],
        blockers: []
      };
      const expose = () => {
        (window as Window & { __mdbx2HealthRepair?: unknown }).__mdbx2HealthRepair = { planRequests, applyRequests, applyPayloads };
      };
      expose();
      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: Record<string, unknown>) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message as { type?: string });
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, {
              id: providerId,
              kind: "mdbx2",
              name: "健康修复演示库",
              enabled: true,
              isDefaultSaveTarget: false,
              config: { remotePath: "Monica/MDBX2/health-repair.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true }
            }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "974c517465e7b6cac0947d2d59875aa4211fa16b" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "44444444-4444-4444-8444-444444444444", open: true, available: true } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: repaired, pendingBootstrap: false, pendingSegment: repaired, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 2 } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") return { ok: true, data: repaired ? healthy : unhealthy };
          if (message.type === "MDBX2_HEALTH_REPAIR_PLAN") {
            planRequests += 1;
            expose();
            return { ok: true, data: plan };
          }
          if (message.type === "MDBX2_HEALTH_REPAIR_APPLY") {
            applyRequests += 1;
            applyPayloads.push(structuredClone(message));
            expose();
            if (applyRequests === 1) return { ok: false, error: "Host disconnected", code: "native-host-disconnected" };
            repaired = true;
            return { ok: true, data: { status: "applied", repairedCount: 3, alreadyApplied: true, recoveryPointCreated: true, health: healthy.health } };
          }
          if (message.type === "MDBX2_COLLECTION_LIST" || message.type === "MDBX2_CONFLICT_LIST" || message.type === "MDBX2_SNAPSHOT_LIST" || message.type === "MDBX2_HISTORY_LIST") return { ok: true, data: { items: [] } };
          return originalSend(message as { type?: string });
        }
      });
    }, { providerId: PROVIDER_ID, planHandle: PLAN_HANDLE, firstItemHandle: FIRST_ITEM_HANDLE, secondItemHandle: SECOND_ITEM_HANDLE });

    const dialog = await openMdbx2Manager(page);
    const diagnostics = dialog.locator(".mdbx2-diagnostics-panel");
    const planButton = diagnostics.getByRole("button", { name: "检查 Native Host 可安全处理的问题" });
    await planButton.click();
    let repair = diagnostics.locator(".mdbx2-health-repair");
    await expect(repair).toBeVisible();
    await expect(repair).toHaveCSS("background-image", "none");
    await expect(repair.getByText("补齐条目删除标记", { exact: true })).toBeVisible();
    await expect(repair.getByText("条目内容与删除状态冲突", { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText(PLAN_HANDLE);
    await expect(dialog).not.toContainText(FIRST_ITEM_HANDLE);
    await expect(dialog).not.toContainText(SECOND_ITEM_HANDLE);

    await repair.getByRole("button", { name: "取消全部" }).click();
    await expect(repair).toHaveCount(0);
    expect(await page.evaluate(() => (window as Window & { __mdbx2HealthRepair?: { applyRequests: number } }).__mdbx2HealthRepair?.applyRequests)).toBe(0);

    await planButton.click();
    repair = diagnostics.locator(".mdbx2-health-repair");
    await repair.getByRole("button", { name: "保留内容" }).click();
    await expect(repair.getByText("附件内容与删除状态冲突", { exact: true })).toBeVisible();
    await repair.getByRole("button", { name: "删除项目" }).click();
    await expect(repair.getByText("确认删除这个项目？", { exact: true })).toBeVisible();
    await repair.getByRole("button", { name: "返回选择" }).click();
    await repair.getByRole("button", { name: "删除项目" }).click();
    const confirmDelete = repair.getByRole("button", { name: "确认删除项目并继续" });
    expect((await confirmDelete.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await confirmDelete.click();

    await expect(repair.getByText("复核处理计划", { exact: true })).toBeVisible();
    const reviewCounts = repair.locator(".mdbx2-health-repair-review-counts > div");
    await expect(reviewCounts.nth(0).locator("dd")).toHaveText("1");
    await expect(reviewCounts.nth(1).locator("dd")).toHaveText("1");
    await expect(reviewCounts.nth(2).locator("dd")).toHaveText("1");
    const applyButton = repair.getByRole("button", { name: "创建恢复快照并处理健康修复计划" });
    await expect(applyButton).toBeFocused();
    await expect(applyButton).toContainText("确认处理");
    expect((await applyButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    const accessibility = await new AxeBuilder({ page }).include(".mdbx2-health-repair").analyze();
    expect(accessibility.violations.filter((violation) => ["serious", "critical"].includes(violation.impact || ""))).toEqual([]);
    expect(await repair.evaluate((element) => [...element.querySelectorAll("*")].every((child) => !getComputedStyle(child).backgroundImage.includes("gradient")))).toBe(true);
    await expectNoHorizontalOverflow(repair);
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-health-repair-review-dark-375-200.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    const lightAccessibility = await new AxeBuilder({ page }).include(".mdbx2-health-repair").analyze();
    expect(lightAccessibility.violations.filter((violation) => ["serious", "critical"].includes(violation.impact || ""))).toEqual([]);
    expect(await repair.evaluate((element) => [...element.querySelectorAll("*")].every((child) => !getComputedStyle(child).backgroundImage.includes("gradient")))).toBe(true);
    await expectNoHorizontalOverflow(repair);
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-health-repair-review-light-375-200.png"), fullPage: true });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });

    await page.keyboard.press("Enter");
    await expect(repair.getByRole("alert")).toContainText("原操作标识和选择仍保留");
    await expect(repair.getByRole("button", { name: "重试健康修复处理" })).toBeVisible();
    await expect(repair.getByRole("button", { name: "取消全部" })).toHaveCount(0);
    await repair.getByRole("button", { name: "重试健康修复处理" }).click();
    await expect(repair).toHaveCount(0);
    await expect(diagnostics.getByText("健康检查通过", { exact: true })).toBeVisible();

    const state = await page.evaluate(() => (window as Window & { __mdbx2HealthRepair?: { planRequests: number; applyRequests: number; applyPayloads: Array<Record<string, unknown>> } }).__mdbx2HealthRepair);
    expect(state?.planRequests).toBe(2);
    expect(state?.applyRequests).toBe(2);
    expect(state?.applyPayloads).toHaveLength(2);
    expect(state?.applyPayloads[0]).toMatchObject({
      type: "MDBX2_HEALTH_REPAIR_APPLY",
      providerId: PROVIDER_ID,
      planHandle: PLAN_HANDLE,
      decisions: [
        { itemHandle: FIRST_ITEM_HANDLE, choice: "keep-content" },
        { itemHandle: SECOND_ITEM_HANDLE, choice: "delete-object" }
      ],
      confirmedDelete: true
    });
    expect(state?.applyPayloads[1]).toEqual(state?.applyPayloads[0]);
  } finally {
    await context?.close();
  }
});

test("MDBX2 health repair presents blockers and fails closed for stale or unknown outcomes", async ({}, testInfo) => {
  test.setTimeout(90_000);
  let context: BrowserContext | undefined;
  try {
    const launched = await launchManager(testInfo, "mdbx2-health-repair-recovery");
    context = launched.context;
    const page = launched.page;
    await page.addInitScript(({ providerId }) => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>;
      let planRequests = 0;
      let applyRequests = 0;
      let diagnosticsRequests = 0;
      const report = {
        checkedAtUnixSeconds: 1785648000,
        fileSizeBytes: 8192,
        formatVersion: "MDBX-2",
        schemaVersion: 17,
        health: {
          healthy: false, issueCount: 2, infoCount: 0, warningCount: 0, errorCount: 2, criticalCount: 0,
          categories: [{ category: "integrity", count: 1, highestSeverity: "error" }, { category: "tombstones", count: 1, highestSeverity: "error" }],
          issueKinds: [{ kind: "basic-integrity", count: 1, highestSeverity: "error" }, { kind: "tombstone-missing", count: 1, highestSeverity: "error" }]
        },
        diagnostics: {
          commitCount: 2, tombstoneCount: 0, branchCount: 1, deviceCount: 1, snapshotCount: 0,
          unresolvedConflictCount: 0, projectCount: 2, folderCount: 1, deletedProjectCount: 0,
          entryCount: 2, deletedEntryCount: 1, attachmentCount: 0, deletedAttachmentCount: 0,
          externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0
        }
      };
      const automatic = [{ kind: "missing-tombstone", objectType: "entry", itemCount: 1, tombstoneCount: 0 }];
      const expose = () => {
        (window as Window & { __mdbx2HealthRepairRecovery?: unknown }).__mdbx2HealthRepairRecovery = { planRequests, applyRequests, diagnosticsRequests };
      };
      expose();
      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: Record<string, unknown>) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message as { type?: string });
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, { id: providerId, kind: "mdbx2", name: "健康修复演示库", enabled: true, isDefaultSaveTarget: false, config: { remotePath: "Monica/MDBX2/health-repair.mdbx", schemaVersion: 2 } }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "974c517465e7b6cac0947d2d59875aa4211fa16b" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "44444444-4444-4444-8444-444444444444", open: true, available: true } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: false, registered: false, initialized: false, hasLocalChanges: false, pendingBootstrap: false, pendingSegment: false, pendingRemoteAcknowledgement: false, remoteStreamCount: 0, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 0 } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") {
            diagnosticsRequests += 1;
            expose();
            return { ok: true, data: report };
          }
          if (message.type === "MDBX2_HEALTH_REPAIR_PLAN") {
            planRequests += 1;
            expose();
            if (planRequests === 1) return { ok: true, data: { planHandle: undefined, canApply: false, itemCount: 1, automaticCount: 1, conflictCount: 0, blockerCount: 1, automatic, conflicts: [], blockers: [{ category: "integrity", count: 1 }] } };
            return { ok: true, data: { planHandle: planRequests === 2 ? "55555555-5555-4555-8555-555555555555" : "66666666-6666-4666-8666-666666666666", canApply: true, itemCount: 1, automaticCount: 1, conflictCount: 0, blockerCount: 0, automatic, conflicts: [], blockers: [] } };
          }
          if (message.type === "MDBX2_HEALTH_REPAIR_APPLY") {
            applyRequests += 1;
            expose();
            return applyRequests === 1
              ? { ok: false, error: "stale", code: "health-repair-plan-stale" }
              : { ok: false, error: "unknown", code: "health-repair-outcome-unknown" };
          }
          if (message.type === "MDBX2_COLLECTION_LIST" || message.type === "MDBX2_CONFLICT_LIST" || message.type === "MDBX2_SNAPSHOT_LIST" || message.type === "MDBX2_HISTORY_LIST") return { ok: true, data: { items: [] } };
          return originalSend(message as { type?: string });
        }
      });
    }, { providerId: PROVIDER_ID });

    const dialog = await openMdbx2Manager(page);
    const diagnostics = dialog.locator(".mdbx2-diagnostics-panel");
    const planButton = diagnostics.getByRole("button", { name: "检查 Native Host 可安全处理的问题" });
    await planButton.click();
    let repair = diagnostics.locator(".mdbx2-health-repair");
    await expect(repair.getByText("当前不能自动处理", { exact: true })).toBeVisible();
    await expect(repair.getByText("数据库完整性", { exact: true })).toBeVisible();
    await expect(repair.getByRole("button", { name: "创建恢复快照并处理健康修复计划" })).toHaveCount(0);
    await repair.getByRole("button", { name: "关闭计划" }).click();
    expect(await page.evaluate(() => (window as Window & { __mdbx2HealthRepairRecovery?: { applyRequests: number } }).__mdbx2HealthRepairRecovery?.applyRequests)).toBe(0);

    await planButton.click();
    repair = diagnostics.locator(".mdbx2-health-repair");
    await expect(repair.getByText("复核处理计划", { exact: true })).toBeVisible();
    await expect(repair.getByRole("button", { name: "创建恢复快照并处理健康修复计划" })).toBeFocused();
    await repair.getByRole("button", { name: "创建恢复快照并处理健康修复计划" }).click();
    await expect(repair.getByText("处理计划需要更新", { exact: true })).toBeVisible();
    await expect(repair.getByText("旧计划已安全失效", { exact: false })).toBeVisible();
    await repair.getByRole("button", { name: "刷新并核对状态" }).click();
    await expect(repair).toHaveCount(0);

    await planButton.click();
    repair = diagnostics.locator(".mdbx2-health-repair");
    await repair.getByRole("button", { name: "创建恢复快照并处理健康修复计划" }).click();
    await expect(repair.getByText("需要核对处理结果", { exact: true })).toBeVisible();
    await expect(repair.getByText("不要立即选择相反结果", { exact: false })).toBeVisible();
    await expect(repair.getByRole("button", { name: "重试健康修复处理" })).toHaveCount(0);
    await repair.getByRole("button", { name: "刷新并核对状态" }).click();
    await expect(repair).toHaveCount(0);

    const state = await page.evaluate(() => (window as Window & { __mdbx2HealthRepairRecovery?: { planRequests: number; applyRequests: number; diagnosticsRequests: number } }).__mdbx2HealthRepairRecovery);
    expect(state?.planRequests).toBe(3);
    expect(state?.applyRequests).toBe(2);
    expect(state?.diagnosticsRequests).toBeGreaterThanOrEqual(3);
    await expectNoHorizontalOverflow(diagnostics);
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-health-repair-recovery-dark-375-200.png"), fullPage: true });
  } finally {
    await context?.close();
  }
});
