import { assertManagerPage } from './request-access';
import { readBitwardenSession } from './bitwarden-session-config';
import { type ProviderAccount, type VaultItem } from "../core/model";
import { BitwardenBatchTransferCoordinator } from '../providers/bitwarden/bitwarden-batch-coordinator';
import { KeePassBitwardenMove } from '../providers/keepass/keepass-bitwarden-move';
import { BitwardenBatchFoldersRemote } from '../providers/bitwarden/bitwarden-batch-folders';
import { BitwardenTransferRemote } from '../providers/bitwarden/bitwarden-transfer-remote';
import { readBitwardenBatchResource } from '../providers/bitwarden/bitwarden-batch-resource';
import { readMdbxBitwardenSource } from '../providers/bitwarden/bitwarden-mdbx-source';
import { MdbxBitwardenMembers } from '../providers/bitwarden/bitwarden-mdbx-members';
import { readKeePassBitwardenSource } from '../providers/bitwarden/bitwarden-keepass-source';
import { BitwardenWebDavSources } from '../providers/bitwarden/bitwarden-webdav-source';
import { sameProviderBinding } from "../core/provider";
import { LocalTransferCoordinator } from '../providers/attachments/local-transfer-coordinator';
import { readLocalTransferResource } from '../providers/attachments/local-transfer-resource';
import { KeePassTransferCoordinator } from '../providers/keepass/keepass-transfer-coordinator';
import { readKeePassTransferResource } from '../providers/keepass/keepass-transfer-resource';
import { localTransferFolders } from '../core/local-transfer';
import { listMdbx2TransferCollections } from '../providers/mdbx2/mdbx2-transfer-collections';
import { BitwardenTransferAttachmentSource } from '../providers/bitwarden/bitwarden-transfer-attachments';
import { readMdbx2TransferBinding } from '../providers/mdbx2/mdbx2-transfer-verification';
import { prepareMdbx2TransferSourceDeletion, deleteMdbx2TransferSources } from '../providers/mdbx2/mdbx2-transfer-source-delete';
import { Mdbx2BatchTransferCoordinator, type Mdbx2BatchTransferProgress, type Mdbx2BatchTransferStatus } from "../providers/mdbx2/mdbx2-batch-transfer-coordinator";
import { assertMdbx2TransferOperationId } from "../providers/mdbx2/mdbx2-transfer-identity";
import { Mdbx2TransferAttachmentService } from "../providers/mdbx2/mdbx2-transfer-attachments";
import { hasLocalKeePassWorkingCopy } from "../providers/keepass/keepass-source";
import { base64ToBytes } from "../security/encoding";
import type { MdbxRuntime } from './mdbx-runtime';
import type { BitwardenRuntime } from './bitwarden-runtime';
import type { KeePassRuntime } from './keepass-runtime';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    MDBX2_MAX_BASE64_CHUNK_LENGTH: MdbxRuntime["MDBX2_MAX_BASE64_CHUNK_LENGTH"];
    bitwardenAttachmentDownloads: BitwardenRuntime["bitwardenAttachmentDownloads"];
    bitwardenAttachmentMutations: BitwardenRuntime["bitwardenAttachmentMutations"];
    bitwardenClient: BitwardenRuntime["bitwardenClient"];
    bitwardenProvider: import("../providers/bitwarden/bitwarden-provider").BitwardenProvider;
    bitwardenTransferAttachmentSource: Pick<BitwardenRuntime["bitwardenTransferAttachmentSource"], "list" | "read">;
    clearBitwardenOrganizationKeys: BitwardenRuntime["clearBitwardenOrganizationKeys"];
    ensureKeePassSession: KeePassRuntime["ensureKeePassSession"];
    keePassLocalCopies: Pick<KeePassRuntime["keePassLocalCopies"], "publishWorkingCopy" | "reload">;
    keePassPersistenceFor: KeePassRuntime["keePassPersistenceFor"];
    keePassProvider: KeePassRuntime["keePassProvider"];
    keePassRemoteSessions: Pick<KeePassRuntime["keePassRemoteSessions"], "publishWorkingCopy" | "restore">;
    keePassWorkingCopies: KeePassRuntime["keePassWorkingCopies"];
    loadBitwardenTransferAttachmentContext: BitwardenRuntime["loadBitwardenTransferAttachmentContext"];
    localAttachments: import("../providers/attachments/local-attachments").LocalAttachmentService;
    mdbx2NativeClient: MdbxRuntime["mdbx2NativeClient"];
    mdbx2Provider: MdbxRuntime["mdbx2Provider"];
    monicaWebDavProvider: import("../providers/webdav/monica-webdav-provider").MonicaWebDavProvider;
    providerOperations: Pick<import("./provider-operation-queue").ProviderOperationQueue, "run" | "runMany">;
    providers: import("../core/provider").ProviderRegistry;
    runKeePassMutationExclusive: KeePassRuntime["runKeePassMutationExclusive"];
    service: import("../security/secure-vault-service").SecureVaultService;
    stringAccountConfig: MdbxRuntime["stringAccountConfig"];
}
export type TransferRuntimeRequest = Extract<ExtensionRequest, {
    type: "MDBX2_TRANSFER_BEGIN" | "MDBX2_TRANSFER_CHUNK" | "MDBX2_TRANSFER_FINISH" | "MDBX2_TRANSFER_ABORT" | "LOCAL_TRANSFER_FOLDERS" | "MDBX2_BATCH_TRANSFER_PLAN" | "BITWARDEN_PENDING_TRANSFERS" | "BITWARDEN_CANCEL_UNWRITTEN_TRANSFER" | "BITWARDEN_KEEP_BOTH_TRANSFER" | "KEEPASS_PENDING_TRANSFERS" | "KEEPASS_CANCEL_UNWRITTEN_TRANSFER" | "MDBX2_PENDING_MOVES" | "MDBX2_BATCH_TRANSFER_EXECUTE" | "MDBX2_BATCH_TRANSFER_STATUS";
}>;
export function createTransferRuntime(deps: Dependencies) {
    const mdbx2TransferAttachmentService = new Mdbx2TransferAttachmentService(deps.mdbx2NativeClient, deps.keePassProvider, {
        list: (account, item) => deps.bitwardenTransferAttachmentSource.list(account, item),
        read: (account, item, attachment) => deps.bitwardenTransferAttachmentSource.read(account, item, attachment)
    }, deps.localAttachments, {
        list: async (account, item) => (await deps.monicaWebDavProvider.listAttachments(account, item)).items,
        read: async (account, item, attachment) => (await deps.monicaWebDavProvider.readAttachment(account, item, attachment.attachmentId)).bytes
    });
    const localTransfers = new LocalTransferCoordinator(deps.service, (state, item) => readLocalTransferResource(state, item, {
        files: mdbx2TransferAttachmentService,
        prepare: async (account) => {
            if (account.kind === 'keepass')
                await deps.ensureKeePassSession(account, true);
            if (account.kind === 'mdbx2')
                return listMdbx2TransferCollections(deps.mdbx2NativeClient, deps.stringAccountConfig(account, 'vaultHandle'), true);
            return undefined;
        }
    }));
    const mdbx2BatchTransferCoordinator = new Mdbx2BatchTransferCoordinator(deps.service, deps.providers, deps.mdbx2Provider, deps.mdbx2NativeClient, mdbx2TransferAttachmentService);
    const keePassTransfers = new KeePassTransferCoordinator(deps.service, deps.keePassProvider, deps.keePassWorkingCopies, {
        ensure: account => deps.ensureKeePassSession(account, true),
        persistence: deps.keePassPersistenceFor,
        reload: async (account) => {
            await deps.ensureKeePassSession(account, true);
            if (hasLocalKeePassWorkingCopy(account.config))
                await deps.keePassLocalCopies.reload(account);
            else
                await deps.keePassRemoteSessions.restore(account);
        },
        publish: async (account, signal) => {
            const result = await deps.keePassPersistenceFor(account).publishWorkingCopy(account, signal);
            if (!result)
                throw new Error('KeePass 工作副本无法发布。');
            return result.accountConfig;
        },
        resource: (state, item, preserveCategories) => readKeePassTransferResource(state, item, preserveCategories, {
            provider: deps.keePassProvider, files: mdbx2TransferAttachmentService,
            prepare: async (account) => {
                if (account.kind === 'keepass')
                    await deps.ensureKeePassSession(account, true);
                if (account.kind === 'mdbx2')
                    return listMdbx2TransferCollections(deps.mdbx2NativeClient, deps.stringAccountConfig(account, 'vaultHandle'), true);
                return undefined;
            }
        }),
        exclusive: (providerId, work) => deps.providerOperations.run(providerId, () => deps.runKeePassMutationExclusive(providerId, work))
    });
    const mdbxBitwardenMembers = new MdbxBitwardenMembers();
    const bitwardenWebDavSources = new BitwardenWebDavSources(deps.monicaWebDavProvider);
    const bitwardenBatchTransfers = new BitwardenBatchTransferCoordinator(deps.service, deps.bitwardenProvider, {
        keepass: new KeePassBitwardenMove(deps.keePassProvider, deps.keePassWorkingCopies, {
            ensure: account => deps.ensureKeePassSession(account, true),
            persistence: deps.keePassPersistenceFor,
            reload: async (account) => {
                if (hasLocalKeePassWorkingCopy(account.config))
                    await deps.keePassLocalCopies.reload(account);
                else
                    await deps.keePassRemoteSessions.restore(account);
            },
            publish: (account, signal) => hasLocalKeePassWorkingCopy(account.config)
                ? deps.keePassLocalCopies.publishWorkingCopy(account, signal) : deps.keePassRemoteSessions.publishWorkingCopy(account, signal, false)
        }),
        mdbx: {
            verify: async (state, account, items) => {
                const sessionId = await deps.service.passkeySessionId();
                if (!sessionId)
                    throw new Error('密码库已锁定。');
                const binding = await readMdbx2TransferBinding(deps.mdbx2NativeClient, account);
                const revision = await deps.mdbx2NativeClient.readWriteRevision(binding.vaultHandle);
                if (revision.vaultId !== binding.vaultId)
                    throw new Error('MDBX 来源身份已变化。');
                const collections = await listMdbx2TransferCollections(deps.mdbx2NativeClient, binding.vaultHandle, false);
                await mdbxBitwardenMembers.verifyMove(state, account, items, deps.mdbx2NativeClient, collections, revision);
                const after = await deps.mdbx2NativeClient.readWriteRevision(binding.vaultHandle), current = await deps.service.getProvider(account.id);
                if (after.vaultId !== revision.vaultId || after.revisionSha256 !== revision.revisionSha256
                    || !current?.enabled || !sameProviderBinding(current, account) || await deps.service.passkeySessionId() !== sessionId)
                    throw new Error('核验期间 MDBX 来源或解锁会话已变化。');
                return binding;
            },
            prepare: (group, targetId, verify) => prepareMdbx2TransferSourceDeletion(deps.mdbx2NativeClient, group.account, group.sources, group.id, targetId, group.vaultId, verify),
            remove: (account, sources, operationId, targetId, intent) => deleteMdbx2TransferSources(deps.mdbx2NativeClient, account, sources, operationId, targetId, intent)
        },
        exclusiveMany: (ids, work) => deps.providerOperations.runMany(ids, async () => {
            const state = await deps.service.readState(false);
            const keepass = ids.filter(id => state.providers.some(account => account.id === id && account.kind === 'keepass'));
            let run = work;
            for (const id of keepass.slice().reverse()) {
                const next = run;
                run = () => deps.runKeePassMutationExclusive(id, next, true);
            }
            return run();
        }),
        resource: async (state, items, preserveCategories) => {
            const sessionId = await deps.service.passkeySessionId();
            if (!sessionId)
                throw new Error('密码库已锁定。');
            let previous: ProviderAccount | undefined;
            const context = async (account: ProviderAccount, item: VaultItem) => {
                previous = await deps.service.getProvider(account.id);
                if (!previous?.enabled || !sameProviderBinding(account, previous))
                    throw new Error('Bitwarden 来源连接已变化。');
                const result = await deps.loadBitwardenTransferAttachmentContext(previous, item);
                try {
                    previous = await deps.service.saveBitwardenTransferSession(previous, result.session, sessionId);
                    return result;
                }
                catch (error) {
                    deps.clearBitwardenOrganizationKeys(result.organizationKeys);
                    throw error;
                }
            };
            const files = new BitwardenTransferAttachmentSource(deps.bitwardenAttachmentDownloads, context, async (_account, session) => {
                if (!previous)
                    throw new Error('Bitwarden 来源会话不存在。');
                previous = await deps.service.saveBitwardenTransferSession(previous, session, sessionId);
            });
            return readBitwardenBatchResource(state, items, preserveCategories, { context,
                portableSource: (account, item, preserveCategories) => {
                    if (account.kind === 'monica-webdav')
                        return bitwardenWebDavSources.read(state, account, item, preserveCategories, async () => {
                            const current = await deps.service.getProvider(account.id);
                            if (!current?.enabled || !sameProviderBinding(account, current) || await deps.service.passkeySessionId() !== sessionId)
                                throw new Error('读取期间 WebDAV 来源连接或解锁会话已变化。');
                        });
                    if (account.kind === 'keepass')
                        return readKeePassBitwardenSource(state, account, item, preserveCategories, {
                            provider: deps.keePassProvider, files: mdbx2TransferAttachmentService,
                            prepare: async () => { await deps.ensureKeePassSession(account, true); },
                            assertCurrent: async () => {
                                const current = await deps.service.getProvider(account.id);
                                if (!current?.enabled || !sameProviderBinding(account, current) || await deps.service.passkeySessionId() !== sessionId)
                                    throw new Error('读取期间 KeePass 来源连接或解锁会话已变化。');
                            }
                        });
                    if (account.kind !== 'mdbx2')
                        throw new Error('此来源的原生扩展字段与历史尚不能完整转入 Bitwarden，请保留原库。');
                    return readMdbxBitwardenSource(state, account, item, preserveCategories, {
                        native: deps.mdbx2NativeClient, files: mdbx2TransferAttachmentService, members: mdbxBitwardenMembers,
                        collections: account => listMdbx2TransferCollections(deps.mdbx2NativeClient, deps.stringAccountConfig(account, 'vaultHandle'), false),
                        assertCurrent: async () => {
                            const current = await deps.service.getProvider(account.id);
                            if (!current?.enabled || !sameProviderBinding(account, current) || current.config.vaultHandle !== account.config.vaultHandle
                                || await deps.service.passkeySessionId() !== sessionId)
                                throw new Error('读取期间来源连接或解锁会话已变化。');
                        }
                    });
                },
                files: async (state, item) => (await readLocalTransferResource(state, item, { prepare: async () => undefined,
                    files: { listSourceAttachments: (account, row) => files.list(account, row), readSourceAttachment: (account, row, file) => files.read(account, row, file) }
                })).attachments });
        },
        folders: async (account, signal) => {
            const sessionId = await deps.service.passkeySessionId();
            if (!sessionId)
                throw new Error('密码库已锁定。');
            const result = await deps.bitwardenClient.sync(readBitwardenSession(account), signal);
            await deps.service.saveBitwardenTransferSession(account, result.session, sessionId);
            if (result.payload.folders !== undefined && result.payload.Folders !== undefined)
                throw new Error('Bitwarden 文件夹清单有歧义。');
            return result.payload.folders ?? result.payload.Folders;
        },
        folderRemote: (copyId, store) => new BitwardenBatchFoldersRemote(copyId, store.copies, deps.bitwardenClient),
        remote: (copyId, store) => new BitwardenTransferRemote(copyId, store.copies, deps.bitwardenClient, deps.bitwardenAttachmentDownloads, deps.bitwardenAttachmentMutations),
        exclusive: (providerId, work) => deps.providerOperations.run(providerId, work)
    });
    const MDBX2_BATCH_TRANSFER_STATUS_TTL_MS = 10 * 60000;
    const mdbx2BatchTransferStatuses = new Map<string, Mdbx2BatchTransferStatus>();
    function recordMdbx2BatchTransferProgress(progress: Mdbx2BatchTransferProgress): void {
        mdbx2BatchTransferStatuses.set(progress.operationId, {
            ...progress,
            finished: progress.phase === "completed" || progress.phase === "failed",
            updatedAt: new Date().toISOString()
        });
        pruneMdbx2BatchTransferStatuses();
    }
    function pruneMdbx2BatchTransferStatuses(now = Date.now()): void {
        for (const [operationId, status] of mdbx2BatchTransferStatuses) {
            const updatedAt = Date.parse(status.updatedAt);
            if (!Number.isFinite(updatedAt) || now - updatedAt > MDBX2_BATCH_TRANSFER_STATUS_TTL_MS) {
                mdbx2BatchTransferStatuses.delete(operationId);
            }
        }
    }
    function clearTransferSessions(): void { localTransfers.clear(); keePassTransfers.clear(); bitwardenBatchTransfers.clear(); }
    function clearTransferStatuses(): void { mdbx2BatchTransferStatuses.clear(); }
    const handlers: CommandHandlers<TransferRuntimeRequest> = {
        "MDBX2_TRANSFER_BEGIN": async (request, sender) => {
            assertManagerPage(sender);
            return deps.mdbx2NativeClient.beginInboundTransfer(request.sizeBytes, request.sha256);
        },
        "MDBX2_TRANSFER_CHUNK": async (request, sender) => {
            assertManagerPage(sender);
            if (typeof request.dataBase64 !== "string" || request.dataBase64.length > deps.MDBX2_MAX_BASE64_CHUNK_LENGTH)
                throw new Error("MDBX2 文件分块超出允许范围。");
            return deps.mdbx2NativeClient.sendInboundChunk(request.transferId, request.offset, base64ToBytes(request.dataBase64));
        },
        "MDBX2_TRANSFER_FINISH": async (request, sender) => {
            assertManagerPage(sender);
            return deps.mdbx2NativeClient.finishInboundTransfer(request.transferId);
        },
        "MDBX2_TRANSFER_ABORT": async (request, sender) => {
            assertManagerPage(sender);
            return deps.mdbx2NativeClient.abortInboundTransfer(request.transferId);
        },
        "LOCAL_TRANSFER_FOLDERS": async (request, sender) => {
            assertManagerPage(sender);
            return localTransferFolders(await deps.service.readState(false));
        },
        "MDBX2_BATCH_TRANSFER_PLAN": async (request, sender) => {
            assertManagerPage(sender);
            return (await deps.service.getProvider(request.input.targetProviderId))?.kind === 'local'
                ? localTransfers.plan(request.input) : (await deps.service.getProvider(request.input.targetProviderId))?.kind === 'keepass'
                ? keePassTransfers.plan(request.input) : (await deps.service.getProvider(request.input.targetProviderId))?.kind === 'bitwarden'
                ? bitwardenBatchTransfers.plan(request.input) : mdbx2BatchTransferCoordinator.plan(request.input);
        },
        "BITWARDEN_PENDING_TRANSFERS": async (request, sender) => {
            assertManagerPage(sender);
            return bitwardenBatchTransfers.pending(request.providerId);
        },
        "BITWARDEN_CANCEL_UNWRITTEN_TRANSFER": async (request, sender) => {
            assertManagerPage(sender);
            return bitwardenBatchTransfers.cancel(request.providerId, request.operationId);
        },
        "BITWARDEN_KEEP_BOTH_TRANSFER": async (request, sender) => {
            assertManagerPage(sender);
            return bitwardenBatchTransfers.keepBoth(request.providerId, request.operationId, request.confirmed);
        },
        "KEEPASS_PENDING_TRANSFERS": async (request, sender) => {
            assertManagerPage(sender);
            return keePassTransfers.pending(request.providerId);
        },
        "KEEPASS_CANCEL_UNWRITTEN_TRANSFER": async (request, sender) => {
            assertManagerPage(sender);
            return keePassTransfers.cancel(request.providerId, request.operationId);
        },
        "MDBX2_PENDING_MOVES": async (request, sender) => {
            assertManagerPage(sender);
            return mdbx2BatchTransferCoordinator.pendingMoves();
        },
        "MDBX2_BATCH_TRANSFER_EXECUTE": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            pruneMdbx2BatchTransferStatuses();
            const operationId = assertMdbx2TransferOperationId(request.input.operationId || crypto.randomUUID());
            const input = { ...request.input, operationId, confirmed: request.confirmed === true };
            recordMdbx2BatchTransferProgress({
                operationId,
                phase: "preparing",
                processed: 0,
                total: new Set(request.input.itemIds).size,
                completedCount: 0,
                blockedCount: 0,
                failedCount: 0
            });
            try {
                const target = await deps.service.getProvider(input.targetProviderId);
                if (nativeWriteLocked && target?.kind !== 'mdbx2')
                    throw new Error('等待传输期间目标类型已变化，请重新预览。');
                return target?.kind === 'local'
                    ? await localTransfers.execute(input, recordMdbx2BatchTransferProgress)
                    : target?.kind === 'keepass'
                        ? await keePassTransfers.execute(input, recordMdbx2BatchTransferProgress)
                        : target?.kind === 'bitwarden'
                            ? await bitwardenBatchTransfers.execute(input, recordMdbx2BatchTransferProgress)
                            : await mdbx2BatchTransferCoordinator.execute(input, recordMdbx2BatchTransferProgress);
            }
            catch (error) {
                const current = mdbx2BatchTransferStatuses.get(operationId);
                recordMdbx2BatchTransferProgress({
                    operationId,
                    phase: "failed",
                    processed: current?.processed || 0,
                    total: current?.total || new Set(request.input.itemIds).size,
                    completedCount: current?.completedCount || 0,
                    blockedCount: current?.blockedCount || 0,
                    failedCount: Math.max(current?.failedCount || 0, 1)
                });
                throw error;
            }
        },
        "MDBX2_BATCH_TRANSFER_STATUS": async (request, sender) => {
            assertManagerPage(sender);
            pruneMdbx2BatchTransferStatuses();
            return mdbx2BatchTransferStatuses.get(assertMdbx2TransferOperationId(request.operationId));
        },
    };
    return { clearTransferSessions, clearTransferStatuses, handlers };
}
export type TransferRuntime = ReturnType<typeof createTransferRuntime>;
