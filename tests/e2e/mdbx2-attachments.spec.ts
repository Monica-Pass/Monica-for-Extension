import { chromium, expect, test, type BrowserContext, type CDPSession, type Locator, type Page, type TestInfo } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { installMdbx2TigaMock } from "./fixtures/mdbx2";

interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
}

const MDBX_PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const KEEPASS_PROVIDER_ID = "88888888-8888-4888-8888-888888888888";

async function launchExtension(testInfo: TestInfo, profileName: string, options: { dark?: boolean; viewport?: { width: number; height: number }; reducedMotion?: "reduce" | "no-preference" } = {}) {
  const extensionPath = path.resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath(profileName), {
    channel: "chromium",
    headless: true,
    colorScheme: options.dark ? "dark" : "light",
    reducedMotion: options.reducedMotion,
    viewport: options.viewport,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${extensionId}/index.html`);
  const setup = await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 attachment e2e password" })) as RuntimeResponse;
  expect(setup, setup.error).toMatchObject({ ok: true });
  return { context, extensionId, manager };
}

test("MDBX2 item attachments support download upload replace delete and narrow M3E layout", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "mdbx2-attachment-manager", { dark: true, viewport: { width: 375, height: 1000 } });
    context = launched.context;
    const page = launched.manager;
    await installAttachmentManagerMock(page);
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });

    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: /^登录项/ }).click();
    const manageButton = page.getByRole("button", { name: "管理 附件演示账号 的附件" });
    await expect(manageButton).toBeVisible();
    await expectMinimumTarget(manageButton);
    await manageButton.click();

    const dialog = page.getByRole("dialog", { name: "附件 · 附件演示账号" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(dialog).toHaveCSS("background-image", "none");
    await expect(dialog.locator(".attachment-list-shell")).toHaveCSS("border-radius", "8px");
    await expect(dialog.locator(".attachment-list-shell")).toHaveCSS("background-image", "none");
    await expect(dialog.getByText("evidence.txt", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(dialog);
    await expectCentered(dialog.locator(".attachment-file-icon").first(), dialog.locator(".attachment-file-icon m3e-icon").first());
    const refreshHost = dialog.locator('m3e-icon-button[aria-label="刷新附件列表"]');
    await expectMinimumTarget(refreshHost);
    await expectCentered(refreshHost, refreshHost.locator("m3e-icon"));

    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "下载 evidence.txt" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("evidence.txt");
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
    expect(await readFile(downloadedPath!, "utf8")).toBe("hello");

    const addChooser = page.waitForEvent("filechooser");
    await dialog.getByRole("button", { name: "添加附件" }).click();
    await (await addChooser).setFiles({ name: "new.txt", mimeType: "text/plain", buffer: Buffer.from("abcdef") });
    await expect(dialog.getByLabel("附件上传进度")).toBeVisible();
    await expect(dialog.locator(".attachment-progress-value")).toContainText("%");
    await expect(dialog.getByRole("button", { name: "重试" })).toBeVisible();
    await dialog.getByRole("button", { name: "重试" }).click();
    await expect(dialog.getByText("new.txt", { exact: true })).toBeVisible();
    await expect(dialog.getByText("new.txt", { exact: true })).toHaveCount(1);
    await expect(dialog.getByText(/6 B · text\/plain/)).toBeVisible();

    const evidenceRow = dialog.locator(".provider-attachment-row").filter({ hasText: "evidence.txt" });
    const replaceChooser = page.waitForEvent("filechooser");
    await evidenceRow.getByRole("button", { name: "替换 evidence.txt 的内容" }).click();
    await (await replaceChooser).setFiles({ name: "replacement.bin", mimeType: "application/octet-stream", buffer: Buffer.from("replacement") });
    await expect(evidenceRow).toContainText("11 B · text/plain");
    await expect(dialog.getByText("replacement.bin", { exact: true })).toHaveCount(0);

    await evidenceRow.getByRole("button", { name: "删除 evidence.txt" }).click();
    const confirmEvidence = evidenceRow.getByRole("button", { name: "确认删除" });
    await expect(confirmEvidence).toBeFocused();
    await confirmEvidence.click();
    await expect(dialog.getByText("evidence.txt", { exact: true })).toHaveCount(0);

    const newRow = dialog.locator(".provider-attachment-row").filter({ hasText: "new.txt" });
    await newRow.getByRole("button", { name: "删除 new.txt" }).click();
    const confirmNew = newRow.getByRole("button", { name: "确认删除" });
    await expect(confirmNew).toBeFocused();
    await confirmNew.click();
    await expect(dialog.getByText("此项目还没有普通附件。")).toBeVisible();
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-attachments-empty.png"), fullPage: true });
  } finally {
    await context?.close();
  }
});

test("MDBX2 and KeePass attachment transfer is retry-safe", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  try {
    const launched = await launchExtension(testInfo, "p", {
      dark: true,
      reducedMotion: "reduce",
      viewport: { width: 375, height: 1000 }
    });
    context = launched.context;
    const page = launched.manager;
    await installAttachmentManagerMock(page);
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });

    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: /^登录项/ }).click();
    await page.getByRole("button", { name: "管理 附件演示账号 的附件" }).click();
    const dialog = page.getByRole("dialog", { name: "附件 · 附件演示账号" });
    const evidenceRow = dialog.locator(".provider-attachment-row").filter({ hasText: "evidence.txt" });
    const transferButton = evidenceRow.getByRole("button", { name: "复制或移动 evidence.txt 到其他密码源" });
    await expectMinimumTarget(transferButton);
    await expectCentered(transferButton, transferButton.locator("m3e-icon"));
    await transferButton.click();

    const panel = evidenceRow.locator(".attachment-transfer-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("background-image", "none");
    const targetSelect = panel.getByLabel("目标密码源 · evidence.txt");
    await expect(targetSelect).toHaveValue(KEEPASS_PROVIDER_ID);
    await expect(targetSelect).toHaveCSS("border-radius", "8px");
    await expectMinimumTarget(targetSelect);
    for (const radioTarget of await panel.locator(".attachment-transfer-mode label").all()) await expectMinimumTarget(radioTarget);
    const confirmCopy = panel.getByRole("button", { name: "确认复制" });
    await expect(confirmCopy).toBeFocused();
    await expectMinimumTarget(confirmCopy);
    await expectNoHorizontalOverflow(dialog);
    await expectNoGradients(dialog);
    await confirmCopy.click();

    await expect(dialog.getByRole("alert")).toContainText("模拟传输完成响应丢失");
    const retryCopy = panel.getByRole("button", { name: "重试传输" });
    await expect(retryCopy).toBeVisible();
    await expect(targetSelect).toBeDisabled();
    await expect(panel.getByRole("radio", { name: "复制" })).toBeDisabled();
    await retryCopy.click();
    await expect(panel).toHaveCount(0);
    await expect(dialog.getByText("evidence.txt 已完整复制到 附件演示 KeePass。", { exact: true })).toBeVisible();

    const copyRequests = await transferRequests(page);
    expect(copyRequests).toHaveLength(2);
    expect(copyRequests[0]).toMatchObject({
      sourceProviderId: MDBX_PROVIDER_ID,
      targetProviderId: KEEPASS_PROVIDER_ID,
      mode: "copy",
      confirmedMove: false
    });
    expect(copyRequests[0].operationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(copyRequests[1].operationId).toBe(copyRequests[0].operationId);

    const providerSelect = dialog.locator(".attachment-provider-field select");
    await providerSelect.selectOption(KEEPASS_PROVIDER_ID);
    await expect(dialog.getByText("evidence.txt", { exact: true })).toBeVisible();
    const keepassRow = dialog.locator(".provider-attachment-row").filter({ hasText: "keepass-note.txt" });
    await expect(keepassRow).toBeVisible();
    await keepassRow.getByRole("button", { name: "复制或移动 keepass-note.txt 到其他密码源" }).click();
    const movePanel = keepassRow.locator(".attachment-transfer-panel");
    await movePanel.getByRole("radio", { name: "移动" }).check();
    const confirmMove = movePanel.getByRole("button", { name: "确认移动" });
    await expect(confirmMove).toBeVisible();
    await expectMinimumTarget(confirmMove);
    await confirmMove.click();
    await expect(dialog.getByText("keepass-note.txt", { exact: true })).toHaveCount(0);
    await expect(dialog.getByText("keepass-note.txt 已完整写入 附件演示 MDBX2 并从 附件演示 KeePass 删除。", { exact: true })).toBeVisible();

    const allRequests = await transferRequests(page);
    expect(allRequests).toHaveLength(3);
    expect(allRequests[2]).toMatchObject({
      sourceProviderId: KEEPASS_PROVIDER_ID,
      targetProviderId: MDBX_PROVIDER_ID,
      mode: "move",
      confirmedMove: true
    });
    expect(allRequests[2].operationId).not.toBe(copyRequests[0].operationId);

    await providerSelect.selectOption(MDBX_PROVIDER_ID);
    await expect(dialog.getByText("keepass-note.txt", { exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(dialog);
    await expectNoGradients(dialog);
    await page.screenshot({ path: testInfo.outputPath("cross-provider-attachments-dark-375-large-text.png") });
  } finally {
    await context?.close();
  }
});

test("attachment commands reject popup and isolated content-script callers", async ({}, testInfo) => {
  let context: BrowserContext | undefined;
  let cdp: CDPSession | undefined;
  try {
    const launched = await launchExtension(testInfo, "mdbx2-attachment-boundary");
    context = launched.context;
    const request = { type: "PROVIDER_ATTACHMENT_LIST", providerId: "mdbx2-provider", itemId: "item-1", pageSize: 20 };

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${launched.extensionId}/popup.html`);
    const popupResponse = await popup.evaluate(async (message) => chrome.runtime.sendMessage(message), request) as RuntimeResponse;
    expect(popupResponse.ok).toBe(false);
    expect(popupResponse.error).toContain("只允许 Monica 管理页调用");

    await context.route("https://attachment-boundary.example.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>Attachment boundary</title>" }));
    const webPage = await context.newPage();
    await webPage.goto("https://attachment-boundary.example.test/");
    cdp = await context.newCDPSession(webPage);
    const contentResponse = await sendFromExtensionContentWorld(cdp, request);
    expect(contentResponse.ok).toBe(false);
    expect(contentResponse.error).toContain("只允许 Monica 插件页面调用");
  } finally {
    await cdp?.detach().catch(() => undefined);
    await context?.close();
  }
});

