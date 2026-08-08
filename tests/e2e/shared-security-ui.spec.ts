import { chromium, expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import path from "node:path";

const PROVIDER_ID = "shared-webdav-provider";

test("shared provider and Windows Hello actions use secret-free retry-safe M3E confirmations", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  const nativeDialogs: string[] = [];
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("shared-security-ui-profile"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 1000 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const manager = await context.newPage();
    manager.on("dialog", (dialog) => {
      nativeDialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await manager.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await manager.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "" }))).toMatchObject({ ok: true });

    await manager.addInitScript(({ providerId }) => {
      type RuntimeResponse = { ok: boolean; data?: unknown; error?: string };
      type RuntimeMessage = { type?: string; providerId?: string; conflictId?: string };
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: RuntimeMessage) => Promise<RuntimeResponse>;
      const now = "2026-08-09T00:00:00.000Z";
      let providerRemoved = false;
      let conflictResolved = false;
      let removeAttempts = 0;
      let helloEnrolled = false;
      let revokeAttempts = 0;
      const provider = {
        id: providerId,
        kind: "monica-webdav",
        name: "Android 共享库",
        enabled: true,
        isDefaultSaveTarget: false,
        config: {
          baseUrl: "https://private-user:private-password@dav.example.test/private/path?access_token=never-render-webdav-token",
          username: "private-user",
          passwordConfigured: true,
          backupPasswordConfigured: true
        },
        lastSyncAt: now
      };
      const secretItem = {
        id: "secret-item",
        kind: "login",
        title: "共享冲突账号",
        username: "never-render-shared-user",
        password: "never-render-shared-password",
        notes: "never-render-shared-note",
        customFields: [{ name: "private", value: "never-render-shared-custom", protected: true }],
        uris: ["https://never-render-shared.example.test"],
        favorite: false,
        createdAt: now,
        updatedAt: now,
        providerRefs: [{ providerId }]
      };

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: RuntimeMessage): Promise<RuntimeResponse> => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message);
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: providerRemoved ? response.data : [...response.data, provider] };
          }
          if (message.type === "PROVIDER_QUEUE_STATUS") {
            const response = await originalSend(message);
            return response.ok && Array.isArray(response.data) ? { ok: true, data: response.data } : response;
          }
          if (message.type === "PROVIDER_CONFLICT_LIST") {
            return { ok: true, data: providerRemoved || conflictResolved ? [] : [{ id: "shared-conflict", providerId, reason: "浏览器与 Android 快照都发生了修改。", detectedAt: now, local: secretItem, remote: { ...secretItem, id: "remote-secret-item" } }] };
          }
          if (message.type === "PROVIDER_CONFLICT_RESOLVE" && message.conflictId === "shared-conflict") {
            conflictResolved = true;
            return { ok: true };
          }
          if (message.type === "PROVIDER_REMOVE" && message.providerId === providerId) {
            removeAttempts += 1;
            if (removeAttempts === 1) return { ok: false, error: "模拟网络中断，密码源仍保留。" };
            providerRemoved = true;
            return { ok: true };
          }
          if (message.type === "VAULT_HELLO_STATUS") return { ok: true, data: {
            native: { version: 1, supported: true, available: true, enrolled: helloEnrolled, bindingIdPresent: helloEnrolled, rpId: "monica-extension.local", reason: helloEnrolled ? "ready" : "not-enrolled" },
            vaultEnrolled: helloEnrolled,
            bindingConsistent: true,
            protectionMode: "device-key",
            unlockAvailable: helloEnrolled
          } };
          if (message.type === "VAULT_HELLO_ENROLL") {
            helloEnrolled = true;
            return { ok: true, data: { version: 1, bindingId: "shared-binding", rpId: "monica-extension.local", enrolledAt: now } };
          }
          if (message.type === "VAULT_HELLO_REVOKE") {
            revokeAttempts += 1;
            if (revokeAttempts === 1) return { ok: false, error: "模拟 Windows Hello 撤销失败，请重试。" };
            helloEnrolled = false;
            return { ok: true };
          }
          return originalSend(message);
        }
      });
    }, { providerId: PROVIDER_ID });

    await manager.reload();
    await manager.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await openMobileSection(manager, "密码源");

    const providerCard = manager.locator("m3e-card.source-card").filter({ has: manager.getByRole("heading", { name: "Android 共享库" }) });
    await expect(providerCard).toBeVisible();
    await expect(providerCard.getByText("dav.example.test", { exact: true })).toBeVisible();
    await expect(providerCard).not.toContainText("private/path");
    await expectNoGradients(providerCard);
    await expectSecretsAbsent(manager);

    await providerCard.getByRole("button", { name: "采用 Android 版本" }).click();
    const conflictDialog = manager.getByRole("dialog", { name: "采用 Android 版本？" });
    await expect(conflictDialog).toBeVisible();
    await expectFourRoundedCorners(conflictDialog, "16px");
    await expect(conflictDialog.getByRole("button", { name: "取消" })).toBeFocused();
    await expectNoHorizontalOverflow(conflictDialog);
    await expectNoGradients(conflictDialog);
    await expectSecretsAbsent(manager);
    await conflictDialog.getByRole("button", { name: "确认采用 Android 版本" }).click();
    await expect(conflictDialog).toHaveCount(0);
    await expect(providerCard.getByText("1 个冲突", { exact: true })).toHaveCount(0);

    const removeButton = providerCard.getByRole("button", { name: "移除 WebDAV" });
    await removeButton.click();
    const removeDialog = manager.getByRole("dialog", { name: "移除“Android 共享库”？" });
    await expect(removeDialog).toBeVisible();
    await expectFourRoundedCorners(removeDialog, "16px");
    await expectNoGradients(removeDialog);
    await removeDialog.getByRole("button", { name: "确认移除密码源" }).click();
    await expect(removeDialog.getByRole("alert")).toContainText("模拟网络中断，密码源仍保留。");
    await expect(removeDialog).toBeVisible();
    await expect(providerCard).toBeVisible();
    await removeDialog.getByRole("button", { name: "确认移除密码源" }).click();
    await expect(removeDialog).toHaveCount(0);
    await expect(providerCard).toHaveCount(0);

    await openMobileSection(manager, "设置与备份");
    const helloCard = manager.locator(".windows-hello-card");
    await expectNoGradients(helloCard);
    const enrollButton = helloCard.getByRole("button", { name: "注册 Windows Hello" });
    await expect(enrollButton).toBeEnabled();
    await enrollButton.click();
    const enrollDialog = manager.getByRole("dialog", { name: "注册 Windows Hello？" });
    await expect(enrollDialog.getByRole("button", { name: "取消" })).toBeFocused();
    await manager.keyboard.press("Escape");
    await expect(enrollDialog).toHaveCount(0);
    await expect(enrollButton).toBeFocused();

    await enrollButton.click();
    const enrollRetry = manager.getByRole("dialog", { name: "注册 Windows Hello？" });
    await enrollRetry.getByRole("button", { name: "确认注册 Windows Hello" }).click();
    await expect(enrollRetry).toHaveCount(0);
    await expect(helloCard.getByText("已注册", { exact: true })).toBeVisible();

    await helloCard.getByRole("button", { name: "撤销本机绑定" }).click();
    const revokeDialog = manager.getByRole("dialog", { name: "撤销本机 Windows Hello 绑定？" });
    await expectFourRoundedCorners(revokeDialog, "16px");
    await expectNoGradients(revokeDialog);
    await revokeDialog.getByRole("button", { name: "确认撤销本机绑定" }).click();
    await expect(revokeDialog.getByRole("alert")).toContainText("模拟 Windows Hello 撤销失败，请重试。");
    await expect(revokeDialog).toBeVisible();
    await revokeDialog.getByRole("button", { name: "确认撤销本机绑定" }).click();
    await expect(revokeDialog).toHaveCount(0);
    await expect(helloCard.getByText("未注册", { exact: true })).toBeVisible();

    await expectNoHorizontalOverflow(manager.locator("html"));
    await expectMinimumTargets(helloCard.locator("m3e-button, m3e-icon-button"));
    await expectSecretsAbsent(manager);
    expect(nativeDialogs).toEqual([]);
    await manager.screenshot({ path: testInfo.outputPath("shared-security-ui.png"), fullPage: true });
  } finally {
    await context?.close();
  }
});

async function openMobileSection(page: Page, name: string): Promise<void> {
  const openNavigation = page.getByRole("button", { name: "打开导航" });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole("button", { name }).click();
}

async function expectNoHorizontalOverflow(locator: Locator): Promise<void> {
  const dimensions = await locator.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
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
    "private-user",
    "private-password",
    "never-render-webdav-token",
    "private/path",
    "never-render-shared-user",
    "never-render-shared-password",
    "never-render-shared-note",
    "never-render-shared-custom",
    "never-render-shared.example.test"
  ]) expect(text).not.toContain(secret);
}
