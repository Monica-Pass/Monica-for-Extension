import { chromium, expect, test, type BrowserContext, type Locator } from "@playwright/test";
import path from "node:path";
import { installMdbx2TigaMock } from "./fixtures/mdbx2";

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  expect(await locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

async function expectCentered(container: Locator, icon: Locator): Promise<void> {
  const [containerBox, iconBox] = await Promise.all([container.boundingBox(), icon.boundingBox()]);
  expect(containerBox).not.toBeNull();
  expect(iconBox).not.toBeNull();
  expect(Math.abs((containerBox!.x + containerBox!.width / 2) - (iconBox!.x + iconBox!.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs((containerBox!.y + containerBox!.height / 2) - (iconBox!.y + iconBox!.height / 2))).toBeLessThanOrEqual(1);
}

test("MDBX2 diagnostics refresh safely and remain readable in narrow large-text dark mode", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-diagnostics-profile"), {
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
    }, "mdbx2 diagnostics password")).toMatchObject({ ok: true });

    await installMdbx2TigaMock(page);
    await page.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>;
      let diagnosticsRequests = 0;
      const counts = {
        commitCount: 24,
        tombstoneCount: 3,
        branchCount: 2,
        deviceCount: 2,
        snapshotCount: 4,
        unresolvedConflictCount: 1,
        projectCount: 7,
        folderCount: 6,
        deletedProjectCount: 1,
        entryCount: 1234,
        deletedEntryCount: 8,
        attachmentCount: 5,
        deletedAttachmentCount: 1,
        externalAttachmentCount: 4,
        originalAttachmentBytes: 5242880,
        storedAttachmentBytes: 3145728
      };
      const warningReport = {
        checkedAtUnixSeconds: 1785648000,
        fileSizeBytes: 2097152,
        formatVersion: "MDBX-2",
        schemaVersion: 17,
        health: {
          healthy: true,
          issueCount: 2,
          infoCount: 1,
          warningCount: 1,
          errorCount: 0,
          criticalCount: 0,
          categories: [
            { category: "stale-heads", count: 1, highestSeverity: "warning" },
            { category: "other", count: 1, highestSeverity: "info" }
          ],
          issueKinds: [
            { kind: "inactive-device", count: 1, highestSeverity: "warning" },
            { kind: "unknown", count: 1, highestSeverity: "info" }
          ]
        },
        diagnostics: counts,
        filePath: "C:\\private\\vault.mdbx",
        vaultId: "private-vault-id",
        deviceId: "private-device-id",
        rawDescription: "private raw Core issue description"
      };
      const dangerReport = {
        checkedAtUnixSeconds: 1785648060,
        fileSizeBytes: 3145728,
        formatVersion: "MDBX-2",
        schemaVersion: 17,
        health: {
          healthy: false,
          issueCount: 3,
          infoCount: 0,
          warningCount: 1,
          errorCount: 1,
          criticalCount: 1,
          categories: [
            { category: "vault-header-integrity", count: 1, highestSeverity: "error" },
            { category: "commit-chain", count: 1, highestSeverity: "critical" },
            { category: "attachment-chunks", count: 1, highestSeverity: "warning" }
          ],
          issueKinds: [
            { kind: "header-authentication-failed", count: 1, highestSeverity: "error" },
            { kind: "commit-reference-missing", count: 1, highestSeverity: "critical" },
            { kind: "attachment-structure", count: 1, highestSeverity: "warning" }
          ]
        },
        diagnostics: { ...counts, unresolvedConflictCount: 2, folderCount: 12, projectCount: 13, entryCount: 1245 }
      };
      (window as Window & { __mdbx2DiagnosticsRequests?: number }).__mdbx2DiagnosticsRequests = diagnosticsRequests;

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: Record<string, unknown>) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message as { type?: string });
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, {
              id: "mdbx2-diagnostics-demo",
              kind: "mdbx2",
              name: "健康检查演示库",
              enabled: true,
              isDefaultSaveTarget: false,
              config: { remotePath: "Monica/MDBX2/diagnostics.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true }
            }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "974c517465e7b6cac0947d2d59875aa4211fa16b" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "11111111-1111-4111-8111-111111111111", open: true, available: true } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: false, pendingBootstrap: false, pendingSegment: false, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 4 } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") {
            diagnosticsRequests += 1;
            (window as Window & { __mdbx2DiagnosticsRequests?: number }).__mdbx2DiagnosticsRequests = diagnosticsRequests;
            if (diagnosticsRequests === 2) return { ok: false, error: "MDBX2 vault diagnostics failed.", code: "vault-diagnostics-failed" };
            if (diagnosticsRequests >= 3) await new Promise((resolve) => setTimeout(resolve, 300));
            return { ok: true, data: diagnosticsRequests >= 3 ? dangerReport : warningReport };
          }
          if (message.type === "MDBX2_COLLECTION_LIST" || message.type === "MDBX2_CONFLICT_LIST" || message.type === "MDBX2_SNAPSHOT_LIST" || message.type === "MDBX2_HISTORY_LIST") return { ok: true, data: { items: [] } };
          return originalSend(message as { type?: string });
        }
      });
    });

    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: "管理 MDBX2" }).click();

    const dialog = page.getByRole("dialog", { name: "管理 健康检查演示库" });
    const panel = dialog.locator(".mdbx2-diagnostics-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("border-radius", "8px");
    await expect(panel).toHaveCSS("background-image", "none");
    await expect(panel.getByText("发现 2 项需要关注的诊断信号", { exact: true })).toBeVisible();
    await expect(panel.getByText("存在长期未活动设备", { exact: true })).toBeVisible();
    await expect(panel.getByText("发现未识别的数据库异常", { exact: true })).toBeVisible();
    await expect(panel.getByText("设备与分支 Head", { exact: true })).toBeVisible();
    await expect(panel.getByText("其他兼容性信号", { exact: true })).toBeVisible();
    await expect(panel).not.toContainText("stale-heads");
    await expect(panel).not.toContainText("inactive-device");
    await expect(dialog).not.toContainText("C:\\private\\vault.mdbx");
    await expect(dialog).not.toContainText("private-vault-id");
    await expect(dialog).not.toContainText("private-device-id");
    await expect(dialog).not.toContainText("private raw Core issue description");

    const refresh = panel.getByRole("button", { name: "刷新保险库诊断" });
    expect((await refresh.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expectCentered(panel.locator(".mdbx2-diagnostics-health-icon"), panel.locator(".mdbx2-diagnostics-health-icon m3e-icon"));
    const inactiveGuidance = panel.locator(".mdbx2-health-guidance-row", { hasText: "存在长期未活动设备" });
    await inactiveGuidance.locator("summary").click();
    await expect(inactiveGuidance).toHaveAttribute("open", "");
    await expect(inactiveGuidance.getByText("这通常只是状态提示，不代表数据库内容损坏。", { exact: true })).toBeVisible();
    const historyAction = inactiveGuidance.getByRole("button", { name: "查看提交历史" });
    expect((await historyAction.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await historyAction.click();
    await expect(dialog.locator(".mdbx2-history-panel")).toBeFocused();
    await panel.scrollIntoViewIfNeeded();
    await refresh.click();
    await expect(panel.getByRole("alert")).toContainText("无法完成只读健康检查");
    await expect(panel.getByText("发现 2 项需要关注的诊断信号", { exact: true })).toBeVisible();

    await refresh.click();
    await expect(panel).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toBeDisabled();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.getByText("发现 2 项高优先级问题", { exact: true })).toBeVisible();
    await expect(panel.getByText("保险库头认证", { exact: true })).toBeVisible();
    await expect(panel.getByText("提交链", { exact: true })).toBeVisible();
    await expect(panel.getByText("附件分片", { exact: true })).toBeVisible();
    await expect(panel.getByText("数据库身份校验失败", { exact: true })).toBeVisible();
    await expect(panel.getByText("历史记录引用不完整", { exact: true })).toBeVisible();
    await expect(panel.getByText("附件分片不完整", { exact: true })).toBeVisible();
    await expect(panel.locator(".mdbx2-diagnostics-key-facts > div").nth(1).locator("dd")).toHaveText("2");
    expect(await page.evaluate(() => (window as Window & { __mdbx2DiagnosticsRequests?: number }).__mdbx2DiagnosticsRequests)).toBe(3);
    await panel.locator(".mdbx2-health-guidance-row").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("mdbx2-health-guidance-dark-375-200.png") });

    const details = panel.locator(".mdbx2-diagnostics-details");
    await expect(details).not.toHaveAttribute("open", "");
    await details.getByText("查看聚合统计", { exact: true }).click();
    await expect(details).toHaveAttribute("open", "");
    await expect(details.getByText("1,245", { exact: true })).toBeVisible();
    await expect(details.getByText("3 MiB", { exact: true })).toBeVisible();
    await expectCentered(panel.locator(".mdbx2-diagnostics-category-icon").first(), panel.locator(".mdbx2-diagnostics-category-icon m3e-icon").first());
    await expectCentered(panel.locator(".mdbx2-health-guidance-icon").first(), panel.locator(".mdbx2-health-guidance-icon m3e-icon").first());

    const attachmentGuidance = panel.locator(".mdbx2-health-guidance-row", { hasText: "附件分片不完整" });
    await attachmentGuidance.locator("summary").click();
    await attachmentGuidance.getByRole("button", { name: "查看附件统计" }).click();
    await expect(panel.locator("#mdbx2-diagnostics-attachment-title").locator("..")).toBeFocused();

    expect(await panel.evaluate((element) => [...element.querySelectorAll("*")].every((child) => !getComputedStyle(child).backgroundImage.includes("gradient")))).toBe(true);
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches && matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await expectNoHorizontalOverflow(panel);
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-diagnostics-dark-375-200.png"), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await panel.locator(".mdbx2-health-guidance-row").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("mdbx2-health-guidance-dark-375.png") });
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: testInfo.outputPath("mdbx2-diagnostics-panel-dark-375.png") });
    await page.screenshot({ path: testInfo.outputPath("mdbx2-diagnostics-viewport-dark-375.png") });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(true);
    await expect(panel).toHaveCSS("background-image", "none");
    await expectNoHorizontalOverflow(panel);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-diagnostics-viewport-light-375.png") });
  } finally {
    await context?.close();
  }
});
