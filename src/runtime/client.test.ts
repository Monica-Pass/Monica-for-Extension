import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultClient } from "./client";

describe("extension runtime client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves a bounded background error code for MDBX2 safety recovery", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: false,
      error: "Native Host 在冲突写入后异常中断。",
      code: "conflict-resolution-state-unknown"
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await expect(vaultClient.resolveMdbx2Conflict(
      "provider-1",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "incoming-wins"
    )).rejects.toMatchObject({
      name: "ExtensionRuntimeError",
      code: "conflict-resolution-state-unknown"
    });
  });

  it("sends every MDBX2 snapshot command through the typed manager contract", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const providerId = "provider-1";
    const operationId = "11111111-1111-4111-8111-111111111111";
    const snapshotId = "22222222-2222-4222-8222-222222222222";

    await vaultClient.listMdbx2Snapshots(providerId, { pageSize: 20, cursor: "next" });
    await vaultClient.listMdbx2SnapshotStructure(providerId, snapshotId, "snapshot", { pageSize: 100 });
    await vaultClient.createMdbx2Snapshot(providerId, operationId, "升级前");
    await vaultClient.deleteMdbx2Snapshot(providerId, operationId, snapshotId);
    await vaultClient.restoreMdbx2Snapshot(providerId, operationId, snapshotId);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "MDBX2_SNAPSHOT_LIST", providerId, pageSize: 20, cursor: "next" },
      { type: "MDBX2_SNAPSHOT_STRUCTURE", providerId, snapshotId, side: "snapshot", pageSize: 100 },
      { type: "MDBX2_SNAPSHOT_CREATE", providerId, operationId, name: "升级前" },
      { type: "MDBX2_SNAPSHOT_DELETE", providerId, operationId, snapshotId },
      { type: "MDBX2_SNAPSHOT_RESTORE", providerId, operationId, snapshotId }
    ]);
  });

  it("preserves the snapshot unknown-outcome code for safe manager recovery", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: false,
      error: "无法证明快照恢复结果。",
      code: "snapshot-operation-state-unknown"
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await expect(vaultClient.restoreMdbx2Snapshot(
      "provider-1",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    )).rejects.toMatchObject({
      name: "ExtensionRuntimeError",
      code: "snapshot-operation-state-unknown"
    });
  });
});
