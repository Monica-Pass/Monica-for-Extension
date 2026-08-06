import { chromium, expect, test, type BrowserContext, type Locator } from "@playwright/test";
import path from "node:path";
import { installMdbx2TigaMock } from "./fixtures/mdbx2";

test("auth card omits the decorative avatar", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("auth-polish-profile"), { channel: "chromium", headless: true, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    await expect(page.locator(".login-card h1")).toHaveText("创建加密密码库");
    await expect(page.locator(".avatar-icon")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("auth-card.png"), fullPage: true });
  } finally { await context?.close(); }
});

test("provider page is compact and decorated icon glyphs are centered", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("provider-polish-profile"), { channel: "chromium", headless: true, colorScheme: "dark", viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "visual polish master password" }))).toMatchObject({ ok: true });
    await page.reload();

    await page.getByRole("button", { name: "密码源" }).click();
    const connectionButtons = page.locator(".provider-connect-grid .connect-source");
    await expect(connectionButtons).toHaveCount(4);
    await expect(page.locator(".provider-config-card")).toHaveCount(0);
    await expect(page.locator(".provider-list .source-card")).toHaveCount(1);
    expect((await page.locator(".provider-page").boundingBox())!.width).toBeLessThanOrEqual(820);
    const connectionBoxes = await Promise.all(Array.from({ length: 4 }, (_, index) => connectionButtons.nth(index).boundingBox()));
    for (const box of connectionBoxes.slice(1)) expect(Math.abs(connectionBoxes[0]!.width - box!.width)).toBeLessThanOrEqual(1);
    await expectCentered(page.locator(".source-icon").first(), page.locator(".source-icon m3e-icon").first());
    await expectCentered(page.locator(".connect-icon").first(), page.locator(".connect-icon m3e-icon").first());
    await expectCentered(page.locator(".connect-icon").nth(1), page.locator(".connect-icon m3e-icon").nth(1));
    await expectRoundedAndClipped(page.locator(".connect-source-card").first());
    await expectRoundedAndClipped(page.locator(".provider-list .source-card").first());
    await expectAllRoundedAndClipped(page.locator("main m3e-card"));
    await expect(page.locator("m3e-card m3e-card")).toHaveCount(0);
    const connectionShape = await page.locator(".connect-source-card").first().evaluate((host) => ({
      host: getComputedStyle(host).borderRadius,
      button: getComputedStyle(host.querySelector(".connect-source")!).borderRadius
    }));
    expect(connectionShape.button).toBe(connectionShape.host);

    await page.getByRole("button", { name: /连接 MDBX2 保险库/ }).click();
    const mdbx2Dialog = page.getByRole("dialog", { name: "打开 MDBX2 保险库" });
    await expect(mdbx2Dialog).toBeVisible();
    await expect(mdbx2Dialog).toHaveCSS("border-radius", "16px");
    await expect(mdbx2Dialog.getByLabel("MDBX2 可移植备份")).toBeVisible();
    await mdbx2Dialog.getByRole("button", { name: "从 WebDAV 加入" }).click();
    const remoteMdbx2Dialog = page.getByRole("dialog", { name: "从 WebDAV 加入 MDBX2" });
    await expect(remoteMdbx2Dialog).toBeVisible();
    await expect(remoteMdbx2Dialog.getByLabel("Android 兼容远端位置 *")).toBeVisible();
    await expect(remoteMdbx2Dialog.getByText("日常同步对象自动写入同名", { exact: false })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mdbx2-dialog.png"), fullPage: true });
    await remoteMdbx2Dialog.getByRole("button", { name: "关闭 MDBX2 设置" }).click();
    await expect(page.getByRole("dialog", { name: /MDBX2/ })).toHaveCount(0);

    await page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).hover();

    await page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).click();
    const dialog = page.getByRole("dialog", { name: "连接 Monica Android WebDAV" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(page.getByLabel("WebDAV 地址 *")).toBeVisible();
    await page.getByRole("button", { name: "关闭 WebDAV 设置" }).click();
    await expect(page.getByRole("dialog", { name: "连接 Monica Android WebDAV" })).toHaveCount(0);

    await page.getByRole("button", { name: "概览" }).click();
    await expectCentered(page.locator(".feature-icon"), page.locator(".feature-icon m3e-icon"));
    await expectAllRoundedAndClipped(page.locator("main m3e-card"));
    await page.getByRole("button", { name: "设置与备份" }).click();
    await expectAllRoundedAndClipped(page.locator("main m3e-card"));
    await page.getByRole("button", { name: "密码源" }).click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: /连接 Monica Android WebDAV/ }).hover();
    await page.screenshot({ path: testInfo.outputPath("provider-page.png"), fullPage: true });
  } finally { await context?.close(); }
});

