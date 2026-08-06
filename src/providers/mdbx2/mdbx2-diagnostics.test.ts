import { describe, expect, it } from "vitest";
import type { Mdbx2VaultHealthSummary } from "./native-contract";
import {
  formatMdbx2DiagnosticCount,
  formatMdbx2DiagnosticTime,
  mdbx2HealthCategoryLabel,
  mdbx2HealthSeverityIcon,
  presentMdbx2Health,
  presentMdbx2HealthGuidance,
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
  issueKinds: [],
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

  it("maps safe Host issue kinds to prioritized controlled recovery guidance", () => {
    const guidance = presentMdbx2HealthGuidance(health({
      healthy: false,
      issueCount: 4,
      warningCount: 1,
      errorCount: 2,
      criticalCount: 1,
      categories: [
        { category: "commit-chain", count: 1, highestSeverity: "critical" },
        { category: "tombstones", count: 2, highestSeverity: "error" },
        { category: "stale-heads", count: 1, highestSeverity: "warning" }
      ],
      issueKinds: [
        { kind: "inactive-device", count: 1, highestSeverity: "warning" },
        { kind: "tombstone-stale", count: 2, highestSeverity: "error" },
        { kind: "commit-reference-missing", count: 1, highestSeverity: "critical" }
      ]
    }));

    expect(guidance.map((item) => item.kind)).toEqual([
      "commit-reference-missing",
      "tombstone-stale",
      "inactive-device"
    ]);
    expect(guidance[0]).toMatchObject({ title: "历史记录引用不完整", action: "history", actionLabel: "查看提交历史" });
    expect(guidance[1].title).toBe("有效内容残留删除标记（2 项）");
    expect(guidance[2]).toMatchObject({ action: "history", severity: "warning" });
    expect(JSON.stringify(guidance)).not.toContain("commit-chain");
  });
});
