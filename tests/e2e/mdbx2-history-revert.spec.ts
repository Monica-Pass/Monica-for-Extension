import { chromium, expect, test, type BrowserContext, type Locator } from "@playwright/test";
import path from "node:path";
import { installMdbx2TigaMock } from "./fixtures/mdbx2";

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  expect(await locator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))).toEqual(
    expect.objectContaining({ clientWidth: expect.any(Number), scrollWidth: expect.any(Number) })
  );
  expect(await locator.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
}

async function expectCentered(container: Locator, icon: Locator): Promise<void> {
  const [containerBox, iconBox] = await Promise.all([container.boundingBox(), icon.boundingBox()]);
  expect(containerBox).not.toBeNull();
  expect(iconBox).not.toBeNull();
  expect(Math.abs((containerBox!.x + containerBox!.width / 2) - (iconBox!.x + iconBox!.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs((containerBox!.y + containerBox!.height / 2) - (iconBox!.y + iconBox!.height / 2))).toBeLessThanOrEqual(1);
}

test("MDBX2 history recovery keeps one operation identity and remains usable at 375px with large text", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  const sourceCommitId = "22222222-2222-4222-8222-222222222222";
  const objectId = "55555555-5555-4555-8555-555555555555";
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-history-revert-profile"), {
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
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 history visual password" }))).toMatchObject({ ok: true });

    await installMdbx2TigaMock(page);
    await page.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>;
      const sourceCommitId = "22222222-2222-4222-8222-222222222222";
      const systemCommitId = "33333333-3333-4333-8333-333333333333";
      const recoveryCommitId = "44444444-4444-4444-8444-444444444444";
      const objectId = "55555555-5555-4555-8555-555555555555";
      const revertOperationIds: string[] = [];
      let recovered = false;
      (window as Window & { __mdbx2HistoryRevertOperationIds?: string[] }).__mdbx2HistoryRevertOperationIds = revertOperationIds;

      const sourceHistory = {
        commitId: sourceCommitId,
        deviceId: "device-a",
        localSeq: 8,
        commitKind: "change",
        changeScope: "entry",
        createdAt: "2026-08-02T01:00:00Z",
        operationId: "66666666-6666-4666-8666-666666666666",
        operationKind: "monica-extension-upsert-object",
        branchName: "main",
        message: null,
        changes: [{ objectType: "entry", objectId, action: "update", fields: ["title", "payload"] }],
        parentIds: ["77777777-7777-4777-8777-777777777777"],
        legacy: false
      };
      const systemHistory = {
        commitId: systemCommitId,
        deviceId: "device-a",
        localSeq: 7,
        commitKind: "snapshot",
        changeScope: "snapshot",
        createdAt: "2026-08-02T00:30:00Z",
        operationId: "88888888-8888-4888-8888-888888888888",
        operationKind: "snapshot-create",
        branchName: "main",
        message: null,
        changes: [{ objectType: "snapshot", objectId: "99999999-9999-4999-8999-999999999999", action: "create", fields: [] }],
        parentIds: [],
        legacy: false
      };
      const recoveryHistory = {
        commitId: recoveryCommitId,
        deviceId: "device-a",
        localSeq: 9,
        commitKind: "restore",
        changeScope: "entry",
        createdAt: "2026-08-02T01:05:00Z",
        operationId: "",
        operationKind: "revert-commit",
        branchName: "main",
        message: null,
        changes: [{ objectType: "entry", objectId, action: "revert", fields: ["history"] }],
        parentIds: [sourceCommitId],
        legacy: false
      };

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: { type?: string; providerId?: string; operationId?: string; commitId?: string }) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, {
              id: "mdbx2-history-demo",
              kind: "mdbx2",
              name: "历史恢复演示库",
              enabled: true,
              isDefaultSaveTarget: false,
              config: { remotePath: "Monica/MDBX2/demo.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true }
            }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "974c517465e7b6cac0947d2d59875aa4211fa16b" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "11111111-1111-4111-8111-111111111111", open: true, available: true } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") return { ok: true, data: {
            checkedAtUnixSeconds: 1785648000, fileSizeBytes: 4096, formatVersion: "MDBX-2", schemaVersion: 17,
            health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
            diagnostics: { commitCount: recovered ? 3 : 2, tombstoneCount: 0, branchCount: 1, deviceCount: 1, snapshotCount: 0, unresolvedConflictCount: 0, projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: 1, deletedEntryCount: 0, attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0 }
          } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: recovered, pendingBootstrap: false, pendingSegment: recovered, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 0 } };
          if (message.type === "MDBX2_CONFLICT_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_COLLECTION_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_SNAPSHOT_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_HISTORY_LIST") return { ok: true, data: { items: recovered ? [{ ...recoveryHistory, operationId: revertOperationIds[0] }, sourceHistory, systemHistory] : [sourceHistory, systemHistory] } };
          if (message.type === "MDBX2_HISTORY_DIFF") return { ok: true, data: { items: message.commitId === sourceCommitId ? [{
            commitId: sourceCommitId,
            objectType: "entry",
            objectId,
            collectionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            previousTitle: "工作账号旧标题",
            currentTitle: "工作账号",
            previousDeleted: false,
            currentDeleted: false,
            changedFields: ["title", "payload"],
            payloadChanged: true,
            contentType: "login",
            createdAt: "2026-08-02T01:00:00Z"
          }] : [] } };
          if (message.type === "MDBX2_HISTORY_REVERT") {
            revertOperationIds.push(message.operationId || "");
            if (revertOperationIds.length === 1) return { ok: false, error: "Native Host 连接已断开。", code: "native-host-disconnected" };
            recovered = true;
            return { ok: true, data: { operationId: message.operationId, commitId: recoveryCommitId, revertedObjectCount: 1 } };
          }
          return originalSend(message);
        }
      });
    });

    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: "管理 MDBX2" }).click();

    const dialog = page.getByRole("dialog", { name: "管理 历史恢复演示库" });
    const panel = dialog.locator(".mdbx2-history-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("border-radius", "8px");
    await expect(panel).toHaveCSS("background-image", "none");
    await expect(dialog).not.toContainText(sourceCommitId);
    await expect(dialog).not.toContainText(objectId);

    const loadHistory = panel.getByRole("button", { name: "加载历史" });
    await loadHistory.scrollIntoViewIfNeeded();
    await loadHistory.click();
    await expect(panel.locator(".mdbx2-history-row")).toHaveCount(2);
    const sourceRow = panel.locator(".mdbx2-history-row").filter({ hasText: "更新了1 个条目" });
    await expect(sourceRow).toBeEnabled();
    await sourceRow.scrollIntoViewIfNeeded();
    await sourceRow.click();
    await expect(dialog.getByText("工作账号", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "撤销这次更改" }).click();
    const confirm = dialog.getByRole("button", { name: "确认撤销这次更改" });
    await expect(confirm).toBeFocused();
    await expect(dialog.getByText("此操作会生成新的恢复记录，原有历史保持不变", { exact: false })).toBeVisible();
    const confirmBox = await confirm.boundingBox();
    expect(confirmBox?.height).toBeGreaterThanOrEqual(44);
    await expectCentered(dialog.locator(".mdbx2-history-confirm-icon"), dialog.locator(".mdbx2-history-confirm-icon m3e-icon"));
    await expectNoHorizontalOverflow(dialog);

    await confirm.click();
    await expect(dialog.locator(".mdbx2-history-confirmation small").filter({ hasText: "原操作标识已经保留" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "确认撤销这次更改" })).toContainText("重试恢复");
    await page.screenshot({ path: testInfo.outputPath("mdbx2-history-revert-confirmation.png"), fullPage: true });
    await dialog.getByRole("button", { name: "确认撤销这次更改" }).click();
    await expect(dialog.getByText("恢复历史版本", { exact: true })).toBeVisible();

    expect(await page.evaluate(() => (window as Window & { __mdbx2HistoryRevertOperationIds?: string[] }).__mdbx2HistoryRevertOperationIds)).toEqual([
      expect.any(String),
      expect.any(String)
    ]);
    const operationIds = await page.evaluate(() => (window as Window & { __mdbx2HistoryRevertOperationIds?: string[] }).__mdbx2HistoryRevertOperationIds || []);
    expect(operationIds[0]).toBe(operationIds[1]);

    await dialog.getByRole("button", { name: /更新数据库快照/ }).click();
    await expect(dialog.getByRole("button", { name: "撤销这次更改" })).toHaveCount(0);
    await expectNoHorizontalOverflow(dialog);
  } finally {
    await context?.close();
  }
});
