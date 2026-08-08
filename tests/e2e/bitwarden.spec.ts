import { chromium, expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import path from "node:path";

const PROVIDER_ID = "bitwarden-ui-demo";

test("Bitwarden status conflict permission and recovery UI is truthful responsive and secret-free", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  const nativeDialogs: string[] = [];
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("bitwarden-status-ui-profile"), {
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
    page.on("dialog", (dialog) => {
      nativeDialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "bitwarden status ui password" }))).toMatchObject({ ok: true });

    await page.addInitScript(({ providerId }) => {
      type RuntimeResponse = { ok: boolean; data?: unknown; error?: string };
      type RuntimeMessage = { type?: string; providerId?: string; conflictId?: string; allowEmptyRemote?: boolean };
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: RuntimeMessage) => Promise<RuntimeResponse>;
      const now = "2026-08-08T16:00:00.000Z";
      const sensitive = {
        username: "secret-user@example.test",
        password: "never-render-conflict-password",
        notes: "never-render-private-note"
      };
      const makeItem = (id: string, title: string) => ({
        id,
        kind: "login",
        title,
        favorite: false,
        notes: sensitive.notes,
        createdAt: now,
        updatedAt: now,
        providerRefs: [{ providerId }],
        username: sensitive.username,
        password: sensitive.password,
        uris: ["https://secret.example.test"],
        customFields: [{ name: "private", value: "never-render-custom-field", protected: true }]
      });
      let emptyConfirmed = false;
      let emptyAttempts = 0;
      let queueCleared = false;
      let conflicts = [
        { id: "conflict-1", providerId, itemId: "item-1", reason: "服务器与浏览器都修改了此项目。", detectedAt: now, local: makeItem("local-1", "工作账号"), remote: makeItem("remote-1", "工作账号") },
        { id: "conflict-2", providerId, itemId: "item-2", reason: "远端 Revision 已变化。", detectedAt: now, local: makeItem("local-2", "财务账号"), remote: makeItem("remote-2", "财务账号") },
        { id: "conflict-3", providerId, itemId: "item-3", reason: "浏览器修改与远端删除冲突。", detectedAt: now, local: makeItem("local-3", "第三个账号") },
        { id: "conflict-4", providerId, itemId: "item-4", reason: "远端修改与浏览器删除冲突。", detectedAt: now, remote: makeItem("remote-4", "第四个账号") }
      ];

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: RuntimeMessage): Promise<RuntimeResponse> => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return {
              ok: true,
              data: [...response.data, {
                id: providerId,
                kind: "bitwarden",
                name: "Bitwarden 工作库",
                enabled: true,
                isDefaultSaveTarget: false,
                config: {
                  email: "very.long.account.address.for.layout@example.test",
                  vaultUrl: "https://vault.example.test/a/very/long/private/path?access_token=never-render-url-token"
                },
                lastSyncAt: now,
                lastError: queueCleared ? undefined : "连接超时，请检查服务器状态。",
                requiresEmptyRemoteConfirmation: !emptyConfirmed,
                compatibility: { preservedUnsupportedRecords: 2, unreadableRecords: 1 }
              }]
            };
          }
          if (message.type === "PROVIDER_QUEUE_STATUS") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return {
              ok: true,
              data: [...response.data, queueCleared
                ? { providerId, pending: 0, failed: 0, recovering: 0, maxAttempts: 5 }
                : { providerId, pending: 5, failed: 2, recovering: 1, maxAttempts: 5, lastError: "连接超时，请检查服务器状态。" }]
            };
          }
          if (message.type === "PROVIDER_CONFLICT_LIST") return { ok: true, data: conflicts };
          if (message.type === "PROVIDER_CONFLICT_RESOLVE" && message.conflictId) {
            conflicts = conflicts.filter((conflict) => conflict.id !== message.conflictId);
            return { ok: true };
          }
          if (message.type === "PROVIDER_SYNC" && message.providerId === providerId) {
            if (message.allowEmptyRemote) {
              emptyAttempts += 1;
              if (emptyAttempts === 1) return { ok: false, error: "网络暂时不可用，请重试空库确认。" };
              emptyConfirmed = true;
              queueCleared = true;
            }
            return { ok: true, data: { warnings: [], conflicts: conflicts.length } };
          }
          if (message.type === "PROVIDER_SYNC_CANCEL" && message.providerId === providerId) return { ok: true, data: { cancelled: true } };
          return originalSend(message);
        }
      });
    }, { providerId: PROVIDER_ID });

    await page.reload();
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "打开导航" }).click();
    await page.getByRole("button", { name: "密码源" }).click();

    const card = page.locator(".bitwarden-provider-card").filter({ has: page.getByRole("heading", { name: "Bitwarden 工作库" }) });
    await expect(card).toBeVisible();
    await expect(card).toHaveCSS("border-radius", "8px");
    await expect(card.getByText("vault.example.test", { exact: true })).toBeVisible();
    await expect(card).not.toContainText("never-render-url-token");
    await expect(card.getByText("4 个冲突", { exact: true })).toBeVisible();
    await expect(card.getByText("5 待同步 · 1 恢复中 · 2 失败", { exact: true })).toBeVisible();
    await expect(card.getByText("个人文件夹 + 组织 Collection", { exact: true })).toBeVisible();
    await expect(card.getByText("连接超时，请检查服务器状态。", { exact: true })).toHaveCount(1);
    await expect(card.getByText("兼容模式保留 3 个项目", { exact: true })).toBeVisible();
    await expect(card.getByText("第三个账号", { exact: true })).toHaveCount(0);
    await expect(card.getByText("第四个账号", { exact: true })).toHaveCount(0);
    await expectNoHorizontalOverflow(page.locator("html"));
    await expectNoHorizontalOverflow(card);
    await expectNoGradients(card);
    await expectMinimumTargets(card.locator("m3e-button, m3e-icon-button"));
    await expectSecretsAbsent(page);

    const conflictToggle = card.locator(".bitwarden-conflict-toggle");
    await expect(conflictToggle).toContainText("查看其余 2 个冲突");
    await conflictToggle.click();
    await expect(conflictToggle).toHaveAttribute("aria-expanded", "true");
    await expect(conflictToggle).toContainText("收起其余冲突");
    await expect(card.getByText("第三个账号", { exact: true })).toBeVisible();
    await expect(card.getByText("第四个账号", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "采用 Bitwarden 版本" }).first().click();
    const conflictDialog = page.getByRole("dialog", { name: "采用 Bitwarden 版本？" });
    await expect(conflictDialog).toBeVisible();
    await expectFourRoundedCorners(conflictDialog, "16px");
    await expect(conflictDialog.getByRole("button", { name: "取消" })).toBeFocused();
    await expectNoHorizontalOverflow(conflictDialog);
    await expectNoGradients(conflictDialog);
    await expectSecretsAbsent(page);
    await conflictDialog.getByRole("button", { name: "确认采用 Bitwarden 版本" }).click();
    await expect(conflictDialog).toHaveCount(0);
    await expect(card.getByText("3 个冲突", { exact: true })).toBeVisible();

    const emptyButton = card.getByRole("button", { name: "查看并确认空库" });
    await emptyButton.click();
    const emptyDialog = page.getByRole("dialog", { name: "采用服务器空密码库？" });
    await expect(emptyDialog).toBeVisible();
    await expectFourRoundedCorners(emptyDialog, "16px");
    await expect(emptyDialog.getByRole("button", { name: "取消" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(emptyDialog).toHaveCount(0);
    await expect(emptyButton).toBeFocused();

    await emptyButton.click();
    const retryDialog = page.getByRole("dialog", { name: "采用服务器空密码库？" });
    await retryDialog.getByRole("button", { name: "确认采用空库" }).click();
    await expect(retryDialog.getByRole("alert")).toContainText("网络暂时不可用，请重试空库确认。");
    await expect(retryDialog).toBeVisible();
    await retryDialog.getByRole("button", { name: "确认采用空库" }).click();
    await expect(retryDialog).toHaveCount(0);
    await expect(card.getByRole("button", { name: "查看并确认空库" })).toHaveCount(0);
    await expect(card.getByText("没有待处理操作", { exact: true })).toBeVisible();
    await expectSecretsAbsent(page);
    expect(nativeDialogs).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("bitwarden-status-recovery.png"), fullPage: true });
  } finally {
    await context?.close();
  }
});

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const overflow = await locator.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const offenders = [element, ...element.querySelectorAll<HTMLElement>("*")].flatMap((candidate) => {
      const rect = candidate.getBoundingClientRect();
      if (rect.right <= root.right + 1 && candidate.scrollWidth <= candidate.clientWidth + 1) return [];
      const style = getComputedStyle(candidate);
      return [{
        tag: candidate.tagName,
        className: String(candidate.className),
        text: candidate.textContent?.trim().replace(/\s+/g, " ").slice(0, 80),
        clientWidth: candidate.clientWidth,
        scrollWidth: candidate.scrollWidth,
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: style.width,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth,
        boxSizing: style.boxSizing,
        display: style.display,
        position: style.position
      }];
    }).slice(0, 12);
    return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, offenders };
  });
  expect(overflow.scrollWidth, JSON.stringify(overflow.offenders, null, 2)).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function expectNoGradients(locator: Locator): Promise<void> {
  const offenders = await locator.evaluate((root) => [root, ...root.querySelectorAll<HTMLElement>("*")]
    .flatMap((candidate) => /gradient\(/i.test(getComputedStyle(candidate).backgroundImage) ? [candidate.className] : []));
  expect(offenders).toEqual([]);
}

async function expectMinimumTargets(locator: Locator): Promise<void> {
  const boxes = await locator.evaluateAll((elements) => elements
    .filter((element) => (element as HTMLElement).getClientRects().length > 0)
    .map((element) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return { width: rect.width, height: rect.height, label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName };
    }));
  for (const box of boxes) {
    expect(box.height, `${box.label} height`).toBeGreaterThanOrEqual(44);
    expect(box.width, `${box.label} width`).toBeGreaterThanOrEqual(44);
  }
}

async function expectFourRoundedCorners(locator: Locator, expected: string): Promise<void> {
  const corners = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
  });
  expect(corners).toEqual([expected, expected, expected, expected]);
}

async function expectSecretsAbsent(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  for (const secret of [
    "never-render-conflict-password",
    "never-render-private-note",
    "never-render-custom-field",
    "secret-user@example.test",
    "never-render-url-token",
    "https://secret.example.test"
  ]) expect(text).not.toContain(secret);
}
