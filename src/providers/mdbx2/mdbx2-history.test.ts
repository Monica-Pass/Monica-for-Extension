import { describe, expect, it } from "vitest";
import { mdbx2HistoryObjectTypeLabel, presentMdbx2Diff, presentMdbx2History } from "./mdbx2-history";
import type { Mdbx2CommitDiffItem, Mdbx2CommitHistoryItem } from "./native-contract";

function history(input: Partial<Mdbx2CommitHistoryItem> = {}): Mdbx2CommitHistoryItem {
  return {
    commitId: "11111111-1111-4111-8111-111111111111",
    deviceId: "22222222-2222-4222-8222-222222222222",
    localSeq: 1,
    commitKind: "change",
    changeScope: "entry",
    createdAt: "2026-08-02T00:00:00Z",
    operationKind: "monica-extension-batch-objects",
    changes: [],
    parentIds: ["33333333-3333-4333-8333-333333333333"],
    legacy: false,
    ...input
  };
}

describe("MDBX2 Android-aligned history presentation", () => {
  it("groups a batch create into one readable operation without technical IDs", () => {
    const result = presentMdbx2History(history({
      changes: ["one", "two", "three"].map((objectId) => ({ objectType: "entry", objectId, action: "create", fields: [] }))
    }));
    expect(result).toMatchObject({ title: "添加了3 个条目", supportingText: "新增 3", objectCount: 3, isSystemCommit: false, canInspect: true, canRevert: true });
    expect(JSON.stringify(result)).not.toContain("one");
  });

  it("explains initialization and key rotation as non-inspectable system history", () => {
    expect(presentMdbx2History(history({ operationKind: "monica-initialize", changeScope: "project" }))).toMatchObject({
      title: "初始化数据库", supportingText: "建立数据库根目录和初始结构", isSystemCommit: true, canInspect: false
    });
    expect(presentMdbx2History(history({ operationKind: undefined, commitKind: "key-rotation", changeScope: "key-epoch" }))).toMatchObject({
      title: "数据库系统事件", supportingText: "更新数据库加密密钥或解锁材料", isSystemCommit: true
    });
  });

  it("matches Android commit-revert eligibility for system, mixed and oversized changes", () => {
    expect(presentMdbx2History(history({
      operationKind: "snapshot-create",
      changes: [{ objectType: "entry", objectId: "one", action: "update", fields: [] }]
    })).canRevert).toBe(false);
    expect(presentMdbx2History(history({
      changes: [
        { objectType: "entry", objectId: "one", action: "update", fields: [] },
        { objectType: "attachment", objectId: "two", action: "update", fields: [] }
      ]
    })).canRevert).toBe(false);
    expect(presentMdbx2History(history({
      changes: Array.from({ length: 501 }, (_, index) => ({ objectType: "entry", objectId: `entry-${index}`, action: "update", fields: [] }))
    })).canRevert).toBe(false);
  });

  it("uses compact mixed-action counts and content-aware labels", () => {
    const result = presentMdbx2History(history({ changes: [
      { objectType: "entry", objectId: "one", action: "create", fields: [] },
      { objectType: "entry", objectId: "two", action: "update", fields: [] },
      { objectType: "entry", objectId: "three", action: "delete", fields: [] }
    ] }));
    expect(result).toMatchObject({ title: "更新了3 个条目", supportingText: "新增 1 · 修改 1 · 删除 1" });
    expect(mdbx2HistoryObjectTypeLabel("entry", "login")).toBe("密码");
    expect(mdbx2HistoryObjectTypeLabel("entry", "steam-mafile")).toBe("Steam 账号");
    expect(mdbx2HistoryObjectTypeLabel("project")).toBe("文件夹");
  });

  it("describes diff changes without exposing decrypted payload previews", () => {
    const diff: Mdbx2CommitDiffItem = {
      commitId: "11111111-1111-4111-8111-111111111111",
      objectType: "entry",
      objectId: "22222222-2222-4222-8222-222222222222",
      previousTitle: "Before",
      currentTitle: "After",
      previousDeleted: false,
      currentDeleted: false,
      changedFields: ["title", "payload", "future_field"],
      payloadChanged: true,
      contentType: "login",
      createdAt: "2026-08-02T00:00:00Z"
    };
    expect(presentMdbx2Diff(diff)).toEqual({
      title: "更新了密码",
      supportingText: "标题已修改 · 内容已修改 · 另有 1 个字段变化",
      action: "updated",
      icon: "history",
      displayTitle: "After"
    });
  });
});
