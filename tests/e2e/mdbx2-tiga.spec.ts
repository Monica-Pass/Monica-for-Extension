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

test("MDBX2 Tiga posture is compact, read-only and truthful in narrow large-text themes", async ({}, testInfo) => {
  const extensionPath = path.resolve("dist");
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(testInfo.outputPath("mdbx2-tiga-profile"), {
      channel: "chromium",
      headless: true,
      colorScheme: "dark",
      reducedMotion: "reduce",
      viewport: { width: 375, height: 1200 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/index.html`);
    expect(await page.evaluate(async () => chrome.runtime.sendMessage({ type: "VAULT_SETUP", masterPassword: "mdbx2 tiga posture password" }))).toMatchObject({ ok: true });

    await page.addInitScript(() => {
      const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<{ ok: boolean; data?: unknown; error?: string; code?: string }>;
      let tigaRequests = 0;
      const diagnostics = {
        checkedAtUnixSeconds: 1785648000,
        fileSizeBytes: 2097152,
        formatVersion: "MDBX-2",
        schemaVersion: 17,
        health: { healthy: true, issueCount: 0, infoCount: 0, warningCount: 0, errorCount: 0, criticalCount: 0, categories: [] },
        diagnostics: {
          commitCount: 4, tombstoneCount: 0, branchCount: 1, deviceCount: 1, snapshotCount: 0,
          unresolvedConflictCount: 0, projectCount: 1, folderCount: 0, deletedProjectCount: 0,
          entryCount: 1, deletedEntryCount: 0, attachmentCount: 0, deletedAttachmentCount: 0,
          externalAttachmentCount: 0, originalAttachmentBytes: 0, storedAttachmentBytes: 0
        }
      };
      const powerPosture = {
        checkedAtUnixSeconds: 1785648000,
        profile: "power",
        compliance: "compliant",
        hasException: false,
        warningCount: 0,
        unlock: {
          mode: "power",
          configuredMethods: ["password-security-key"],
          hasPortableUnlock: false,
          hasSecurityKeyUnlock: true,
          hasCombinedPasswordSecurityKey: true,
          hasRequiredCombinedStrength: true,
          satisfiesPolicy: true,
          warningCount: 0
        },
        policy: {
          policyVersion: 2,
          portableUnlockAllowed: false,
          minimumAuthFactors: 2,
          securityKeyRequired: true,
          securityKeyRecommended: true,
          idleTimeoutSeconds: 120,
          maxLifetimeSeconds: 900,
          lockOnBackground: true,
          freshAuthWindowSeconds: 60,
          revealRequiresFreshAuth: true,
          clipboardAllowed: true,
          clipboardTtlSeconds: 10,
          copyRequiresFreshAuth: true,
          secureClipboardRequired: true,
          screenCaptureProtectionRequired: true,
          exportAllowed: false,
          printAllowed: false,
          egressRequiresFreshAuth: true,
          egressMinimumAuthFactors: 2,
          persistentPlaintextCacheAllowed: false,
          attachmentTemporaryFilesAllowed: false,
          lockedCiphertextSyncAllowed: true,
          minimumRecoveryMethods: 2,
          portableRecoveryRequired: false,
          administrationRequiresFreshAuth: true,
          administrationMinimumAuthFactors: 2,
          auditDeletionAllowed: false,
          minimumDeviceAssurance: "trusted-hardware",
          auditLevel: "all-decisions"
        },
        browser: {
          deviceAssurance: "standard",
          secureClipboardAvailable: false,
          screenCaptureProtectionAvailable: false,
          secureTemporaryFilesAvailable: true,
          limitations: ["device-assurance-insufficient", "secure-clipboard-unavailable", "screen-capture-protection-unavailable"]
        },
        exceptionId: "private-exception-id",
        rawWarnings: ["private Core warning"],
        auditEvents: [{ eventId: "private-event-id" }],
        deviceId: "private-device-id",
        commitId: "private-commit-id"
      };
      const multiPosture = {
        ...powerPosture,
        checkedAtUnixSeconds: 1785648060,
        profile: "multi",
        unlock: {
          mode: "multi",
          configuredMethods: ["password"],
          hasPortableUnlock: true,
          hasSecurityKeyUnlock: false,
          hasCombinedPasswordSecurityKey: false,
          hasRequiredCombinedStrength: false,
          satisfiesPolicy: true,
          warningCount: 1
        },
        policy: {
          ...powerPosture.policy,
          portableUnlockAllowed: true,
          minimumAuthFactors: 1,
          securityKeyRequired: false,
          idleTimeoutSeconds: 600,
          maxLifetimeSeconds: 7200,
          freshAuthWindowSeconds: 300,
          secureClipboardRequired: false,
          screenCaptureProtectionRequired: false,
          exportAllowed: true,
          printAllowed: true,
          egressMinimumAuthFactors: 1,
          minimumRecoveryMethods: 1,
          portableRecoveryRequired: true,
          administrationMinimumAuthFactors: 1,
          auditDeletionAllowed: true,
          minimumDeviceAssurance: "standard",
          auditLevel: "sensitive-operations"
        },
        browser: { ...powerPosture.browser, limitations: [] }
      };
      (window as Window & { __mdbx2TigaRequests?: number }).__mdbx2TigaRequests = tigaRequests;

      Object.defineProperty(chrome.runtime, "sendMessage", {
        configurable: true,
        value: async (message: Record<string, unknown>) => {
          if (message.type === "PROVIDER_LIST") {
            const response = await originalSend(message as { type?: string });
            if (!response.ok || !Array.isArray(response.data)) return response;
            return { ok: true, data: [...response.data, {
              id: "mdbx2-tiga-demo",
              kind: "mdbx2",
              name: "Tiga 安全演示库",
              enabled: true,
              isDefaultSaveTarget: false,
              config: { remotePath: "Monica/MDBX2/tiga.mdbx", schemaVersion: 2, webDavBaseUrl: "https://dav.example.test", webDavUsername: "demo", webDavPasswordConfigured: true }
            }] };
          }
          if (message.type === "MDBX2_HOST_STATUS") return { ok: true, data: { availability: "ready", message: "测试 Host 已就绪", capabilities: { hostVersion: "0.1.0", mdbxCoreRevision: "aafa22f195c626a8d8288d712bf42bccea134847" } } };
          if (message.type === "MDBX2_VAULT_STATUS") return { ok: true, data: { vaultHandle: "11111111-1111-4111-8111-111111111111", open: true, available: true } };
          if (message.type === "MDBX2_SYNC_STATUS") return { ok: true, data: { configured: true, registered: true, initialized: true, hasLocalChanges: false, pendingBootstrap: false, pendingSegment: false, pendingRemoteAcknowledgement: false, remoteStreamCount: 1, blockedStreamCount: 0, blobTransferCount: 0, verifiedRemoteBlobCount: 0 } };
          if (message.type === "MDBX2_VAULT_DIAGNOSTICS") return { ok: true, data: diagnostics };
          if (message.type === "MDBX2_VAULT_TIGA") {
            tigaRequests += 1;
            (window as Window & { __mdbx2TigaRequests?: number }).__mdbx2TigaRequests = tigaRequests;
            if (tigaRequests === 2) return { ok: false, error: "MDBX2 vault Tiga posture failed.", code: "vault-tiga-failed" };
            if (tigaRequests >= 3) await new Promise((resolve) => setTimeout(resolve, 80));
            return { ok: true, data: tigaRequests >= 3 ? multiPosture : powerPosture };
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

    const dialog = page.getByRole("dialog", { name: "管理 Tiga 安全演示库" });
    const panel = dialog.locator(".mdbx2-tiga-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS("border-radius", "8px");
    await expect(panel).toHaveCSS("background-image", "none");
    await expect(panel.getByText("Power 已启用，浏览器环境有 3 项限制", { exact: true })).toBeVisible();
    await expect(panel.getByText("设备保障不足", { exact: true })).toBeVisible();
    await expect(panel.getByText("没有安全剪贴板", { exact: true })).toBeVisible();
    await expect(panel.getByText("没有截屏防护", { exact: true })).toBeVisible();
    await expect(panel).not.toContainText("device-assurance-insufficient");
    await expect(dialog).not.toContainText("private-exception-id");
    await expect(dialog).not.toContainText("private Core warning");
    await expect(dialog).not.toContainText("private-event-id");
    await expect(dialog).not.toContainText("private-device-id");
    await expect(dialog).not.toContainText("private-commit-id");
    await expect(dialog.getByRole("button", { name: /修改策略|编辑例外|删除审计|轮换密钥/ })).toHaveCount(0);

    const refresh = panel.getByRole("button", { name: "刷新 Tiga 安全态势" });
    expect((await refresh.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expect(panel.locator(".mdbx2-tiga-profile-badge")).toHaveCSS("border-radius", "8px");
    await expectCentered(panel.locator(".mdbx2-tiga-overview-icon"), panel.locator(".mdbx2-tiga-overview-icon m3e-icon"));
    await expectCentered(panel.locator(".mdbx2-tiga-limitation-icon").first(), panel.locator(".mdbx2-tiga-limitation-icon m3e-icon").first());

    const details = panel.locator(".mdbx2-tiga-details");
    await expect(details).not.toHaveAttribute("open", "");
    await details.getByText("查看只读策略详情", { exact: true }).click();
    await expect(details).toHaveAttribute("open", "");
    await expect(details.getByText("可信硬件保障", { exact: true })).toBeVisible();
    await expect(details.getByText("所有安全决策", { exact: true })).toBeVisible();
    await expect(details.getByText("2 分钟", { exact: true })).toBeVisible();
    await expect(details.getByText("15 分钟", { exact: true })).toBeVisible();

    await refresh.click();
    await expect(panel.getByRole("alert")).toContainText("无法生成一致的只读 Tiga 安全态势");
    await expect(panel.getByText("Power 已启用，浏览器环境有 3 项限制", { exact: true })).toBeVisible();

    await refresh.click();
    await expect(panel).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toBeDisabled();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.getByText("Multi 安全态势正常", { exact: true })).toBeVisible();
    await expect(panel.getByText("无额外限制", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as Window & { __mdbx2TigaRequests?: number }).__mdbx2TigaRequests)).toBe(3);

    expect(await panel.evaluate((element) => [...element.querySelectorAll("*")].every((child) => !getComputedStyle(child).backgroundImage.includes("gradient")))).toBe(true);
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches && matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    await expectNoHorizontalOverflow(panel);
    await expectNoHorizontalOverflow(dialog);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-tiga-dark-375-200.png"), fullPage: true });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: testInfo.outputPath("mdbx2-tiga-panel-dark-375.png") });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches)).toBe(true);
    await expect(panel).toHaveCSS("background-image", "none");
    await expectNoHorizontalOverflow(panel);
    await page.screenshot({ path: testInfo.outputPath("mdbx2-tiga-viewport-light-375.png") });
  } finally {
    await context?.close();
  }
});
