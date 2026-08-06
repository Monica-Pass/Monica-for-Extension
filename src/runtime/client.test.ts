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
    const planToken = "a".repeat(64);

    await vaultClient.listMdbx2Snapshots(providerId, { pageSize: 20, cursor: "next" });
    await vaultClient.listMdbx2SnapshotStructure(providerId, snapshotId, "snapshot", { pageSize: 100 });
    await vaultClient.planMdbx2AutomaticSnapshotPrune(providerId, 0);
    await vaultClient.pruneMdbx2AutomaticSnapshots(providerId, planToken, 0);
    await vaultClient.createMdbx2Snapshot(providerId, operationId, "升级前");
    await vaultClient.deleteMdbx2Snapshot(providerId, operationId, snapshotId);
    await vaultClient.restoreMdbx2Snapshot(providerId, operationId, snapshotId);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "MDBX2_SNAPSHOT_LIST", providerId, pageSize: 20, cursor: "next" },
      { type: "MDBX2_SNAPSHOT_STRUCTURE", providerId, snapshotId, side: "snapshot", pageSize: 100 },
      { type: "MDBX2_SNAPSHOT_PRUNE_PLAN", providerId, keepLatest: 0 },
      { type: "MDBX2_SNAPSHOT_PRUNE_EXECUTE", providerId, planToken, keepLatest: 0 },
      { type: "MDBX2_SNAPSHOT_CREATE", providerId, operationId, name: "升级前" },
      { type: "MDBX2_SNAPSHOT_DELETE", providerId, operationId, snapshotId },
      { type: "MDBX2_SNAPSHOT_RESTORE", providerId, operationId, snapshotId }
    ]);
  });

  it("sends MDBX2 history recovery through the manager contract with caller operation identity", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const providerId = "provider-1";
    const operationId = "11111111-1111-4111-8111-111111111111";
    const commitId = "22222222-2222-4222-8222-222222222222";

    await vaultClient.revertMdbx2Commit(providerId, operationId, commitId);

    expect(sendMessage).toHaveBeenCalledWith({ type: "MDBX2_HISTORY_REVERT", providerId, operationId, commitId });
  });

  it("sends every MDBX2 Collection command with retained operation identity", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const providerId = "provider-1";
    const operationId = "11111111-1111-4111-8111-111111111111";
    const collectionId = "22222222-2222-4222-8222-222222222222";
    const parentCollectionId = "33333333-3333-4333-8333-333333333333";

    await vaultClient.listMdbx2Collections(providerId, { deleted: true, excludeRoot: true, pageSize: 50, cursor: "next" });
    await vaultClient.createMdbx2Collection(providerId, operationId, collectionId, "Accounts", parentCollectionId);
    await vaultClient.renameMdbx2Collection(providerId, operationId, collectionId, "Work");
    await vaultClient.moveMdbx2Collection(providerId, operationId, collectionId);
    await vaultClient.deleteMdbx2Collection(providerId, operationId, collectionId);
    await vaultClient.restoreMdbx2Collection(providerId, operationId, collectionId, parentCollectionId);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "MDBX2_COLLECTION_LIST", providerId, deleted: true, excludeRoot: true, pageSize: 50, cursor: "next" },
      { type: "MDBX2_COLLECTION_CREATE", providerId, operationId, collectionId, title: "Accounts", parentCollectionId },
      { type: "MDBX2_COLLECTION_RENAME", providerId, operationId, collectionId, title: "Work" },
      { type: "MDBX2_COLLECTION_MOVE", providerId, operationId, collectionId, parentCollectionId: undefined },
      { type: "MDBX2_COLLECTION_DELETE", providerId, operationId, collectionId, confirmed: true },
      { type: "MDBX2_COLLECTION_RESTORE", providerId, operationId, collectionId, parentCollectionId }
    ]);
  });

  it("sends MDBX2 diagnostics refresh through the typed manager contract", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await vaultClient.mdbx2VaultDiagnostics("provider-1");

    expect(sendMessage).toHaveBeenCalledWith({ type: "MDBX2_VAULT_DIAGNOSTICS", providerId: "provider-1" });
  });

  it("sends MDBX2 Tiga posture through the typed manager contract", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await vaultClient.mdbx2VaultTiga("provider-1");

    expect(sendMessage).toHaveBeenCalledWith({ type: "MDBX2_VAULT_TIGA", providerId: "provider-1" });
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

  it("sends bounded provider attachment commands through the manager contract", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const providerId = "keepass-1";
    const itemId = "item-1";
    const attachmentId = "11111111-1111-4111-8111-111111111111";
    const transferId = "22222222-2222-4222-8222-222222222222";
    const readHandle = "33333333-3333-4333-8333-333333333333";

    await vaultClient.listProviderAttachments(providerId, itemId, { pageSize: 20, cursor: "next" });
    await vaultClient.beginProviderAttachmentRead(providerId, itemId, attachmentId);
    await vaultClient.readProviderAttachmentChunk(providerId, readHandle, 0, 1024);
    await vaultClient.releaseProviderAttachmentRead(providerId, readHandle);
    await vaultClient.beginProviderAttachmentUpload(providerId, itemId, { fileName: "a.txt", mediaType: "text/plain", sizeBytes: 2, sha256: "a".repeat(64), replaceExisting: true });
    await vaultClient.sendProviderAttachmentChunk(providerId, transferId, 0, new Uint8Array([1, 2]));
    await vaultClient.finishProviderAttachmentUpload(providerId, itemId, transferId);
    await vaultClient.abortProviderAttachmentUpload(providerId, transferId);
    await vaultClient.deleteProviderAttachment(providerId, itemId, attachmentId);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "PROVIDER_ATTACHMENT_LIST", providerId, itemId, pageSize: 20, cursor: "next" },
      { type: "PROVIDER_ATTACHMENT_READ_BEGIN", providerId, itemId, attachmentId },
      { type: "PROVIDER_ATTACHMENT_READ_CHUNK", providerId, readHandle, offset: 0, maxBytes: 1024 },
      { type: "PROVIDER_ATTACHMENT_READ_RELEASE", providerId, readHandle },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN", providerId, itemId, fileName: "a.txt", mediaType: "text/plain", sizeBytes: 2, sha256: "a".repeat(64), replaceExisting: true },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK", providerId, transferId, offset: 0, dataBase64: "AQI=" },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH", providerId, itemId, transferId },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_ABORT", providerId, transferId },
      { type: "PROVIDER_ATTACHMENT_DELETE", providerId, itemId, attachmentId, confirmed: true }
    ]);
  });

  it("preserves provider attachment error codes for manager recovery", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: false,
      error: "附件 SHA-256 校验失败。",
      code: "attachment-upload-digest-mismatch"
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await expect(vaultClient.finishProviderAttachmentUpload(
      "keepass-1",
      "item-1",
      "11111111-1111-4111-8111-111111111111"
    ))
      .rejects.toMatchObject({ name: "ExtensionRuntimeError", code: "attachment-upload-digest-mismatch" });
  });

  it("sends KeePass group lifecycle commands with explicit mutation identity and delete confirmation", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const providerId = "keepass-1";
    const operationId = "11111111-1111-4111-8111-111111111111";
    const groupId = "22222222-2222-4222-8222-222222222222";
    const parentGroupId = "33333333-3333-4333-8333-333333333333";

    await vaultClient.listKeePassGroups(providerId, { includeRecycleBin: true, pageSize: 50, cursor: "next" });
    await vaultClient.createKeePassGroup(providerId, operationId, "Work", parentGroupId);
    await vaultClient.renameKeePassGroup(providerId, operationId, groupId, "Archive");
    await vaultClient.moveKeePassGroup(providerId, operationId, groupId, parentGroupId);
    await vaultClient.deleteKeePassGroup(providerId, operationId, groupId);
    await vaultClient.restoreKeePassGroup(providerId, operationId, groupId, parentGroupId);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "KEEPASS_GROUP_LIST", providerId, includeRecycleBin: true, pageSize: 50, cursor: "next" },
      { type: "KEEPASS_GROUP_CREATE", providerId, operationId, name: "Work", parentGroupId },
      { type: "KEEPASS_GROUP_RENAME", providerId, operationId, groupId, name: "Archive" },
      { type: "KEEPASS_GROUP_MOVE", providerId, operationId, groupId, targetParentGroupId: parentGroupId },
      { type: "KEEPASS_GROUP_DELETE", providerId, operationId, groupId, confirmed: true },
      { type: "KEEPASS_GROUP_RESTORE", providerId, operationId, groupId, targetParentGroupId: parentGroupId }
    ]);
  });

  it("sends KeePass history disclosure and confirmed restore commands", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const providerId = "keepass-1";
    const itemId = "item-1";
    const historyId = "22222222-2222-4222-8222-222222222222";
    const fieldId = "33333333-3333-4333-8333-333333333333";
    const operationId = "11111111-1111-4111-8111-111111111111";

    await vaultClient.listKeePassHistory(providerId, itemId, { pageSize: 25, cursor: "next" });
    await vaultClient.getKeePassHistoryDetail(providerId, itemId, historyId);
    await vaultClient.revealKeePassHistoryField(providerId, itemId, historyId, fieldId);
    await vaultClient.restoreKeePassHistory(providerId, itemId, operationId, historyId);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "KEEPASS_HISTORY_LIST", providerId, itemId, pageSize: 25, cursor: "next" },
      { type: "KEEPASS_HISTORY_DETAIL", providerId, itemId, historyId },
      { type: "KEEPASS_HISTORY_FIELD_REVEAL", providerId, itemId, historyId, fieldId },
      { type: "KEEPASS_HISTORY_RESTORE", providerId, itemId, operationId, historyId, confirmed: true }
    ]);
  });
});
