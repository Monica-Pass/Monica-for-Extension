import { describe, expect, it } from "vitest";
import { mdbx2ConflictChoiceDescription, mdbx2ConflictChoiceLabel, presentMdbx2Conflict } from "./mdbx2-conflicts";
import type { Mdbx2ConflictSummary } from "./native-contract";

describe("MDBX2 conflict presentation", () => {
  it("uses local display metadata and readable fields without exposing technical IDs", () => {
    const item: Mdbx2ConflictSummary = {
      conflictId: "11111111-1111-4111-8111-111111111111",
      objectType: "entry",
      objectId: "22222222-2222-4222-8222-222222222222",
      displayTitle: "工作账号",
      contentType: "login",
      conflictingFields: ["title_ct", "payload", "project_id", "future_field"],
      createdAt: "2026-08-02T00:00:00Z"
    };
    const result = presentMdbx2Conflict(item);
    expect(result).toMatchObject({
      title: "工作账号",
      objectLabel: "密码",
      fieldLabels: ["标题", "内容", "位置", "其他字段（future_field）"],
      icon: "call_merge"
    });
    expect(result.supportingText).toBe("冲突字段：标题、内容、位置 等 4 项");
    expect(JSON.stringify(result)).not.toContain(item.conflictId);
    expect(JSON.stringify(result)).not.toContain(item.objectId);
  });

  it("states the impact of both explicit core-equivalent choices", () => {
    expect(mdbx2ConflictChoiceLabel("local-wins")).toBe("保留本机版本");
    expect(mdbx2ConflictChoiceLabel("incoming-wins")).toBe("采用传入版本");
    expect(mdbx2ConflictChoiceDescription("local-wins")).toContain("传入设备的并发修改不会应用");
    expect(mdbx2ConflictChoiceDescription("incoming-wins")).toContain("当前浏览器中的并发修改会被替换");
  });
});
