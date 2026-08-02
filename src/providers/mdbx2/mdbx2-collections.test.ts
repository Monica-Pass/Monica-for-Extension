import { describe, expect, it } from "vitest";
import type { Mdbx2CollectionSummary } from "./native-contract";
import { mdbx2CollectionDescendantIds, presentMdbx2Collections } from "./mdbx2-collections";

const id = (value: number) => `${String(value).padStart(8, "0")}-1111-4111-8111-111111111111`;
const item = (value: number, title: string, groupId?: string): Mdbx2CollectionSummary => ({
  collectionId: id(value), title, groupId, favorite: false, archived: false, attachmentCount: 0,
  headCommitId: id(value + 100), deleted: false, updatedAt: "2026-08-02T00:00:00Z"
});

describe("MDBX2 Collection presentation", () => {
  it("builds readable nested paths without exposing technical IDs", () => {
    const personal = item(1, "个人");
    const accounts = item(2, "账号", personal.collectionId);
    const work = item(3, "工作", accounts.collectionId);
    const rows = presentMdbx2Collections([work, personal, accounts], [work, personal, accounts]);

    expect(rows.map((row) => row.path)).toEqual(["个人", "个人 / 账号", "个人 / 账号 / 工作"]);
    expect(rows[2]).toMatchObject({ parentPath: "个人 / 账号", depth: 2, hierarchyState: "ready" });
    expect(JSON.stringify(rows.map((row) => ({ path: row.path, parentPath: row.parentPath })))).not.toContain(work.collectionId);
  });

  it("labels missing parents and cycles without rendering an identifier", () => {
    const orphan = item(4, "孤立", id(99));
    const first = item(5, "循环一", id(6));
    const second = item(6, "循环二", id(5));
    const rows = presentMdbx2Collections([orphan, first, second], [orphan, first, second]);

    expect(rows.find((row) => row.item.collectionId === orphan.collectionId)).toMatchObject({ parentPath: "父级未加载", hierarchyState: "parent-unavailable" });
    expect(rows.filter((row) => row.item.collectionId !== orphan.collectionId).every((row) => row.hierarchyState === "cycle")).toBe(true);
    expect(rows.map((row) => row.parentPath)).not.toContain(id(99));
  });

  it("finds every descendant for move-target filtering even when input order is mixed", () => {
    const parent = item(7, "父级");
    const child = item(8, "子级", parent.collectionId);
    const grandchild = item(9, "孙级", child.collectionId);
    const peer = item(10, "同级");

    expect([...mdbx2CollectionDescendantIds([grandchild, peer, child, parent], parent.collectionId)].sort())
      .toEqual([child.collectionId, grandchild.collectionId].sort());
  });
});