test("MDBX2 conflict manager is flat explicit and usable at 375px with large text", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-conflict-polish-profile"), { channel: "chromium", headless: true, colorScheme: "dark", viewport: { width: 375, height: 900 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 conflict visual password" }))).toMatchObject({ ok: true });
    await installMdbx2TigaMock(page);
    await page.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      let conflictResolved = false;
      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: { type?: string; choice?: "local-wins" | "incoming-wins" }) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, { id: "mdbx2-conflict-demo", kind: "mdbx2", name: "冲突演示库", enabled: true, isDefaultSaveTarget: false, config: { remotePath: "Monica/MDBX2/demo.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true } }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "974c517465e7b6cac0947d2d59875aa4211fa16b" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "11111111-1111-4111-8111-111111111111", open: true, available: true } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") return { ok: true, data: {
            checkedAtUnixSeconds: 1785648000, fileSizeBytes: 4096, formatVersion: "MDBX-2", schemaVersion: 17,
            health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
            diagnostics: { commitCount: 1, tombstoneCount: 0, branchCount: 1, deviceCount: 2, snapshotCount: 0, unresolvedConflictCount: conflictResolved ? 0 : 1, projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: 1, deletedEntryCount: 0, attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0 }
          } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: conflictResolved, pendingBootstrap: false, pendingSegment: false, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 3 } };
          if (message.type === "MDBX2_CONFLICT_LIST") return { ok: true, data: { items: conflictResolved ? [] : [{ conflictId: "22222222-2222-4222-8222-222222222222", objectType: "entry", objectId: "33333333-3333-4333-8333-333333333333", displayTitle: "工作账号", contentType: "login", conflictingFields: ["title_ct", "payload", "project_id"], createdAt: "2026-08-02T00:00:00Z" }] } };
          if (message.type === "MDBX2_CONFLICT_RESOLVE") {
            conflictResolved = true;
            return { ok: true, data: { resolved: true, alreadyResolved: false, conflictId: "22222222-2222-4222-8222-222222222222", objectType: "entry", objectId: "33333333-3333-4333-8333-333333333333", choice: message.choice, resolvedAt: "2026-08-02T00:01:00Z" } };
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

    const dialog = page.getByRole("dialog", { name: "管理 冲突演示库" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /工作账号/ })).toBeVisible();
    await expect(dialog).not.toContainText("22222222-2222-4222-8222-222222222222");
    await expect(dialog).not.toContainText("33333333-3333-4333-8333-333333333333");
    const panel = dialog.locator(".mdbx2-conflict-panel");
    await expect(panel).toHaveCSS("border-radius", "8px");
    await expect(panel).toHaveCSS("background-image", "none");
    await expectCentered(dialog.locator(".mdbx2-conflict-icon"), dialog.locator(".mdbx2-conflict-icon m3e-icon"));
    const closeButton = dialog.getByRole("button", { name: "关闭 MDBX2 设置" });
    const closeIcon = closeButton.locator("m3e-icon");
    await expect(closeButton).toHaveCSS("width", "44px");
    await expect(closeButton).toHaveCSS("height", "44px");
    await expect(closeIcon).toHaveCSS("font-size", "20px");
    await expectCentered(closeButton, closeIcon);

    const conflictRow = dialog.getByRole("button", { name: /工作账号/ });
    await conflictRow.scrollIntoViewIfNeeded();
    await conflictRow.click();
    await expect(dialog.getByText("标题", { exact: true })).toBeVisible();
    await expect(dialog.getByText("内容", { exact: true })).toBeVisible();
    await expect(dialog.getByText("位置", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "采用传入版本" }).click();
    const confirm = dialog.getByRole("button", { name: "确认采用传入版本" });
    await expect(confirm).toBeFocused();
    await expect(dialog.getByText("当前浏览器中的并发修改会被替换", { exact: false })).toBeVisible();
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-conflict-manager.png"), fullPage: true });
    await confirm.click();
    await expect(dialog.getByText("没有待处理的同步冲突。")).toBeVisible();
  } finally { await context?.close(); }
});

