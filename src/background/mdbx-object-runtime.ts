import { assertManagerPage } from './request-access';
import type { MdbxRuntime } from './mdbx-runtime';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    mdbx2NativeClient: Pick<MdbxRuntime["mdbx2NativeClient"], "createCollection" | "createSnapshot" | "deleteCollection" | "deleteObject" | "deleteSnapshot" | "listCollections" | "listCommitDiff" | "listCommitHistory" | "listConflicts" | "listObjects" | "listSnapshotStructure" | "listSnapshots" | "moveCollection" | "planAutomaticSnapshotPrune" | "pruneAutomaticSnapshots" | "renameCollection" | "resolveConflict" | "restoreCollection" | "restoreSnapshot" | "revealObject" | "revertCommit" | "upsertObject">;
    requireMdbx2VaultHandle: MdbxRuntime["requireMdbx2VaultHandle"];
}
export type MdbxObjectRuntimeRequest = Extract<ExtensionRequest, {
    type: "MDBX2_COLLECTION_LIST" | "MDBX2_COLLECTION_CREATE" | "MDBX2_COLLECTION_RENAME" | "MDBX2_COLLECTION_MOVE" | "MDBX2_COLLECTION_DELETE" | "MDBX2_COLLECTION_RESTORE" | "MDBX2_OBJECT_LIST" | "MDBX2_OBJECT_REVEAL" | "MDBX2_OBJECT_UPSERT" | "MDBX2_OBJECT_DELETE" | "MDBX2_HISTORY_LIST" | "MDBX2_HISTORY_DIFF" | "MDBX2_HISTORY_REVERT" | "MDBX2_SNAPSHOT_LIST" | "MDBX2_SNAPSHOT_STRUCTURE" | "MDBX2_SNAPSHOT_PRUNE_PLAN" | "MDBX2_SNAPSHOT_PRUNE_EXECUTE" | "MDBX2_SNAPSHOT_CREATE" | "MDBX2_SNAPSHOT_DELETE" | "MDBX2_SNAPSHOT_RESTORE" | "MDBX2_CONFLICT_LIST" | "MDBX2_CONFLICT_RESOLVE";
}>;
export function createMdbxObjectRuntime(deps: Dependencies) {
    const handlers: CommandHandlers<MdbxObjectRuntimeRequest> = {
        "MDBX2_COLLECTION_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.listCollections(vaultHandle, request);
        },
        "MDBX2_COLLECTION_CREATE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.createCollection(vaultHandle, request.operationId, request.collectionId, request.title, request.parentCollectionId);
        },
        "MDBX2_COLLECTION_RENAME": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.renameCollection(vaultHandle, request.operationId, request.collectionId, request.title);
        },
        "MDBX2_COLLECTION_MOVE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.moveCollection(vaultHandle, request.operationId, request.collectionId, request.parentCollectionId);
        },
        "MDBX2_COLLECTION_DELETE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new Error("删除 MDBX2 文件夹需要明确确认。");
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.deleteCollection(vaultHandle, request.operationId, request.collectionId);
        },
        "MDBX2_COLLECTION_RESTORE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.restoreCollection(vaultHandle, request.operationId, request.collectionId, request.parentCollectionId);
        },
        "MDBX2_OBJECT_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.listObjects(vaultHandle, request.collectionId, request);
        },
        "MDBX2_OBJECT_REVEAL": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.revealObject(vaultHandle, request.objectId);
        },
        "MDBX2_OBJECT_UPSERT": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.upsertObject(vaultHandle, request.operationId, request.input);
        },
        "MDBX2_OBJECT_DELETE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.deleteObject(vaultHandle, request.operationId, request.logicalObjectId, request.expectedHeadCommitId);
        },
        "MDBX2_HISTORY_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.listCommitHistory(vaultHandle, request);
        },
        "MDBX2_HISTORY_DIFF": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.listCommitDiff(vaultHandle, request.commitId);
        },
        "MDBX2_HISTORY_REVERT": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.revertCommit(vaultHandle, request.operationId, request.commitId);
        },
        "MDBX2_SNAPSHOT_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.listSnapshots(vaultHandle, request);
        },
        "MDBX2_SNAPSHOT_STRUCTURE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.listSnapshotStructure(vaultHandle, request.snapshotId, request.side, request);
        },
        "MDBX2_SNAPSHOT_PRUNE_PLAN": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.planAutomaticSnapshotPrune(vaultHandle, request.keepLatest);
        },
        "MDBX2_SNAPSHOT_PRUNE_EXECUTE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.pruneAutomaticSnapshots(vaultHandle, request.planToken, request.keepLatest);
        },
        "MDBX2_SNAPSHOT_CREATE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.createSnapshot(vaultHandle, request.operationId, request.name);
        },
        "MDBX2_SNAPSHOT_DELETE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.deleteSnapshot(vaultHandle, request.operationId, request.snapshotId);
        },
        "MDBX2_SNAPSHOT_RESTORE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.restoreSnapshot(vaultHandle, request.operationId, request.snapshotId);
        },
        "MDBX2_CONFLICT_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.listConflicts(vaultHandle, request);
        },
        "MDBX2_CONFLICT_RESOLVE": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.resolveConflict(vaultHandle, request.operationId, request.conflictId, request.choice);
        },
    };
    return { handlers };
}
export type MdbxObjectRuntime = ReturnType<typeof createMdbxObjectRuntime>;
