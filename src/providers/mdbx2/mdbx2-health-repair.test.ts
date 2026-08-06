import { describe, expect, it } from "vitest";
import {
  mdbx2HealthRepairObjectTypeLabel,
  presentMdbx2HealthRepairAutomatic,
  presentMdbx2HealthRepairConflict
} from "./mdbx2-health-repair";

describe("MDBX2 health repair presentation", () => {
  it("uses controlled user-facing labels for every disclosed object type", () => {
    expect([
      "project",
      "entry",
      "attachment",
      "object-relation",
      "object-label",
      "object-label-assignment",
      "other"
    ].map((value) => mdbx2HealthRepairObjectTypeLabel(value as never))).toEqual([
      "文件夹",
      "条目",
      "附件",
      "对象关系",
      "标签",
      "标签绑定",
      "对象"
    ]);
  });

  it("describes automatic and ambiguous work without including opaque handles", () => {
    expect(presentMdbx2HealthRepairAutomatic({
      kind: "duplicate-tombstones",
      objectType: "attachment",
      itemCount: 2,
      tombstoneCount: 5
    })).toEqual({
      icon: "filter_1",
      title: "归一重复附件删除标记",
      supporting: "将 2 个附件的 5 个同步删除标记归一为每项一个。"
    });
    const presentation = presentMdbx2HealthRepairConflict({
      itemHandle: "11111111-1111-4111-8111-111111111111",
      kind: "active-object-tombstone-conflict",
      objectType: "entry",
      tombstoneCount: 1
    });
    expect(presentation).toEqual({
      icon: "rule_settings",
      title: "条目内容与删除状态冲突",
      supporting: "这个条目同时保留内容和 1 个删除标记，需要选择最终状态。"
    });
    expect(JSON.stringify(presentation)).not.toContain("11111111");
  });
});