test("MDBX2 snapshot manager is flat bounded and usable at 375px with large text", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-snapshot-polish-profile"), { channel: "chromium", headless: true, colorScheme: "dark", viewport: { width: 375, height: 1000 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 snapshot visual password" }))).toMatchObject({ ok: true });
    await installMdbx2TigaMock(page);
    await page.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      const goodSnapshotId = "22222222-2222-4222-8222-222222222222";
      const badSnapshotId = "33333333-3333-4333-8333-333333333333";
      let snapshots = [
        { snapshotId: goodSnapshotId, baseCommitId: "44444444-4444-4444-8444-444444444444", name: "发布前", kind: "manual", isFull: true, payloadBytes: 4096, createdAt: "2026-08-02T00:00:00Z", createdByDeviceId: "device-a", autoPrune: false, integrityOk: true },
        { snapshotId: badSnapshotId, baseCommitId: "55555555-5555-4555-8555-555555555555", name: "每日保留点", kind: "automatic", isFull: true, payloadBytes: 8192, createdAt: "2026-08-01T00:00:00Z", createdByDeviceId: "device-b", autoPrune: true, integrityOk: false }
      ];
      let restoreAttempts = 0;
      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: { type?: string; operationId?: string; snapshotId?: string; side?: "current" | "snapshot"; name?: string }) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, { id: "mdbx2-snapshot-demo", kind: "mdbx2", name: "快照演示库", enabled: true, isDefaultSaveTarget: false, config: { remotePath: "Monica/MDBX2/demo.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true } }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "974c517465e7b6cac0947d2d59875aa4211fa16b" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "11111111-1111-4111-8111-111111111111", open: true, available: true } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") return { ok: true, data: {
            checkedAtUnixSeconds: 1785648000, fileSizeBytes: 4096, formatVersion: "MDBX-2", schemaVersion: 17,
            health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
            diagnostics: { commitCount: 1, tombstoneCount: 0, branchCount: 1, deviceCount: 2, snapshotCount: snapshots.length, unresolvedConflictCount: 0, projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: 0, deletedEntryCount: 0, attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0 }
          } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: false, pendingBootstrap: false, pendingSegment: false, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 3 } };
          if (message.type === "MDBX2_CONFLICT_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_COLLECTION_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_HISTORY_LIST") return { ok: true, data: { items: [] } };
          if (message.type === "MDBX2_SNAPSHOT_LIST") return { ok: true, data: { items: snapshots } };
          if (message.type === "MDBX2_SNAPSHOT_STRUCTURE") {
            const current = message.side === "current";
            return { ok: true, data: {
              snapshotId: message.snapshotId,
              side: message.side,
              currentItemCount: 2,
              snapshotItemCount: 1,
              totalNodes: current ? 2 : 1,
              items: current
                ? [
                    { nodeId: "66666666-6666-4666-8666-666666666666", parentNodeId: null, name: "工作账号", nodeType: "entry", path: "登录/工作账号", status: "modified", childCount: 0 },
                    { nodeId: "77777777-7777-4777-8777-777777777777", parentNodeId: null, name: "新设备账号", nodeType: "entry", path: "登录/新设备账号", status: "added", childCount: 0 }
                  ]
                : [{ nodeId: "66666666-6666-4666-8666-666666666666", parentNodeId: null, name: "工作账号", nodeType: "entry", path: "登录/工作账号", status: "modified", childCount: 0 }]
            } };
          }
          if (message.type === "MDBX2_SNAPSHOT_CREATE") {
            const snapshotId = "88888888-8888-4888-8888-888888888888";
            snapshots = [{ snapshotId, baseCommitId: "99999999-9999-4999-8999-999999999999", name: message.name || "Snapshot 2026-08-02T01:00:00Z", kind: "manual", isFull: true, payloadBytes: 12288, createdAt: "2026-08-02T01:00:00Z", createdByDeviceId: "device-a", autoPrune: false, integrityOk: true }, ...snapshots];
            return { ok: true, data: { operationId: message.operationId, snapshotId, commitId: "99999999-9999-4999-8999-999999999999", alreadyCompleted: false } };
          }
          if (message.type === "MDBX2_SNAPSHOT_RESTORE") {
            restoreAttempts += 1;
            if (restoreAttempts === 1) return { ok: false, error: "无法证明恢复结果。", code: "snapshot-operation-state-unknown" };
            return { ok: true, data: { operationId: message.operationId, snapshotId: message.snapshotId, commitId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", affectedObjectCount: 2, alreadyCompleted: false } };
          }
          if (message.type === "MDBX2_SNAPSHOT_DELETE") {
            snapshots = snapshots.filter((item) => item.snapshotId !== message.snapshotId);
            return { ok: true, data: { operationId: message.operationId, snapshotId: message.snapshotId, commitId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", alreadyCompleted: false } };
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

    const dialog = page.getByRole("dialog", { name: "管理 快照演示库" });
    const panel = dialog.locator(".mdbx2-snapshot-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("border-radius", "8px");
    await expect(panel).toHaveCSS("background-image", "none");
    await expect(dialog.getByText("发布前", { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText("22222222-2222-4222-8222-222222222222");
    await expect(dialog).not.toContainText("33333333-3333-4333-8333-333333333333");
    await expectCentered(dialog.locator(".mdbx2-snapshot-icon").first(), dialog.locator(".mdbx2-snapshot-icon m3e-icon").first());

    await dialog.getByLabel("快照名称（可留空）").fill("升级前");
    await dialog.getByRole("button", { name: "创建完整快照" }).click();
    await expect(dialog.getByText("升级前", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: /发布前/ }).click();
    await expect(dialog.getByText("工作账号", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "与现版本比较" }).click();
    await expect(dialog.getByText("新设备账号", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(dialog);

    await dialog.getByRole("button", { name: "恢复此快照", exact: true }).click();
    const restoreConfirm = dialog.getByRole("button", { name: "确认恢复此快照" });
    await expect(restoreConfirm).toBeFocused();
    await expect(dialog.getByText("当前保险库将恢复到此快照记录的完整状态", { exact: false })).toBeVisible();
    await restoreConfirm.click();
    await expect(dialog.getByText("不要立即重复恢复或删除", { exact: false })).toBeVisible();
    await panel.getByRole("button", { name: "刷新" }).click();
    await dialog.getByRole("button", { name: /发布前/ }).click();
    await dialog.getByRole("button", { name: "恢复此快照", exact: true }).click();
    await dialog.getByRole("button", { name: "确认恢复此快照" }).click();

    await dialog.getByRole("button", { name: /每日保留点/ }).click();
    await expect(dialog.getByText("完整性校验失败", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "恢复此快照", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "删除快照" }).click();
    const deleteConfirm = dialog.getByRole("button", { name: "确认永久删除快照" });
    await expect(deleteConfirm).toBeFocused();
    await expect(dialog.getByText("此快照及其加密内容将从本地保险库永久删除", { exact: false })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mdbx2-snapshot-manager.png"), fullPage: true });
    await deleteConfirm.click();
    await expect(dialog.getByText("每日保留点", { exact: true })).toHaveCount(0);
  } finally { await context?.close(); }
});

for (const width of [375, 768, 1280, 1440]) {
  test(`manager has no horizontal overflow at ${width}px`, async ({}, testInfo) => {
    const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(testInfo.outputPath(`viewport-${width}-profile`), { channel: "chromium", headless: true, viewport: { width, height: 900 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
      const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
      const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
      expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "viewport polish password" }))).toMatchObject({ ok: true });
      await page.reload();
      await expectNoHorizontalOverflow(page.locator("html"));
      if (width <= 900) await page.getByRole("button", { name: "打开导航" }).click();
      await page.getByRole("button", { name: "密码源" }).click();
      await expectNoHorizontalOverflow(page.locator("html"));
    } finally { await context?.close(); }
  });
}

test("login table actions remain fully visible at a 1280px store viewport", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist"); let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("table-polish-profile"), { channel: "chromium", headless: true, viewport: { width: 1280, height: 800 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker"); const extensionId = new URL(worker.url()).host;
    const page = await context.newPage(); await page.goto(`chrome-extension://${extensionId}/index.html`);
    const createdAt = "2026-01-01T00:00:00.000Z";
    expect(await page.evaluate(async (createdAt) => {
      const setup = await chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "table polish master password" });
      if (!setup.ok) return setup;
      return chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: { id: "table-login", kind: "login", title: "示例工作账号", username: "demo@example.test", password: "not-a-real-password", uris: ["https://shop-demo.example.test"], customFields: [], favorite: false, notes: "", createdAt, updatedAt: createdAt, providerRefs: [] } });
    }, createdAt)).toMatchObject({ ok: true });
    await page.reload();
    await page.getByRole("button", { name: /^登录项/ }).click();
    const tableWrap = page.locator(".table-wrap");
    await expect(tableWrap).toBeVisible();
    const tableLayout = await tableWrap.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, tableWidth: element.querySelector("table")?.getBoundingClientRect().width }));
    expect(tableLayout.scrollWidth, JSON.stringify(tableLayout)).toBeLessThanOrEqual(tableLayout.clientWidth);
    const finalAction = page.getByRole("button", { name: "删除登录项" });
    const bounds = await finalAction.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1280);
    await expect(page.locator(".sidebar-brand small")).toHaveCSS("display", "block");
  } finally { await context?.close(); }
});

