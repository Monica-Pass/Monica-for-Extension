import { afterEach, describe, expect, it, vi } from "vitest";
import { vaultClient } from "./client";
import type { Mdbx2HealthRepairDecision } from "./messages";

describe("extension runtime client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps archive, recycle-bin, restore, and empty-vault confirmation manager messages explicit", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await vaultClient.listArchivedItems();
    await vaultClient.listDeletedItems();
    await vaultClient.restoreItem("item-1");
    await vaultClient.syncProvider("provider-1", true);
    await vaultClient.syncAllBitwarden();

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "VAULT_LIST_ARCHIVED_ITEMS" },
      { type: "VAULT_LIST_DELETED_ITEMS" },
      { type: "VAULT_RESTORE_ITEM", itemId: "item-1" },
      { type: "PROVIDER_SYNC", providerId: "provider-1", allowEmptyRemote: true },
      { type: "BITWARDEN_SYNC_ALL" }
    ]);
  });

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

  it("sends MDBX2 batch planning and execution with a reusable operation identity", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const input = {
      operationId: "11111111-1111-4111-8111-111111111111",
      operationCreatedAt: "2026-08-06T12:00:00.000Z",
      itemIds: ["item-1", "item-2"],
      targetProviderId: "mdbx-target",
      targetCollectionId: "22222222-2222-4222-8222-222222222222",
      preserveCategories: true,
      action: "move" as const
    };

    await vaultClient.planMdbx2BatchTransfer(input);
    await vaultClient.executeMdbx2BatchTransfer(input, true);
    await vaultClient.mdbx2BatchTransferStatus(input.operationId);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "MDBX2_BATCH_TRANSFER_PLAN", input },
      { type: "MDBX2_BATCH_TRANSFER_EXECUTE", input, confirmed: true },
      { type: "MDBX2_BATCH_TRANSFER_STATUS", operationId: input.operationId }
    ]);
  });

  it("sends MDBX2 diagnostics refresh through the typed manager contract", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await vaultClient.mdbx2VaultDiagnostics("provider-1");

    expect(sendMessage).toHaveBeenCalledWith({ type: "MDBX2_VAULT_DIAGNOSTICS", providerId: "provider-1" });
  });

  it("sends MDBX2 health repair planning and confirmed destructive choices through the manager contract", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const providerId = "provider-1";
    const planHandle = "11111111-1111-4111-8111-111111111111";
    const operationId = "22222222-2222-4222-8222-222222222222";
    const keepDecision = {
      itemHandle: "33333333-3333-4333-8333-333333333333",
      choice: "keep-content" as const
    };
    const deleteDecision = {
      itemHandle: "44444444-4444-4444-8444-444444444444",
      choice: "delete-object" as const
    };

    await vaultClient.planMdbx2HealthRepair(providerId);
    await vaultClient.applyMdbx2HealthRepair(providerId, planHandle, operationId, [keepDecision]);
    await vaultClient.applyMdbx2HealthRepair(providerId, planHandle, operationId, [deleteDecision], true);

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "MDBX2_HEALTH_REPAIR_PLAN", providerId },
      {
        type: "MDBX2_HEALTH_REPAIR_APPLY",
        providerId,
        planHandle,
        operationId,
        decisions: [keepDecision]
      },
      {
        type: "MDBX2_HEALTH_REPAIR_APPLY",
        providerId,
        planHandle,
        operationId,
        decisions: [deleteDecision],
        confirmedDelete: true
      }
    ]);
  });

  it("preserves the health repair unknown-outcome code for fail-closed recovery", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      ok: false,
      error: "无法证明健康修复是否已提交。",
      code: "health-repair-outcome-unknown"
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await expect(vaultClient.applyMdbx2HealthRepair(
      "provider-1",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      []
    )).rejects.toMatchObject({
      name: "ExtensionRuntimeError",
      code: "health-repair-outcome-unknown"
    });
  });

  it("copies reactive health repair decisions into clone-safe message data", async () => {
    const decision = new Proxy({
      itemHandle: "33333333-3333-4333-8333-333333333333",
      choice: "keep-content" as const
    }, {});
    const decisions = new Proxy([decision], {});
    const sendMessage = vi.fn().mockImplementation(async (message: unknown) => {
      structuredClone(message);
      return { ok: true, data: {} };
    });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    await vaultClient.applyMdbx2HealthRepair(
      "provider-1",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      decisions
    );

    const message = sendMessage.mock.calls[0]?.[0] as { decisions: Mdbx2HealthRepairDecision[] };
    expect(message.decisions).toEqual([{ itemHandle: decision.itemHandle, choice: decision.choice }]);
    expect(message.decisions).not.toBe(decisions);
    expect(message.decisions[0]).not.toBe(decision);
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
    const operationId = "44444444-4444-4444-8444-444444444444";

    await vaultClient.listProviderAttachments(providerId, itemId, { pageSize: 20, cursor: "next" });
    await vaultClient.beginProviderAttachmentRead(providerId, itemId, attachmentId);
    await vaultClient.readProviderAttachmentChunk(providerId, readHandle, 0, 1024);
    await vaultClient.releaseProviderAttachmentRead(providerId, readHandle);
    await vaultClient.beginProviderAttachmentUpload(providerId, itemId, { fileName: "a.txt", mediaType: "text/plain", sizeBytes: 2, sha256: "a".repeat(64), replaceExisting: true });
    await vaultClient.sendProviderAttachmentChunk(providerId, transferId, 0, new Uint8Array([1, 2]));
    await vaultClient.finishProviderAttachmentUpload(providerId, itemId, transferId, operationId);
    await vaultClient.abortProviderAttachmentUpload(providerId, transferId);
    await vaultClient.deleteProviderAttachment(providerId, itemId, attachmentId, operationId);
    await vaultClient.transferProviderAttachment({
      operationId,
      sourceProviderId: providerId,
      sourceItemId: itemId,
      sourceAttachmentId: attachmentId,
      targetProviderId: "mdbx2-2",
      targetItemId: itemId,
      mode: "move",
      confirmedMove: true
    });

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "PROVIDER_ATTACHMENT_LIST", providerId, itemId, pageSize: 20, cursor: "next" },
      { type: "PROVIDER_ATTACHMENT_READ_BEGIN", providerId, itemId, attachmentId },
      { type: "PROVIDER_ATTACHMENT_READ_CHUNK", providerId, readHandle, offset: 0, maxBytes: 1024 },
      { type: "PROVIDER_ATTACHMENT_READ_RELEASE", providerId, readHandle },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_BEGIN", providerId, itemId, fileName: "a.txt", mediaType: "text/plain", sizeBytes: 2, sha256: "a".repeat(64), replaceExisting: true },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_CHUNK", providerId, transferId, offset: 0, dataBase64: "AQI=" },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_FINISH", providerId, itemId, transferId, operationId },
      { type: "PROVIDER_ATTACHMENT_UPLOAD_ABORT", providerId, transferId },
      { type: "PROVIDER_ATTACHMENT_DELETE", providerId, itemId, attachmentId, operationId, confirmed: true },
      { type: "PROVIDER_ATTACHMENT_TRANSFER", operationId, sourceProviderId: providerId, sourceItemId: itemId, sourceAttachmentId: attachmentId, targetProviderId: "mdbx2-2", targetItemId: itemId, mode: "move", confirmedMove: true }
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

  it("sends manager KeePass WebDAV probe open and restore commands", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, data: {} });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const connection = {
      baseUrl: "https://dav.example.test/files/demo",
      username: "demo",
      webDavPassword: "webdav secret",
      remotePath: "vaults/main.kdbx"
    };

    await vaultClient.testKeePassWebDav(connection);
    await vaultClient.openKeePassWebDav({
      ...connection,
      providerId: "keepass-remote",
      name: "Remote KeePass",
      databasePassword: "database secret",
      keyFile: "a2V5"
    });
    await vaultClient.restoreKeePassRemote("keepass-remote");

    expect(sendMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "KEEPASS_WEBDAV_TEST", input: connection },
      {
        type: "KEEPASS_WEBDAV_OPEN",
        input: {
          ...connection,
          providerId: "keepass-remote",
          name: "Remote KeePass",
          databasePassword: "database secret",
          keyFile: "a2V5"
        }
      },
      { type: "KEEPASS_REMOTE_RESTORE", providerId: "keepass-remote" }
    ]);
  });
});
