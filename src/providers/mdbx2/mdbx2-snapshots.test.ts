import { describe, expect, it } from "vitest";
import { formatMdbx2SnapshotBytes, presentMdbx2Snapshot, presentMdbx2SnapshotNode } from "./mdbx2-snapshots";
import type { Mdbx2ManagedSnapshotSummary, Mdbx2SnapshotStructureNode } from "./native-contract";

function snapshot(input: Partial<Mdbx2ManagedSnapshotSummary> = {}): Mdbx2ManagedSnapshotSummary {
  return {
    snapshotId: "11111111-1111-4111-8111-111111111111",
    baseCommitId: "22222222-2222-4222-8222-222222222222",
    name: "Snapshot 2026-08-02T00:00:00Z",
    kind: "manual",
    isFull: true,
    payloadBytes: 1536,
    createdAt: "2026-08-02T00:00:00Z",
    createdByDeviceId: "device-a",
    autoPrune: false,
    integrityOk: true,
    ...input
  };
}

describe("MDBX2 Android-aligned snapshot presentation", () => {
  it("turns a Core-generated name into a readable manual snapshot label", () => {
    const result = presentMdbx2Snapshot(snapshot());
    expect(result).toMatchObject({
      title: "手动快照",
      supportingText: "手动 · 完整快照 · 1.5 KiB · 完整性正常",
      icon: "backup",
      generatedName: true,
      canRestore: true
    });
    expect(JSON.stringify(result)).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(JSON.stringify(result)).not.toContain("22222222-2222-4222-8222-222222222222");
  });

  it("preserves a custom automatic name and exposes integrity failure in text", () => {
    expect(presentMdbx2Snapshot(snapshot({
      name: "每日保留点",
      kind: "automatic",
      autoPrune: true,
      integrityOk: false
    }))).toMatchObject({
      title: "每日保留点",
      kindLabel: "自动",
      integrityLabel: "完整性失败",
      icon: "gpp_bad",
      canRestore: false
    });
  });

  it("maps structure status to Chinese text and Material Symbols", () => {
    const node: Mdbx2SnapshotStructureNode = {
      nodeId: "33333333-3333-4333-8333-333333333333",
      name: "工作账号",
      nodeType: "entry",
      path: "登录/工作账号",
      status: "modified",
      childCount: 0
    };
    expect(presentMdbx2SnapshotNode(node)).toEqual({
      title: "工作账号",
      supportingText: "登录/工作账号 · 条目",
      typeLabel: "条目",
      statusLabel: "修改",
      statusIcon: "edit"
    });
  });

  it("formats ciphertext sizes without exposing raw payload", () => {
    expect(formatMdbx2SnapshotBytes(0)).toBe("0 B");
    expect(formatMdbx2SnapshotBytes(1024)).toBe("1 KiB");
    expect(formatMdbx2SnapshotBytes(10 * 1024 * 1024)).toBe("10 MiB");
  });
});