async function expectCentered(container: Locator, glyph: Locator): Promise<void> {
  const label = await container.evaluate((element) => `${element.tagName.toLowerCase()}.${element.className}`);
  const glyphElement = await glyph.elementHandle();
  expect(glyphElement).not.toBeNull();
  const { outerCenter, innerCenter } = await container.evaluate((outer, inner) => {
    const outerBox = outer.getBoundingClientRect();
    const innerBox = (inner as Element).getBoundingClientRect();
    return {
      outerCenter: { x: outerBox.x + outerBox.width / 2, y: outerBox.y + outerBox.height / 2 },
      innerCenter: { x: innerBox.x + innerBox.width / 2, y: innerBox.y + innerBox.height / 2 }
    };
  }, glyphElement);
  expect(Math.abs(outerCenter.x - innerCenter.x), `${label} horizontal center`).toBeLessThanOrEqual(1);
  expect(Math.abs(outerCenter.y - innerCenter.y), `${label} vertical center`).toBeLessThanOrEqual(1);
}

async function expectRoundedAndClipped(card: Locator): Promise<void> {
  const styles = await card.evaluate((host) => {
    const base = host.shadowRoot?.querySelector<HTMLElement>(".base");
    return {
      hostRadius: getComputedStyle(host).borderRadius,
      baseRadius: base ? getComputedStyle(base).borderRadius : "missing",
      overflow: getComputedStyle(host).overflow
    };
  });
  expect(styles.hostRadius).toBe("8px");
  expect(styles.hostRadius).toBe(styles.baseRadius);
  expect(["hidden", "clip"]).toContain(styles.overflow);
}

async function expectNoHorizontalOverflow(root: Locator): Promise<void> {
  const dimensions = await root.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(dimensions.scrollWidth, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectAllRoundedAndClipped(cards: Locator): Promise<void> {
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) await expectRoundedAndClipped(cards.nth(index));
}
