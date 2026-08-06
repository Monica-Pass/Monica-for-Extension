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

test("MDBX2 automatic snapshot cleanup uses an exact plan and safe stale or disconnect recovery", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  const planA = "a".repeat(64);
  const planB = "b".repeat(64);
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-snapshot-prune-profile"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 1000 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 snapshot prune password" }))).toMatchObject({ ok: true });

    await installMdbx2TigaMock(page);
    await page.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>;
      const planA = "a".repeat(64);
      const planB = "b".repeat(64);
      const executeTokens: string[] = [];
      let planCount = 0;
      let planBAttempts = 0;
      let cleaned = false;
      (window as Window & { __mdbx2SnapshotPruneTokens?: string[] }).__mdbx2SnapshotPruneTokens = executeTokens;

      const snapshot = (id: string, name: string, kind: "manual" | "automatic", bytes: number) => ({
        snapshotId: id,
        baseCommitId: `${id.slice(0, -1)}0`,
        name,
        kind,
        isFull: true,
        payloadBytes: bytes,
        createdAt: "2026-08-02T01:00:00Z",
        createdByDeviceId: "android-device",
        autoPrune: kind === "automatic",
        integrityOk: true
      });
      const manual = snapshot("11111111-1111-4111-8111-111111111111", "升级前", "manual", 4096);
      const automaticA = snapshot("22222222-2222-4222-8222-222222222222", "Auto 2026-08-01", "automatic", 1024);
      const automaticB = snapshot("33333333-3333-4333-8333-333333333333", "Auto 2026-08-02", "automatic", 512);

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: { type?: string; planToken?: string }) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, {
              id: "mdbx2-prune-demo",
              kind: "mdbx2",
              name: "自动快照演示库",
              enabled: true,
              isDefaultSaveTarget: false,
              config: { remotePath: "Monica/MDBX2/prune.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true }
            }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "aafa22f195c626a8d8288d712bf42bccea134847" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "44444444-4444-4444-8444-444444444444", open: true, available: true } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") return { ok: true, data: {
            checkedAtUnixSeconds: 1785648000, fileSizeBytes: 4096, formatVersion: "MDBX-2", schemaVersion: 17,
            health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
            diagnostics: { commitCount: cleaned ? 2 : 1, tombstoneCount: 0, branchCount: 1, deviceCount: 1, snapshotCount: cleaned ? 1 : 3, unresolvedConflictCount: 0, projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: 0, deletedEntryCount: 0, attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0 }
          } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: cleaned, pendingBootstrap: false, pendingSegment: cleaned, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 0 } };
          if (message.type === "MDBX2_COLLECTION_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_CONFLICT_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_SNAPSHOT_LIST") return { ok: true, data: { items: cleaned ? [manual] : [automaticB, automaticA, manual] } };
          if (message.type === "MDBX2_SNAPSHOT_PRUNE_PLAN") {
            planCount += 1;
            return planCount === 1
              ? { ok: true, data: { planToken: planA, keepLatest: 0, candidateCount: 2, hasMore: true, totalCiphertextBytes: 1536 } }
              : { ok: true, data: { planToken: planB, keepLatest: 0, candidateCount: 1, hasMore: false, totalCiphertextBytes: 512 } };
          }
          if (message.type === "MDBX2_SNAPSHOT_PRUNE_EXECUTE") {
            executeTokens.push(message.planToken || "");
            if (message.planToken === planA) return { ok: false, error: "计划已经变化。", code: "snapshot-prune-plan-stale" };
            planBAttempts += 1;
            if (planBAttempts === 1) return { ok: false, error: "Native Host 连接已断开。", code: "native-host-disconnected" };
            cleaned = true;
            return { ok: true, data: { planToken: planB, commitId: "55555555-5555-4555-8555-555555555555", deletedSnapshotCount: 1 } };
          }
          if (message.type === "MDBX2_HISTORY_LIST") return { ok: true, data: { items: [] } };
          return originalSend(message);
        }
      });
    });

    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: "管理 MDBX2" }).click();

    const dialog = page.getByRole("dialog", { name: "管理 自动快照演示库" });
    const panel = dialog.locator(".mdbx2-snapshot-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("border-radius", "8px");
    await expect(panel).toHaveCSS("background-image", "none");
    await expect(dialog).not.toContainText("22222222-2222-4222-8222-222222222222");
    await expect(dialog).not.toContainText(planA);

    await dialog.getByRole("button", { name: "检查可清理项" }).click();
    const confirmation = dialog.locator(".mdbx2-snapshot-prune-confirmation");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toHaveCSS("background-image", "none");
    await expect(dialog.getByText("清理 2 个到期自动快照？", { exact: true })).toBeVisible();
    await expect(dialog.getByText("手动快照和未到期自动快照保持不变", { exact: false })).toBeVisible();
    await expect(dialog.getByText("单次 200 项安全上限", { exact: false })).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "确认清理到期自动快照" });
    await expect(confirm).toBeFocused();
    expect((await confirm.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expectCentered(dialog.locator(".mdbx2-snapshot-prune-icon"), dialog.locator(".mdbx2-snapshot-prune-icon m3e-icon"));
    await expectNoHorizontalOverflow(dialog);

    await confirm.click();
    await expect(dialog.getByText("旧计划已安全失效", { exact: false })).toBeVisible();
    await expect(confirm).toContainText("重新检查");
    await confirm.click();
    await expect(dialog.getByText("清理 1 个到期自动快照？", { exact: true })).toBeVisible();
    await confirm.click();
    await expect(dialog.getByText("计划令牌仍保留", { exact: false })).toBeVisible();
    await expect(confirm).toContainText("安全重试");
    await expect(confirmation.getByRole("button", { name: "取消" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("mdbx2-snapshot-prune-retry.png"), fullPage: true });
    await confirm.click();

    await expect(dialog.getByRole("button", { name: "检查可清理项" })).toBeVisible();
    await expect(dialog.locator(".mdbx2-snapshot-row")).toHaveCount(1);
    await expect(dialog).not.toContainText(planB);
    expect(await page.evaluate(() => (window as Window & { __mdbx2SnapshotPruneTokens?: string[] }).__mdbx2SnapshotPruneTokens)).toEqual([planA, planB, planB]);
    await expectNoHorizontalOverflow(dialog);
  } finally {
    await context?.close();
  }
});
