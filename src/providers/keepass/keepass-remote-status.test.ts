import { describe, expect, it } from "vitest";
import { presentKeePassRemoteError } from "./keepass-remote-status";

describe("KeePass remote status presentation", () => {
  it("uses explicit conflict and recovery language without exposing technical codes", () => {
    expect(presentKeePassRemoteError({
      code: "remote-rebase-conflict",
      retryable: false,
      at: "2026-08-07T10:00:00.000Z"
    })).toEqual({
      icon: "merge_type",
      title: "字段或结构冲突",
      message: "相同字段或数据库结构在本机和远端都发生了变化，远端文件未被覆盖。",
      action: "retry",
      actionLabel: "重新检查冲突"
    });
  });

  it("separates retryable transport failures from credential recovery", () => {
    expect(presentKeePassRemoteError({ code: "timeout", retryable: true, at: "2026-08-07T10:00:00.000Z" }))
      .toMatchObject({ action: "retry", actionLabel: "重试同步" });
    expect(presentKeePassRemoteError({ code: "authentication", retryable: false, at: "2026-08-07T10:00:00.000Z" }))
      .toMatchObject({ action: "reconnect", actionLabel: "重新配置" });
  });
});
