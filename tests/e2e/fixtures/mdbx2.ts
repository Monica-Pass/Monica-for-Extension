import type { Page } from "@playwright/test";

export const MDBX2_TIGA_MULTI_POSTURE = {
  checkedAtUnixSeconds: 1785648000,
  profile: "multi",
  compliance: "compliant",
  hasException: false,
  warningCount: 0,
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
    policyVersion: 2,
    portableUnlockAllowed: true,
    minimumAuthFactors: 1,
    securityKeyRequired: false,
    securityKeyRecommended: true,
    idleTimeoutSeconds: 600,
    maxLifetimeSeconds: 7200,
    lockOnBackground: true,
    freshAuthWindowSeconds: 300,
    revealRequiresFreshAuth: true,
    clipboardAllowed: true,
    clipboardTtlSeconds: 30,
    copyRequiresFreshAuth: true,
    secureClipboardRequired: false,
    screenCaptureProtectionRequired: false,
    exportAllowed: true,
    printAllowed: true,
    egressRequiresFreshAuth: true,
    egressMinimumAuthFactors: 1,
    persistentPlaintextCacheAllowed: false,
    attachmentTemporaryFilesAllowed: false,
    lockedCiphertextSyncAllowed: true,
    minimumRecoveryMethods: 1,
    portableRecoveryRequired: true,
    administrationRequiresFreshAuth: true,
    administrationMinimumAuthFactors: 1,
    auditDeletionAllowed: true,
    minimumDeviceAssurance: "standard",
    auditLevel: "sensitive-operations"
  },
  browser: {
    deviceAssurance: "standard",
    secureClipboardAvailable: false,
    screenCaptureProtectionAvailable: false,
    secureTemporaryFilesAvailable: true,
    limitations: []
  }
} as const;

export async function installMdbx2TigaMock(page: Page): Promise<void> {
  await page.addInitScript((posture) => {
    const originalSend = chrome.runtime.sendMessage.bind(chrome.runtime) as (message: { type?: string }) => Promise<unknown>;
    Object.defineProperty(chrome.runtime, "sendMessage", {
      configurable: true,
      value: async (message: Record<string, unknown>) => message.type === "MDBX2_VAULT_TIGA"
        ? { ok: true, data: posture }
        : originalSend(message)
    });
  }, MDBX2_TIGA_MULTI_POSTURE);
}
