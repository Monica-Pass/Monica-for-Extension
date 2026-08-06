import { chromium, expect, test, type BrowserContext, type Locator } from "@playwright/test";
import path from "node:path";

const OPERATION_ID = "66666666-6666-4666-8666-666666666666";

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const measurements = await locator.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const offenders = [...element.querySelectorAll<HTMLElement>("*")]
      .map((child) => ({
        tag: child.tagName.toLowerCase(),
        className: child.className,
        right: Math.round(child.getBoundingClientRect().right - root.right),
        scrollOverflow: child.scrollWidth - child.clientWidth
      }))
      .filter((entry) => entry.right > 1 || entry.scrollOverflow > 1)
      .slice(0, 12);
    return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, offenders };
  });
  expect(measurements.scrollWidth, JSON.stringify(measurements, null, 2)).toBeLessThanOrEqual(measurements.clientWidth + 1);
}

async function expectCentered(container: Locator, icon: Locator): Promise<void> {
  const [containerBox, iconBox] = await Promise.all([container.boundingBox(), icon.boundingBox()]);
  expect(containerBox).not.toBeNull();
  expect(iconBox).not.toBeNull();
  expect(Math.abs((containerBox!.x + containerBox!.width / 2) - (iconBox!.x + iconBox!.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs((containerBox!.y + containerBox!.height / 2) - (iconBox!.y + iconBox!.height / 2))).toBeLessThanOrEqual(1);
}

test("MDBX2 batch transfer provides safe M3E planning progress confirmation and retry", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-batch-transfer-profile"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 1100 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    await manager.goto(`chrome-extension://${extensionId}/index.html`);

    await manager.getByLabel("主密码", { exact: true }).fill("mdbx2 batch transfer password");
    await manager.getByLabel("确认主密码", { exact: true }).fill("mdbx2 batch transfer password");
    await manager.getByRole("button", { name: "创建并解锁" }).click();
    await expect(manager.getByRole("heading", { name: "密码库概览" })).toBeVisible();

    const createdAt = "2026-08-06T12:00:00.000Z";
    const common = { favorite: false, notes: "", createdAt, updatedAt: createdAt, providerRefs: [] };
    const inserted = await manager.evaluate(async ({ common }) => Promise.all([
      chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: { ...common, id: "batch-login", kind: "login", title: "Work Login", username: "joy@example.com", password: "secret", uris: ["https://login.example.com"], customFields: [], categoryName: "工作" } }),
      chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: { ...common, id: "batch-note", kind: "secure-note", title: "Recovery Note", content: "Sensitive content stays encrypted", markdown: true, tags: ["恢复"], categoryName: "笔记" } }),
      chrome.runtime.sendMessage({ type: "VAULT_UPSERT_ITEM", item: { ...common, id: "batch-passkey", kind: "passkey", title: "Android Passkey Metadata", credentialId: "credential", rpId: "example.com", rpName: "Example", userHandle: "user", userName: "joy@example.com", userDisplayName: "Joy", algorithm: -7, publicKey: "", signCount: 0, discoverable: true, sourceMode: "android-metadata-only" } })
    ]), { common }) as Array<{ ok: boolean; error?: string }>;
    expect(inserted.every((entry) => entry.ok), inserted.map((entry) => entry.error).join("\n")).toBe(true);

    await manager.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
      const providerId = "mdbx2-batch-target";
      const operationId = "66666666-6666-4666-8666-666666666666";
      const operationIds: string[] = [];
      let executeCount = 0;
      let status: Record<string, unknown> | undefined;
      const collection = (collectionId: string, title: string, groupId?: string) => ({
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
        deleted: false,
        updatedAt: "2026-08-06T12:00:00.000Z"
      });
      const personalId = "11111111-1111-4111-8111-111111111111";
      const accountsId = "22222222-2222-4222-8222-222222222222";
      const collections = [collection(personalId, "个人"), collection(accountsId, "账号", personalId)];
      const phase = (name: string, processed: number, completedCount: number, blockedCount: number, failedCount: number, finished = false) => {
        status = { operationId, phase: name, processed, total: 3, completedCount, blockedCount, failedCount, finished, updatedAt: new Date().toISOString() };
      };
      (window as Window & { __mdbx2BatchOperationIds?: string[] }).__mdbx2BatchOperationIds = operationIds;

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: Record<string, unknown>) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, {
              id: providerId,
              kind: "mdbx2",
              name: "团队 MDBX2",
              enabled: true,
              isDefaultSaveTarget: false,
              config: { vaultHandle: "33333333-3333-4333-8333-333333333333", schemaVersion: 2, remotePath: "Monica/MDBX2/team.mdbx" }
            }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "aafa22f195c626a8d8288d712bf42bccea134847" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "33333333-3333-4333-8333-333333333333", open: true, available: true } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: false, pendingBootstrap: false, pendingSegment: false, pendingRemoteAcknowledgement: false, remoteStreamCount: 2, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 0 } };
          if (message.type === "MDBX2_COLLECTION_LIST") return { ok: true, data: { items: collections.map((item) => ({ ...item })) } };
          if (message.type === "MDBX2_BATCH_TRANSFER_PLAN") {
            const input = message.input as Record<string, unknown>;
            const ids = input.itemIds as string[];
            const byId = {
              "batch-login": { title: "Work Login", kind: "login", sourcePath: ["工作"], targetPath: ["工作"] },
              "batch-note": { title: "Recovery Note", kind: "secure-note", sourcePath: ["笔记"], targetPath: ["笔记"] },
              "batch-passkey": { title: "Android Passkey Metadata", kind: "passkey", sourcePath: [], targetPath: [], blockedReason: "Android 元数据型 Passkey 不包含浏览器可用私钥，已阻止移动。" }
            } as const;
            const items = ids.map((id) => ({ sourceItemId: id, effectiveAction: "move", pathIncomplete: false, ...byId[id as keyof typeof byId] }));
            return { ok: true, data: { operationId, operationCreatedAt: "2026-08-06T12:00:00.000Z", action: "move", targetProviderId: providerId, targetCollectionId: accountsId, preserveCategories: true, items, blockedCount: 1, transferableCount: 2, requiresMoveConfirmation: true, warnings: ["未知字段和未修改附件会由后台按 MDBX2 规则保留。"] } };
          }
          if (message.type === "MDBX2_BATCH_TRANSFER_EXECUTE") {
            const input = message.input as { operationId?: string };
            operationIds.push(String(input.operationId));
            executeCount += 1;
            phase("preparing", 1, 0, 1, 0);
            await new Promise((resolve) => setTimeout(resolve, 80));
            phase("writing", 1, 0, 1, 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
            phase("attachments", 1, 0, 1, 0);
            await new Promise((resolve) => setTimeout(resolve, 100));
            const firstAttempt = executeCount === 1;
            const items = [
              { sourceItemId: "batch-login", title: "Work Login", kind: "login", effectiveAction: "move", status: "completed", targetItemId: "batch-login", retryable: false },
              firstAttempt
                ? { sourceItemId: "batch-note", title: "Recovery Note", kind: "secure-note", effectiveAction: "move", status: "failed", error: "测试中的附件响应暂时中断。", retryable: true }
                : { sourceItemId: "batch-note", title: "Recovery Note", kind: "secure-note", effectiveAction: "move", status: "completed", targetItemId: "batch-note", retryable: false },
              { sourceItemId: "batch-passkey", title: "Android Passkey Metadata", kind: "passkey", effectiveAction: "move", status: "blocked", error: "Android 元数据型 Passkey 不包含浏览器可用私钥，已阻止移动。", retryable: false }
            ];
            phase("completed", 3, firstAttempt ? 1 : 2, 1, firstAttempt ? 1 : 0, true);
            return { ok: true, data: { operationId, action: "move", targetProviderId: providerId, items, completedCount: firstAttempt ? 1 : 2, blockedCount: 1, failedCount: firstAttempt ? 1 : 0, warnings: [] } };
          }
          if (message.type === "MDBX2_BATCH_TRANSFER_STATUS") return { ok: true, data: status ? { ...status } : undefined };
          return originalSend(message);
        }
      });
    });

    await manager.reload();
    await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await manager.getByRole("button", { name: "打开导航" }).click();
    await manager.getByRole("button", { name: "密码源" }).click();
    await manager.getByRole("button", { name: "批量传输" }).click();

    const dialog = manager.getByRole("dialog", { name: "复制或移动项目" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(dialog).toHaveCSS("background-image", "none");
    await expect(dialog.locator(".batch-panel").first()).toHaveCSS("border-radius", "8px");
    await expect(dialog.locator(".batch-panel").first()).toHaveCSS("background-image", "none");

    await dialog.getByRole("checkbox", { name: /Work Login/ }).check();
    await dialog.getByRole("checkbox", { name: /Recovery Note/ }).check();
    await dialog.getByRole("checkbox", { name: /Android Passkey Metadata/ }).check();
    await expect(dialog.getByText("3 / 200 已选择", { exact: true })).toBeVisible();
    await dialog.getByRole("radio", { name: /移动/ }).check();
    await dialog.getByRole("radio", { name: /个人 \/ 账号/ }).check();
    await expect(dialog.getByRole("checkbox", { name: /保留原分类层级/ })).toBeChecked();

    const planButton = dialog.getByRole("button", { name: "检查并生成计划" });
    expect((await planButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await planButton.click();
    await expect(dialog.getByRole("heading", { name: "兼容性计划" })).toBeVisible();
    await expect(dialog.getByText("2 个可传输，1 个被阻断", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/Android 元数据型 Passkey 不包含浏览器可用私钥/)).toBeVisible();

    const moveConfirmation = dialog.getByRole("checkbox", { name: /我确认执行移动/ });
    await moveConfirmation.check();
    await dialog.getByRole("button", { name: "确认并移动" }).click();
    await expect(dialog.getByRole("heading", { name: "正在传输" })).toBeVisible();
    await expect(dialog.locator("progress")).toBeVisible();
    await expect(dialog.getByText("1 个成功 · 1 个阻断 · 1 个失败", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "重试失败项目" })).toBeVisible();

    await dialog.getByRole("button", { name: "重试失败项目" }).click();
    await expect(dialog.getByText("2 个成功 · 1 个阻断 · 0 个失败", { exact: true })).toBeVisible();
    expect(await manager.evaluate(() => (window as Window & { __mdbx2BatchOperationIds?: string[] }).__mdbx2BatchOperationIds)).toEqual([OPERATION_ID, OPERATION_ID]);

    await expectNoHorizontalOverflow(dialog);
    await expectCentered(dialog.locator(".batch-item-icon").first(), dialog.locator(".batch-item-icon m3e-icon").first());
    await manager.screenshot({ path: testInfo.outputPath("mdbx2-batch-transfer-dark-375-200.png"), fullPage: true });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const denied = await popup.evaluate(async (operationId) => chrome.runtime.sendMessage({ type: "MDBX2_BATCH_TRANSFER_STATUS", operationId }), OPERATION_ID) as { ok: boolean; error?: string };
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("管理页");
  } finally {
    await context?.close();
  }
});
