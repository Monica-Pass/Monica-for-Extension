import { chromium, expect, test, type BrowserContext, type Locator } from "@playwright/test";
import path from "node:path";

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

test("MDBX2 folders preserve Android hierarchy and retry one uncertain move intent", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  const personalId = "11111111-1111-4111-8111-111111111111";
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-collections-profile"), {
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
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 collection password" }))).toMatchObject({ ok: true });

    await page.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>;
      const personalId = "11111111-1111-4111-8111-111111111111";
      const accountsId = "22222222-2222-4222-8222-222222222222";
      const moveOperationIds: string[] = [];
      let moveAttempts = 0;
      const summary = (collectionId: string, title: string, groupId?: string, deleted = false) => ({
        collectionId,
        title,
        collectionTypeId: null,
        profileSchemaVersion: null,
        groupId: groupId || null,
        iconRef: null,
        favorite: false,
        archived: false,
        attachmentCount: 0,
        headCommitId: "99999999-9999-4999-8999-999999999999",
        deleted,
        updatedAt: "2026-08-02T00:00:00Z"
      });
      let active = [summary(personalId, "个人"), summary(accountsId, "账号", personalId)];
      let deleted: ReturnType<typeof summary>[] = [];
      (window as Window & { __mdbx2CollectionMoveOperations?: string[] }).__mdbx2CollectionMoveOperations = moveOperationIds;

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: Record<string, unknown>) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message as { type?: string });
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, {
              id: "mdbx2-collection-demo",
              kind: "mdbx2",
              name: "目录演示库",
              enabled: true,
              isDefaultSaveTarget: false,
              config: { remotePath: "Monica/MDBX2/collections.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true }
            }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "aafa22f195c626a8d8288d712bf42bccea134847" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "33333333-3333-4333-8333-333333333333", open: true, available: true } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: true, pendingBootstrap: false, pendingSegment: true, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 0 } };
          if (message.type === "MDBX2_COLLECTION_LIST") return { ok: true, data: { items: message.deleted ? deleted.map((item) => ({ ...item })) : active.map((item) => ({ ...item })) } };
          if (message.type === "MDBX2_COLLECTION_CREATE") {
            const created = summary(String(message.collectionId), String(message.title), typeof message.parentCollectionId === "string" ? message.parentCollectionId : undefined);
            active.push(created);
            return { ok: true, data: { operationId: message.operationId, commitId: crypto.randomUUID(), alreadyCommitted: false, collection: created } };
          }
          if (message.type === "MDBX2_COLLECTION_RENAME") {
            active = active.map((item) => item.collectionId === message.collectionId ? { ...item, title: String(message.title) } : item);
            const changed = active.find((item) => item.collectionId === message.collectionId)!;
            return { ok: true, data: { operationId: message.operationId, commitId: crypto.randomUUID(), alreadyCommitted: false, collection: changed } };
          }
          if (message.type === "MDBX2_COLLECTION_MOVE") {
            moveOperationIds.push(String(message.operationId));
            moveAttempts += 1;
            if (moveAttempts === 1) return { ok: false, error: "Native Host 连接已断开。", code: "native-host-disconnected" };
            active = active.map((item) => item.collectionId === message.collectionId
              ? { ...item, groupId: typeof message.parentCollectionId === "string" ? message.parentCollectionId : null }
              : item);
            const changed = active.find((item) => item.collectionId === message.collectionId)!;
            return { ok: true, data: { operationId: message.operationId, commitId: crypto.randomUUID(), alreadyCommitted: true, collection: changed } };
          }
          if (message.type === "MDBX2_COLLECTION_DELETE") {
            const target = active.find((item) => item.collectionId === message.collectionId)!;
            active = active.filter((item) => item.collectionId !== message.collectionId);
            const changed = { ...target, deleted: true };
            deleted.push(changed);
            return { ok: true, data: { operationId: message.operationId, commitId: crypto.randomUUID(), alreadyCommitted: false, collection: changed } };
          }
          if (message.type === "MDBX2_COLLECTION_RESTORE") {
            const target = deleted.find((item) => item.collectionId === message.collectionId)!;
            deleted = deleted.filter((item) => item.collectionId !== message.collectionId);
            const changed = { ...target, deleted: false, groupId: typeof message.parentCollectionId === "string" ? message.parentCollectionId : null };
            active.push(changed);
            return { ok: true, data: { operationId: message.operationId, commitId: crypto.randomUUID(), alreadyCommitted: false, collection: changed } };
          }
          if (message.type === "MDBX2_CONFLICT_LIST" || message.type === "MDBX2_SNAPSHOT_LIST" || message.type === "MDBX2_HISTORY_LIST") return { ok: true, data: { items: [] } };
          return originalSend(message as { type?: string });
        }
      });
    });

    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();
    await page.getByRole("button", { name: "管理 MDBX2" }).click();

    const dialog = page.getByRole("dialog", { name: "管理 目录演示库" });
    const panel = dialog.locator(".mdbx2-collection-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("border-radius", "8px");
    await expect(panel).toHaveCSS("background-image", "none");
    await expect(dialog.getByText("个人 / 账号", { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText(personalId);

    await dialog.getByRole("button", { name: "新建文件夹" }).click();
    const titleInput = dialog.locator("#mdbx2-collection-title-input");
    await expect(titleInput).toBeFocused();
    expect((await titleInput.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await titleInput.fill("工作");
    await dialog.locator("#mdbx2-collection-parent").selectOption({ label: "个人 / 账号" });
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(dialog.getByText("个人 / 账号 / 工作", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "重命名 工作" }).click();
    await titleInput.fill("工作账号");
    await dialog.getByRole("button", { name: "保存名称" }).click();
    await expect(dialog.getByText("个人 / 账号 / 工作账号", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "移动 工作账号" }).click();
    await dialog.locator("#mdbx2-collection-parent").selectOption({ label: "顶层" });
    const moveConfirm = dialog.getByRole("button", { name: "确认移动" });
    await expect(moveConfirm).toBeFocused();
    await moveConfirm.click();
    await expect(dialog.getByRole("alert")).toContainText("原操作标识已保留");
    const safeRetry = dialog.getByRole("button", { name: "安全重试" });
    await expect(dialog.locator(".mdbx2-collection-editor").getByRole("button", { name: "取消" })).toBeDisabled();
    await safeRetry.click();
    await expect(dialog.getByText("工作账号", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { __mdbx2CollectionMoveOperations?: string[] }).__mdbx2CollectionMoveOperations)).toEqual([
      expect.any(String), expect.any(String)
    ]);
    const moveOperations = await page.evaluate(() => (window as Window & { __mdbx2CollectionMoveOperations?: string[] }).__mdbx2CollectionMoveOperations || []);
    expect(moveOperations[0]).toBe(moveOperations[1]);

    await dialog.getByRole("button", { name: "删除 工作账号" }).click();
    const deleteConfirm = dialog.getByRole("button", { name: "确认删除" });
    await expect(deleteConfirm).toBeFocused();
    await expect(dialog.getByText("只允许删除空文件夹", { exact: false })).toBeVisible();
    await expectCentered(dialog.locator(".mdbx2-collection-editor-icon"), dialog.locator(".mdbx2-collection-editor-icon m3e-icon"));
    await deleteConfirm.click();
    await dialog.getByRole("button", { name: /回收站/ }).click();
    await expect(dialog.getByText("工作账号", { exact: true })).toBeVisible();

    await dialog.getByRole("button", { name: "恢复", exact: true }).click();
    await dialog.locator("#mdbx2-collection-parent").selectOption({ label: "个人" });
    await dialog.getByRole("button", { name: "确认恢复" }).click();
    await dialog.getByRole("button", { name: /当前文件夹/ }).click();
    await expect(dialog.getByText("个人 / 工作账号", { exact: true })).toBeVisible();

    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-collections-dark-375-200.png"), fullPage: true });
  } finally {
    await context?.close();
  }
});
