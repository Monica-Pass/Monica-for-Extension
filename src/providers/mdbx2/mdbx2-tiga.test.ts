import { describe, expect, it } from "vitest";
import type { Mdbx2VaultTigaPosture } from "./native-contract";
import {
  formatMdbx2TigaDuration,
  mdbx2TigaAuditLevelLabel,
  mdbx2TigaBrowserLimitation,
  mdbx2TigaComplianceLabel,
  mdbx2TigaDeviceAssuranceLabel,
  mdbx2TigaUnlockMethodLabel,
  presentMdbx2Tiga
} from "./mdbx2-tiga";

const posture = (overrides: Partial<Mdbx2VaultTigaPosture> = {}): Mdbx2VaultTigaPosture => ({
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
  },
  ...overrides
});

describe("MDBX2 Tiga presentation", () => {
  it("distinguishes healthy, browser-limited, exception, unlock and remediation states", () => {
    expect(presentMdbx2Tiga(posture())).toMatchObject({ tone: "healthy", icon: "verified_user", headline: "Multi 安全态势正常" });
    expect(presentMdbx2Tiga(posture({ browser: { ...posture().browser, limitations: ["secure-clipboard-unavailable"] } })))
      .toMatchObject({ tone: "attention", icon: "warning" });
    expect(presentMdbx2Tiga(posture({ compliance: "exception", hasException: true, warningCount: 1 })))
      .toMatchObject({ tone: "attention", headline: "Multi 当前使用策略例外" });
    expect(presentMdbx2Tiga(posture({ unlock: { ...posture().unlock, satisfiesPolicy: false } })))
      .toMatchObject({ tone: "danger", headline: "当前解锁配置不满足 Multi" });
    expect(presentMdbx2Tiga(posture({ compliance: "remediation-required", warningCount: 1 })))
      .toMatchObject({ tone: "danger", headline: "Multi 策略需要修复" });
  });

  it("maps every manager label without exposing Host enums", () => {
    expect(mdbx2TigaComplianceLabel("remediation-required")).toBe("需要策略修复");
    expect(mdbx2TigaUnlockMethodLabel("password-security-key")).toBe("密码 + 安全密钥");
    expect(mdbx2TigaDeviceAssuranceLabel("trusted-hardware")).toBe("可信硬件保障");
    expect(mdbx2TigaAuditLevelLabel("all-decisions")).toBe("所有安全决策");
    expect(mdbx2TigaBrowserLimitation("secure-clipboard-unavailable").label).toBe("没有安全剪贴板");
  });

  it("formats bounded Core durations for compact policy facts", () => {
    expect(formatMdbx2TigaDuration(60)).toBe("1 分钟");
    expect(formatMdbx2TigaDuration(7200)).toBe("2 小时");
    expect(formatMdbx2TigaDuration(10)).toBe("10 秒");
    expect(formatMdbx2TigaDuration(0)).toBe("0 秒");
  });
});