async function installAttachmentManagerMock(page: Page): Promise<void> {
  await installMdbx2TigaMock(page);
  await page.addInitScript(({ mdbxProviderId, keepassProviderId }) => {
    const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: Record<string, unknown>) => Promise<RuntimeResponse>;
    const itemId = "attachment-demo-item";
    const initialAttachmentId = "22222222-2222-4222-8222-222222222222";
    const keepassAttachmentId = "99999999-9999-4999-8999-999999999999";
    type MockAttachment = { attachmentId: string; providerKind: "mdbx2" | "keepass"; fileName: string; sizeBytes: number; protected: true; mediaType?: string };
    const attachmentsByProvider = new Map<string, MockAttachment[]>([
      [mdbxProviderId, [{ attachmentId: initialAttachmentId, providerKind: "mdbx2", fileName: "evidence.txt", sizeBytes: 5, protected: true, mediaType: "text/plain" }]],
      [keepassProviderId, [{ attachmentId: keepassAttachmentId, providerKind: "keepass", fileName: "keepass-note.txt", sizeBytes: 7, protected: true, mediaType: "text/plain" }]]
    ]);
    const attachmentKey = (providerId: string, attachmentId: string) => `${providerId}\n${attachmentId}`;
    const attachmentBytes = new Map<string, number[]>([
      [attachmentKey(mdbxProviderId, initialAttachmentId), [...new TextEncoder().encode("hello")]],
      [attachmentKey(keepassProviderId, keepassAttachmentId), [...new TextEncoder().encode("keepass")]]
    ]);
    const reads = new Map<string, { providerId: string; attachmentId: string }>();
    const uploads = new Map<string, { providerId: string; transferId: string; attachmentId: string; fileName: string; mediaType?: string; replaceExisting: boolean; bytes: number[] }>();
    const transferRequests: Record<string, unknown>[] = [];
    const transferReceipts = new Map<string, { fingerprint: string; result: Record<string, unknown> }>();
    (globalThis as unknown as { __monicaAttachmentTransferRequests: Record<string, unknown>[] }).__monicaAttachmentTransferRequests = transferRequests;
    let sequence = 0;
    let failFirstCreateFinish = true;
    let failFirstTransferResponse = true;

    const attachmentsFor = (providerId: string) => attachmentsByProvider.get(providerId) || [];
    const providerKind = (providerId: string): "mdbx2" | "keepass" => providerId === mdbxProviderId ? "mdbx2" : "keepass";

    Object.defineProperty(chrome.runtime, "sendMessage", {
      configurable: true,
      value: async (message: Record<string, unknown>) => {
        if (message.type === "VAULT_LIST_ITEMS") return { ok: true, data: [{
          id: itemId,
          kind: "login",
          title: "附件演示账号",
          favorite: false,
          notes: "",
          createdAt: "2026-08-02T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          providerRefs: [
            { providerId: mdbxProviderId, remoteId: "33333333-3333-4333-8333-333333333333", remoteFolderId: "44444444-4444-4444-8444-444444444444" },
            { providerId: keepassProviderId, remoteId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", remoteFolderId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }
          ],
          username: "demo@example.test",
          password: "secret",
          uris: ["example.test"],
          customFields: []
        }] };
        if (message.type === "PROVIDER_LIST") {
          const response = await originalSend(message);
          const existing = Array.isArray(response.data) ? response.data : [];
          return { ok: true, data: [
            ...existing,
            { id: mdbxProviderId, kind: "mdbx2", name: "附件演示 MDBX2", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: "55555555-5555-4555-8555-555555555555", remotePath: "Monica/MDBX2/attachments.mdbx", schemaVersion: 2 } },
            { id: keepassProviderId, kind: "keepass", name: "附件演示 KeePass", enabled: true, isDefaultSaveTarget: false, config: { sourceMode: "local", databaseId: 8 } }
          ] };
        }
        if (message.type === "KEEPASS_STATUS" && message.providerId === keepassProviderId) return { ok: true, data: { providerId: keepassProviderId, databaseName: "附件演示 KDBX", versionMajor: 4, itemCount: 1, dirty: false } };
        if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪" } };
        if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "55555555-5555-4555-8555-555555555555", open: true, available: true } };
        if (message.type === "MDBX2_VAULT_DIAGNOSTICS") return { ok: true, data: {
          checkedAtUnixSeconds: 1785648000, fileSizeBytes: 4096, formatVersion: "MDBX-2", schemaVersion: 17,
          health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [], issueKinds: [] },
          diagnostics: { commitCount: 1, tombstoneCount: 0, branchCount: 1, deviceCount: 1, snapshotCount: 0, unresolvedConflictCount: 0, projectCount: 0, folderCount: 0, deletedProjectCount: 0, entryCount: 1, deletedEntryCount: 0, attachmentCount: attachmentsFor(mdbxProviderId).length, deletedAttachmentCount: 0, externalAttachmentCount: attachmentsFor(mdbxProviderId).length, originalAttachmentBytes: 5, storedAttachmentBytes: 5 }
        } };
        if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: false, pendingBootstrap: false, pendingSegment: false, pendingRemoteAcknowledgement: false, remoteStreamCount: 1, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: attachmentsFor(mdbxProviderId).length } };
        if (message.type === "MDBX2_COLLECTION_LIST") return { ok: true, data: { items: [] } };
        if (message.type === "PROVIDER_ATTACHMENT_LIST") return { ok: true, data: { items: attachmentsFor(String(message.providerId)).map((attachment) => ({ ...attachment })) } };
        if (message.type === "PROVIDER_ATTACHMENT_READ_BEGIN") {
          const providerId = String(message.providerId);
          const attachmentId = String(message.attachmentId);
          const attachment = attachmentsFor(providerId).find((candidate) => candidate.attachmentId === attachmentId);
          if (!attachment) return { ok: false, error: "附件不存在。" };
          const readHandle = `66666666-6666-4666-8666-${String(++sequence).padStart(12, "0")}`;
          reads.set(readHandle, { providerId, attachmentId });
          return { ok: true, data: { ...attachment, readHandle, maxChunkBytes: 2 } };
        }
        if (message.type === "PROVIDER_ATTACHMENT_READ_CHUNK") {
          const readHandle = String(message.readHandle);
          const read = reads.get(readHandle);
          if (!read) return { ok: false, error: "读取会话不存在。" };
          const attachment = attachmentsFor(read.providerId).find((candidate) => candidate.attachmentId === read.attachmentId)!;
          const bytes = attachmentBytes.get(attachmentKey(read.providerId, read.attachmentId)) || [];
          const offset = Number(message.offset);
          const end = Math.min(offset + Number(message.maxBytes || 2), bytes.length);
          const chunk = bytes.slice(offset, end);
          let binary = "";
          for (const value of chunk) binary += String.fromCharCode(value);
          return { ok: true, data: { readHandle, attachmentId: attachment.attachmentId, fileName: attachment.fileName, sizeBytes: bytes.length, offset, nextOffset: end, dataBase64: btoa(binary), eof: end === bytes.length } };
        }
        if (message.type === "PROVIDER_ATTACHMENT_READ_RELEASE") {
          reads.delete(String(message.readHandle));
          return { ok: true, data: true };
        }
        if (message.type === "PROVIDER_ATTACHMENT_UPLOAD_BEGIN") {
          const providerId = String(message.providerId);
          const operationId = String(message.operationId);
          let upload = uploads.get(operationId);
          if (!upload) {
            upload = {
              providerId,
              transferId: `77777777-7777-4777-8777-${String(++sequence).padStart(12, "0")}`,
              attachmentId: String(message.attachmentId),
              fileName: String(message.fileName),
              mediaType: typeof message.mediaType === "string" ? message.mediaType : undefined,
              replaceExisting: message.replaceExisting === true,
              bytes: []
            };
            uploads.set(operationId, upload);
          }
          return { ok: true, data: { transferId: upload.transferId, operationId, attachmentId: upload.attachmentId, nextOffset: upload.bytes.length, maxChunkBytes: 2, expiresAt: Date.now() + 60_000 } };
        }
        if (message.type === "PROVIDER_ATTACHMENT_UPLOAD_CHUNK") {
          const upload = [...uploads.values()].find((candidate) => candidate.transferId === message.transferId)!;
          const binary = atob(String(message.dataBase64));
          const bytes = Array.from(binary, (value) => value.charCodeAt(0));
          const offset = Number(message.offset);
          if (offset === upload.bytes.length) upload.bytes.push(...bytes);
          await new Promise((resolve) => setTimeout(resolve, 70));
          return { ok: true, data: { transferId: upload.transferId, nextOffset: upload.bytes.length, acceptedBytes: bytes.length, repeated: false } };
        }
        if (message.type === "PROVIDER_ATTACHMENT_UPLOAD_FINISH") {
          const upload = [...uploads.values()].find((candidate) => candidate.transferId === message.transferId)!;
          const attachments = attachmentsFor(upload.providerId);
          let attachment = attachments.find((candidate) => candidate.attachmentId === upload.attachmentId);
          if (attachment) {
            attachment.sizeBytes = upload.bytes.length;
          } else {
            attachment = { attachmentId: upload.attachmentId, providerKind: providerKind(upload.providerId), fileName: upload.fileName, sizeBytes: upload.bytes.length, protected: true, mediaType: upload.mediaType };
            attachments.push(attachment);
          }
          attachmentBytes.set(attachmentKey(upload.providerId, attachment.attachmentId), [...upload.bytes]);
          if (upload.providerId === mdbxProviderId && !upload.replaceExisting && failFirstCreateFinish) {
            failFirstCreateFinish = false;
            return { ok: false, error: "模拟 Service Worker 完成响应丢失。", code: "attachment-response-lost" };
          }
          return { ok: true, data: { changed: true, attachment: { ...attachment } } };
        }
        if (message.type === "PROVIDER_ATTACHMENT_UPLOAD_ABORT") {
          for (const [operationId, upload] of uploads) if (upload.transferId === message.transferId) uploads.delete(operationId);
          return { ok: true, data: true };
        }
        if (message.type === "PROVIDER_ATTACHMENT_DELETE") {
          const providerId = String(message.providerId);
          const attachmentId = String(message.attachmentId);
          const attachments = attachmentsFor(providerId);
          const index = attachments.findIndex((candidate) => candidate.attachmentId === attachmentId);
          if (index >= 0) attachments.splice(index, 1);
          attachmentBytes.delete(attachmentKey(providerId, attachmentId));
          return { ok: true, data: { changed: index >= 0 } };
        }
        if (message.type === "PROVIDER_ATTACHMENT_TRANSFER") {
          transferRequests.push({ ...message });
          const operationId = String(message.operationId);
          const fingerprint = JSON.stringify({
            sourceProviderId: message.sourceProviderId,
            sourceItemId: message.sourceItemId,
            sourceAttachmentId: message.sourceAttachmentId,
            targetProviderId: message.targetProviderId,
            targetItemId: message.targetItemId,
            mode: message.mode,
            confirmedMove: message.confirmedMove
          });
          let receipt = transferReceipts.get(operationId);
          if (receipt && receipt.fingerprint !== fingerprint) return { ok: false, error: "操作标识已用于其他附件传输。", code: "attachment-transfer-operation-reused" };
          if (!receipt) {
            const sourceProviderId = String(message.sourceProviderId);
            const targetProviderId = String(message.targetProviderId);
            const sourceAttachmentId = String(message.sourceAttachmentId);
            const sourceAttachments = attachmentsFor(sourceProviderId);
            const sourceAttachment = sourceAttachments.find((candidate) => candidate.attachmentId === sourceAttachmentId);
            if (!sourceAttachment) return { ok: false, error: "来源附件不存在。", code: "attachment-not-found" };
            if (attachmentsFor(targetProviderId).some((candidate) => candidate.fileName === sourceAttachment.fileName)) {
              return { ok: false, error: "目标密码源已有同名附件。", code: "attachment-name-conflict" };
            }
            const sourceBytes = attachmentBytes.get(attachmentKey(sourceProviderId, sourceAttachmentId)) || [];
            const targetAttachment: MockAttachment = {
              ...sourceAttachment,
              attachmentId: `aaaaaaaa-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
              providerKind: providerKind(targetProviderId)
            };
            attachmentsFor(targetProviderId).push(targetAttachment);
            attachmentBytes.set(attachmentKey(targetProviderId, targetAttachment.attachmentId), [...sourceBytes]);
            const move = message.mode === "move";
            if (move) {
              const sourceIndex = sourceAttachments.findIndex((candidate) => candidate.attachmentId === sourceAttachmentId);
              if (sourceIndex >= 0) sourceAttachments.splice(sourceIndex, 1);
              attachmentBytes.delete(attachmentKey(sourceProviderId, sourceAttachmentId));
            }
            receipt = {
              fingerprint,
              result: {
                operationId,
                mode: move ? "move" : "copy",
                copiedBytes: sourceBytes.length,
                sourceDeleted: move,
                attachment: { ...targetAttachment }
              }
            };
            transferReceipts.set(operationId, receipt);
          }
          if (failFirstTransferResponse && message.mode === "copy") {
            failFirstTransferResponse = false;
            return { ok: false, error: "模拟传输完成响应丢失。", code: "attachment-response-lost" };
          }
          return { ok: true, data: receipt.result };
        }
        return originalSend(message);
      }
    });
  }, { mdbxProviderId: MDBX_PROVIDER_ID, keepassProviderId: KEEPASS_PROVIDER_ID });
}

async function transferRequests(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(() =>
    (globalThis as unknown as { __monicaAttachmentTransferRequests: Array<Record<string, unknown>> }).__monicaAttachmentTransferRequests
  );
}

async function sendFromExtensionContentWorld(cdp: CDPSession, message: Record<string, unknown>): Promise<RuntimeResponse> {
  const contexts: Array<{ id: number }> = [];
  cdp.on("Runtime.executionContextCreated", (event) => contexts.push({ id: event.context.id }));
  await cdp.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const context of contexts) {
    try {
      const probe = await cdp.send("Runtime.evaluate", {
        contextId: context.id,
        expression: "typeof globalThis.chrome?.runtime?.sendMessage === 'function'",
        returnByValue: true
      });
      if (probe.result.value !== true) continue;
      const evaluated = await cdp.send("Runtime.evaluate", {
        contextId: context.id,
        expression: `globalThis.chrome.runtime.sendMessage(${JSON.stringify(message)})`,
        awaitPromise: true,
        returnByValue: true
      });
      if (evaluated.exceptionDetails) continue;
      const value = evaluated.result.value as RuntimeResponse | undefined;
      if (value && typeof value.ok === "boolean") return value;
    } catch {
      // Main-world and destroyed contexts are skipped; only the isolated extension world is useful here.
    }
  }
  throw new Error("未找到可调用 chrome.runtime.sendMessage 的 Monica 内容脚本执行上下文。");
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const report = await locator.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const descendants: HTMLElement[] = [];
    const visit = (node: ParentNode) => {
      for (const child of node.querySelectorAll<HTMLElement>(":scope > *")) {
        descendants.push(child);
        visit(child);
        if (child.shadowRoot) visit(child.shadowRoot);
      }
    };
    visit(element);
    const offenders = descendants.flatMap((candidate) => {
      const rect = candidate.getBoundingClientRect();
      const boundaryOverflow = Math.max(0, root.left - rect.left, rect.right - root.right);
      const contentOverflow = Math.max(0, candidate.scrollWidth - candidate.clientWidth);
      const overflow = Math.max(boundaryOverflow, contentOverflow);
      return overflow > 1 ? [{ tag: candidate.tagName.toLowerCase(), className: candidate.className, overflow: Math.round(overflow * 10) / 10, width: Math.round(rect.width * 10) / 10, contentOverflow }] : [];
    }).slice(0, 12);
    const style = getComputedStyle(element);
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
    const verticalScrollbar = Math.max(0, element.offsetWidth - element.clientWidth - borders);
    return {
      overflow: Math.max(0, element.scrollWidth - element.clientWidth - verticalScrollbar),
      rawOverflow: element.scrollWidth - element.clientWidth,
      verticalScrollbar,
      clientWidth: element.clientWidth,
      offsetWidth: element.offsetWidth,
      scrollWidth: element.scrollWidth,
      offenders
    };
  });
  expect(report.overflow, JSON.stringify(report)).toBeLessThanOrEqual(1);
}

async function expectMinimumTarget(locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).toBeTruthy();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

async function expectCentered(container: Locator, icon: Locator): Promise<void> {
  const [containerBox, iconBox] = await Promise.all([container.boundingBox(), icon.boundingBox()]);
  expect(containerBox).toBeTruthy();
  expect(iconBox).toBeTruthy();
  expect(Math.abs((containerBox!.x + containerBox!.width / 2) - (iconBox!.x + iconBox!.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs((containerBox!.y + containerBox!.height / 2) - (iconBox!.y + iconBox!.height / 2))).toBeLessThanOrEqual(1);
}

async function expectNoGradients(locator: Locator): Promise<void> {
  const gradients = await locator.evaluate((element) => {
    const nodes = [element, ...element.querySelectorAll<HTMLElement>("*")];
    return nodes.flatMap((node) => {
      const image = getComputedStyle(node).backgroundImage;
      return image.includes("gradient") ? [{ tag: node.tagName.toLowerCase(), className: (node as HTMLElement).className, image }] : [];
    });
  });
  expect(gradients).toEqual([]);
}
