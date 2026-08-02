import { describe, expect, it } from "vitest";
import type { Mdbx2VaultHealthSummary } from "./native-contract";
import {
  formatMdbx2DiagnosticCount,
  formatMdbx2DiagnosticTime,
  mdbx2HealthCategoryLabel,
  mdbx2HealthSeverityIcon,
  presentMdbx2Health,
  summarizeMdbx2HealthCounts
} from "./mdbx2-diagnostics";

const health = (overrides: Partial<Mdbx2VaultHealthSummary> = {}): Mdbx2VaultHealthSummary => ({
  healthy: true,
  issueCount: 0,
  infoCount: 0,
  warningCount: 0,
  errorCount: 0,
  criticalCount: 0,
  categories: [],
  ...overrides
});

describe("MDBX2 diagnostics presentation", () => {
  it("distinguishes clean warnings and high-priority failures without raw Core text", () => {
    expect(presentMdbx2Health(health())).toMatchObject({ tone: "healthy", icon: "verified_user", headline: "健康检查通过" });
    expect(presentMdbx2Health(health({ issueCount: 2, warningCount: 2 }))).toMatchObject({ tone: "attention", icon: "warning" });
    expect(presentMdbx2Health(health({ healthy: false, issueCount: 2, errorCount: 1, criticalCount: 1 }))).toMatchObject({
      tone: "danger",
      icon: "gpp_bad",
      headline: "发现 2 项高优先级问题"
    });
  });

  it("maps every displayed category and severity to controlled labels", () => {
    expect(mdbx2HealthCategoryLabel("attachment-chunks")).toBe("附件分片");
    expect(mdbx2HealthCategoryLabel("other")).toBe("其他兼容性信号");
    expect(mdbx2HealthSeverityIcon("critical")).toBe("error");
    expect(mdbx2HealthSeverityIcon("info")).toBe("info");
  });

  it("formats the bounded Host timestamp for the manager", () => {
    expect(formatMdbx2DiagnosticTime(1785648000)).toContain("2026");
  });

  it("formats aggregate counts without exposing raw diagnostic details", () => {
    expect(formatMdbx2DiagnosticCount(12345)).toBe("12,345");
    expect(summarizeMdbx2HealthCounts(health())).toBe("未发现诊断问题");
    expect(summarizeMdbx2HealthCounts(health({ issueCount: 4, infoCount: 1, warningCount: 2, criticalCount: 1 })))
      .toBe("提示 1 · 警告 2 · 严重 1");
  });
});
