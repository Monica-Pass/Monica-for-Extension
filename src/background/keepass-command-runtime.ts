import { assertManagerPage } from './request-access';
import { createProviderSyncRuntime } from './provider-sync-runtime';
import { type ProviderAccount } from "../core/model";
import { sameProviderBinding } from "../core/provider";
import { type KeePassSessionSummary } from "../providers/keepass/keepass-provider";
import { KeePassGroupError } from "../providers/keepass/keepass-groups";
import { KeePassHistoryError } from "../providers/keepass/keepass-history";
import { isRemoteKeePassSource, hasLocalKeePassWorkingCopy } from "../providers/keepass/keepass-source";
import { KEEPASS_LOCAL_SOURCE_HASH } from '../providers/keepass/keepass-local-working-copy';
import { createKeePassCacheEncryptionKey, KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG } from '../providers/keepass/keepass-receipt-crypto';
import { base64ToBytes, bytesToBase64 } from "../security/encoding";
import type { KeePassRuntime } from './keepass-runtime';
import type { IdentityFlowRuntime } from './identity-flow-runtime';
import type { LiveViews } from './live-views';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    applyKeePassRemoteAccountConfig: KeePassRuntime["applyKeePassRemoteAccountConfig"];
    clearKeePassPendingPersistence: KeePassRuntime["clearKeePassPendingPersistence"];
    durableKeePassGroupResult: KeePassRuntime["durableKeePassGroupResult"];
    durableKeePassHistoryResult: KeePassRuntime["durableKeePassHistoryResult"];
    ensureKeePassSession: KeePassRuntime["ensureKeePassSession"];
    executeKeePassDurableMutation: KeePassRuntime["executeKeePassDurableMutation"];
    flushKeePassPendingMutations: KeePassRuntime["flushKeePassPendingMutations"];
    keePassDurableSync: Pick<KeePassRuntime["keePassDurableSync"], "synchronize">;
    keePassLocalCopies: Pick<KeePassRuntime["keePassLocalCopies"], "exportFile" | "initialize" | "openPickedFile">;
    keePassProjectRemovals: Pick<KeePassRuntime["keePassProjectRemovals"], "assertProviderReady">;
    keePassProvider: Pick<KeePassRuntime["keePassProvider"], "createGroup" | "deleteGroup" | "exportFile" | "getEntryHistoryDetail" | "isUnlocked" | "listEntryHistory" | "listGroups" | "localSessionGuard" | "lock" | "lockAccount" | "markLocalFileExported" | "moveGroup" | "readEntryHistoryField" | "renameGroup" | "restoreEntryHistory" | "restoreGroup" | "unlock">;
    keePassRecoveryDownloads: Pick<KeePassRuntime["keePassRecoveryDownloads"], "clear">;
    keePassRemoteSessions: Pick<KeePassRuntime["keePassRemoteSessions"], "managerStatus" | "open" | "probe" | "remove">;
    keePassWorkingCopies: Pick<KeePassRuntime["keePassWorkingCopies"], "delete" | "read" | "save">;
    launchOneDriveIdentityFlow: IdentityFlowRuntime["launchOneDriveIdentityFlow"];
    oneDriveConnections: Pick<KeePassRuntime["oneDriveConnections"], "connect">;
    oneDriveSessions: Pick<KeePassRuntime["oneDriveSessions"], "browse" | "cancel" | "login">;
    providerOperations: Pick<import("./provider-operation-queue").ProviderOperationQueue, "run">;
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "pause">;
    publishVaultChanged: LiveViews["publishVaultChanged"];
    replayKeePassGroupResult: KeePassRuntime["replayKeePassGroupResult"];
    replayKeePassHistoryResult: KeePassRuntime["replayKeePassHistoryResult"];
    requireKeePassAccount: KeePassRuntime["requireKeePassAccount"];
    requireKeePassAccountRecord: KeePassRuntime["requireKeePassAccountRecord"];
    requireKeePassHistoryTarget: KeePassRuntime["requireKeePassHistoryTarget"];
    runKeePassMutationExclusive: KeePassRuntime["runKeePassMutationExclusive"];
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "getProvider" | "passkeySessionId" | "readState" | "upsertProvider">;
    waitForKeePassIdle: KeePassRuntime["waitForKeePassIdle"];
}
export type KeePassCommandRuntimeRequest = Extract<ExtensionRequest, {
    type: "ONEDRIVE_LOGIN" | "ONEDRIVE_LOGIN_CANCEL" | "ONEDRIVE_BROWSE" | "KEEPASS_ONEDRIVE_OPEN" | "KEEPASS_WEBDAV_TEST" | "KEEPASS_WEBDAV_OPEN" | "KEEPASS_REMOTE_RESTORE" | "KEEPASS_REMOTE_STATUS" | "KEEPASS_OPEN" | "KEEPASS_STATUS" | "KEEPASS_GROUP_LIST" | "KEEPASS_GROUP_CREATE" | "KEEPASS_GROUP_RENAME" | "KEEPASS_GROUP_MOVE" | "KEEPASS_GROUP_DELETE" | "KEEPASS_GROUP_RESTORE" | "KEEPASS_HISTORY_LIST" | "KEEPASS_HISTORY_DETAIL" | "KEEPASS_HISTORY_FIELD_REVEAL" | "KEEPASS_HISTORY_RESTORE" | "KEEPASS_EXPORT_FILE" | "KEEPASS_LOCK";
}>;
export function createKeePassCommandRuntime(deps: Dependencies) {
    const handlers: CommandHandlers<KeePassCommandRuntimeRequest> = {
        "ONEDRIVE_LOGIN": async (request, sender) => {
            assertManagerPage(sender);
            return deps.oneDriveSessions.login(request.loginId, chrome.identity.getRedirectURL("onedrive"), deps.launchOneDriveIdentityFlow, request.clientId);
        },
        "ONEDRIVE_LOGIN_CANCEL": async (request, sender) => {
            assertManagerPage(sender);
            deps.oneDriveSessions.cancel(request.loginId);
            return undefined;
        },
        "ONEDRIVE_BROWSE": async (request, sender) => {
            assertManagerPage(sender);
            return deps.oneDriveSessions.browse(request.input);
        },
        "KEEPASS_ONEDRIVE_OPEN": async (request, sender) => {
            assertManagerPage(sender);
            const input = { ...request.input };
            request.input.databasePassword = "";
            request.input.keyFile = undefined;
            // Shared ordering with manual/automatic sync, then attachment/group writes.
            const queueId = input.providerId || input.loginId || "onedrive-new-connection";
            return deps.providerOperations.run(queueId, () => deps.runKeePassMutationExclusive(queueId, () => deps.oneDriveConnections.connect(input)));
        },
        "KEEPASS_WEBDAV_TEST": async (request, sender) => {
            assertManagerPage(sender);
            const input = { ...request.input };
            const existing = input.providerId ? await deps.service.getProvider(input.providerId) : undefined;
            if (existing && existing.kind !== "keepass")
                throw new Error("所选密码源不是 KeePass 数据库。");
            if (existing?.config.sourceMode === "onedrive")
                throw new Error("请在 OneDrive 设置中重新连接原数据库；连接其他来源请新增密码源。");
            if (!input.webDavPassword && existing?.config.sourceMode === "webdav" && typeof existing.config.webDavPassword === "string") {
                input.webDavPassword = existing.config.webDavPassword;
            }
            request.input.webDavPassword = "";
            try {
                return await deps.keePassRemoteSessions.probe(input);
            }
            finally {
                input.webDavPassword = "";
            }
        },
        "KEEPASS_WEBDAV_OPEN": async (request, sender) => {
            assertManagerPage(sender);
            const existing = request.input.providerId ? await deps.service.getProvider(request.input.providerId) : undefined;
            if (existing && existing.kind !== "keepass")
                throw new Error("所选密码源不是 KeePass 数据库。");
            if (existing?.config.sourceMode === "onedrive")
                throw new Error("请在 OneDrive 设置中重新连接原数据库；连接其他来源请新增密码源。");
            if (existing && hasLocalKeePassWorkingCopy(existing.config))
                throw new Error("此密码源保留了本地文件的修改。连接 WebDAV 请新增密码源。");
            const input = { ...request.input };
            if (existing?.config.sourceMode === "webdav") {
                if (!input.webDavPassword && typeof existing.config.webDavPassword === "string")
                    input.webDavPassword = existing.config.webDavPassword;
                if (!input.databasePassword && typeof existing.config.databasePassword === "string")
                    input.databasePassword = existing.config.databasePassword;
                if (input.keyFile === undefined && typeof existing.config.keyFile === "string")
                    input.keyFile = existing.config.keyFile;
            }
            request.input.webDavPassword = "";
            request.input.databasePassword = "";
            request.input.keyFile = undefined;
            const account: ProviderAccount = {
                id: existing?.id || crypto.randomUUID(),
                kind: "keepass",
                name: input.name.trim() || "KeePass WebDAV",
                enabled: true,
                isDefaultSaveTarget: Boolean(input.isDefaultSaveTarget),
                config: {
                    databaseId: Number.isSafeInteger(Number(existing?.config.databaseId)) && Number(existing?.config.databaseId) > 0
                        ? Number(existing?.config.databaseId)
                        : Date.now(),
                    ...(typeof existing?.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG] === "string"
                        ? { [KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]: existing.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG] }
                        : {})
                },
                lastSyncAt: existing?.lastSyncAt,
                lastError: undefined
            };
            return deps.providerOperations.run(account.id, () => deps.runKeePassMutationExclusive(account.id, async () => {
                const previousWorkingCopy = await deps.keePassWorkingCopies.read(account.id);
                try {
                    const opened = await deps.keePassRemoteSessions.open(account, input);
                    let persisted: ProviderAccount;
                    try {
                        persisted = await deps.service.upsertProvider({ ...account, config: opened.accountConfig });
                    }
                    catch (cause) {
                        const currentWorkingCopy = await deps.keePassWorkingCopies.read(account.id).catch(() => undefined);
                        try {
                            if (previousWorkingCopy && currentWorkingCopy) {
                                await deps.keePassWorkingCopies.save(previousWorkingCopy, currentWorkingCopy.revision).catch(() => undefined);
                            }
                            else if (!previousWorkingCopy) {
                                await deps.keePassWorkingCopies.delete(account.id).catch(() => undefined);
                            }
                        }
                        finally {
                            currentWorkingCopy?.baseBytes.fill(0);
                            currentWorkingCopy?.workingBytes.fill(0);
                        }
                        deps.keePassProvider.lockAccount(account.id);
                        throw cause;
                    }
                    return { account: persisted, session: opened.session };
                }
                catch (cause) {
                    if (!existing)
                        await deps.keePassRemoteSessions.remove(account.id).catch(() => undefined);
                    throw cause;
                }
                finally {
                    input.webDavPassword = "";
                    input.databasePassword = "";
                    input.keyFile = undefined;
                    previousWorkingCopy?.baseBytes.fill(0);
                    previousWorkingCopy?.workingBytes.fill(0);
                }
            }));
        },
        "KEEPASS_REMOTE_RESTORE": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireKeePassAccountRecord(request.providerId);
            await deps.providerSync.pause([account.id], false);
            return deps.providerOperations.run(account.id, () => deps.runKeePassMutationExclusive(account.id, () => deps.ensureKeePassSession(account, true), true));
        },
        "KEEPASS_REMOTE_STATUS": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireKeePassAccountRecord(request.providerId);
            return deps.keePassRemoteSessions.managerStatus(account);
        },
        "KEEPASS_OPEN": async (request, sender) => {
            assertManagerPage(sender);
            let existing = request.input.providerId ? await deps.service.getProvider(request.input.providerId) : undefined;
            if (existing && existing.kind !== "keepass")
                throw new Error("所选密码源不是 KeePass 数据库。");
            if (existing && isRemoteKeePassSource(existing.config.sourceMode))
                throw new Error("请在原远端设置中重新连接数据库；打开本地文件请新增密码源。");
            const input = { ...request.input };
            request.input.password = "";
            request.input.keyFile = undefined;
            request.input.file = "";
            const account: ProviderAccount = {
                id: existing?.id || crypto.randomUUID(),
                kind: "keepass",
                name: input.name.trim() || input.fileName || "KeePass 数据库",
                enabled: true,
                isDefaultSaveTarget: Boolean(input.isDefaultSaveTarget),
                config: {
                    databaseId: Number.isSafeInteger(Number(existing?.config.databaseId)) && Number(existing?.config.databaseId) > 0
                        ? Number(existing?.config.databaseId)
                        : Date.now(),
                    sourceMode: "local-file",
                    fileName: input.fileName,
                    protectionMode: input.keyFile
                        ? input.password ? "password-and-key-file" : "key-file"
                        : input.password ? "password" : "empty"
                },
                lastSyncAt: existing?.lastSyncAt,
                lastError: undefined
            };
            let fileBytes: Uint8Array | undefined;
            let keyFileBytes: Uint8Array | undefined;
            let openedSessionGuard: (() => void) | undefined;
            return deps.providerOperations.run(account.id, () => deps.runKeePassMutationExclusive(account.id, async () => {
                const vaultSession = await deps.service.passkeySessionId();
                try {
                    if (!vaultSession)
                        throw new Error("密码库已锁定，请重新解锁。");
                    const pendingMove = (await deps.service.readState(false)).bitwardenBatchTransfers?.some(batch => batch.status === 'writing'
                        && batch.keepassMoves?.some(group => group.account.id === account.id));
                    if (existing) {
                        const latest = await deps.service.getProvider(account.id);
                        if (!latest || !sameProviderBinding(existing, latest))
                            throw new Error("密码源已变化，请重新打开。");
                        existing = latest;
                        if (pendingMove)
                            Object.assign(account.config, existing.config);
                        // Reopen must not discard a native mutation whose checkpoint failed.
                        if (!pendingMove && hasLocalKeePassWorkingCopy(existing.config) && deps.keePassProvider.isUnlocked(account.id))
                            await deps.flushKeePassPendingMutations(existing);
                    }
                    fileBytes = base64ToBytes(input.file);
                    keyFileBytes = input.keyFile ? base64ToBytes(input.keyFile) : undefined;
                    // Unlocking first means a wrong credential never leaves a half-configured password source behind.
                    const credential = {
                        password: input.password,
                        keyFile: keyFileBytes,
                        sourceName: input.fileName,
                        sourceMode: "local-file" as const
                    };
                    let session: KeePassSessionSummary;
                    if (existing && hasLocalKeePassWorkingCopy(existing.config)) {
                        Object.assign(account.config, { [KEEPASS_LOCAL_SOURCE_HASH]: existing.config[KEEPASS_LOCAL_SOURCE_HASH],
                            [KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG]: existing.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG],
                            workingSha256: existing.config.workingSha256,
                            localFileExportSha256: existing.config.localFileExportSha256 });
                        session = await deps.keePassLocalCopies.openPickedFile(account, fileBytes, credential);
                        openedSessionGuard = deps.keePassProvider.localSessionGuard(account);
                    }
                    else {
                        session = await deps.keePassProvider.unlock(account, fileBytes, credential);
                        openedSessionGuard = deps.keePassProvider.localSessionGuard(account);
                        account.config[KEEPASS_LOCAL_SOURCE_HASH] = [...new Uint8Array(await crypto.subtle.digest('SHA-256', fileBytes.slice().buffer))]
                            .map(value => value.toString(16).padStart(2, '0')).join('');
                        account.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG] = createKeePassCacheEncryptionKey();
                        await deps.keePassLocalCopies.initialize(account, fileBytes);
                    }
                    if (vaultSession !== await deps.service.passkeySessionId())
                        throw new Error("密码库已锁定，请重新解锁。");
                    const persisted = await deps.service.upsertProvider(account, true, existing, { sessionId: vaultSession });
                    return { account: persisted, session };
                }
                catch (cause) {
                    // Only invalidate this open attempt, never a newer session after a vault lock.
                    if (openedSessionGuard) {
                        try {
                            openedSessionGuard();
                            deps.keePassProvider.lockAccount(account.id);
                        }
                        catch { /* already replaced or locked */ }
                    }
                    throw cause;
                }
                finally {
                    input.password = "";
                    input.keyFile = undefined;
                    input.file = "";
                    fileBytes?.fill(0);
                    keyFileBytes?.fill(0);
                }
            }, true));
        },
        "KEEPASS_STATUS": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireKeePassAccountRecord(request.providerId);
            return deps.ensureKeePassSession(account, false);
        },
        "KEEPASS_GROUP_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireKeePassAccount(request.providerId);
            return deps.keePassProvider.listGroups(account, request);
        },
        "KEEPASS_GROUP_CREATE": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireKeePassAccount(request.providerId);
            return deps.executeKeePassDurableMutation({
                account,
                operationId: request.operationId,
                kind: "group-create",
                intent: { name: request.name, parentGroupId: request.parentGroupId },
                replay: (result) => deps.replayKeePassGroupResult(account, result),
                mutate: () => {
                    const result = deps.keePassProvider.createGroup(account, request.operationId, request.name, request.parentGroupId);
                    return { result, durableResult: deps.durableKeePassGroupResult(account, result) };
                }
            });
        },
        "KEEPASS_GROUP_RENAME": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireKeePassAccount(request.providerId);
            return deps.executeKeePassDurableMutation({
                account,
                operationId: request.operationId,
                kind: "group-rename",
                intent: { groupId: request.groupId, name: request.name },
                replay: (result) => deps.replayKeePassGroupResult(account, result),
                mutate: () => {
                    const result = deps.keePassProvider.renameGroup(account, request.operationId, request.groupId, request.name);
                    return { result, durableResult: deps.durableKeePassGroupResult(account, result) };
                }
            });
        },
        "KEEPASS_GROUP_MOVE": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireKeePassAccount(request.providerId);
            return deps.executeKeePassDurableMutation({
                account,
                operationId: request.operationId,
                kind: "group-move",
                intent: { groupId: request.groupId, targetParentGroupId: request.targetParentGroupId },
                replay: (result) => deps.replayKeePassGroupResult(account, result),
                mutate: () => {
                    const result = deps.keePassProvider.moveGroup(account, request.operationId, request.groupId, request.targetParentGroupId);
                    return { result, durableResult: deps.durableKeePassGroupResult(account, result) };
                }
            });
        },
        "KEEPASS_GROUP_DELETE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new KeePassGroupError("keepass-group-delete-confirmation-required", "删除 KeePass 分组需要明确确认。");
            const account = await deps.requireKeePassAccount(request.providerId);
            return deps.executeKeePassDurableMutation({
                account,
                operationId: request.operationId,
                kind: "group-delete",
                intent: { groupId: request.groupId },
                replay: (result) => deps.replayKeePassGroupResult(account, result),
                mutate: () => {
                    const result = deps.keePassProvider.deleteGroup(account, request.operationId, request.groupId);
                    return { result, durableResult: deps.durableKeePassGroupResult(account, result) };
                }
            });
        },
        "KEEPASS_GROUP_RESTORE": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireKeePassAccount(request.providerId);
            return deps.executeKeePassDurableMutation({
                account,
                operationId: request.operationId,
                kind: "group-restore",
                intent: { groupId: request.groupId, targetParentGroupId: request.targetParentGroupId },
                replay: (result) => deps.replayKeePassGroupResult(account, result),
                mutate: () => {
                    const result = deps.keePassProvider.restoreGroup(account, request.operationId, request.groupId, request.targetParentGroupId);
                    return { result, durableResult: deps.durableKeePassGroupResult(account, result) };
                }
            });
        },
        "KEEPASS_HISTORY_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const { account, item } = await deps.requireKeePassHistoryTarget(request.providerId, request.itemId);
            return deps.keePassProvider.listEntryHistory(account, item, request);
        },
        "KEEPASS_HISTORY_DETAIL": async (request, sender) => {
            assertManagerPage(sender);
            const { account, item } = await deps.requireKeePassHistoryTarget(request.providerId, request.itemId);
            return deps.keePassProvider.getEntryHistoryDetail(account, item, request.historyId);
        },
        "KEEPASS_HISTORY_FIELD_REVEAL": async (request, sender) => {
            assertManagerPage(sender);
            const { account, item } = await deps.requireKeePassHistoryTarget(request.providerId, request.itemId);
            return deps.keePassProvider.readEntryHistoryField(account, item, request.historyId, request.fieldId);
        },
        "KEEPASS_HISTORY_RESTORE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true) {
                throw new KeePassHistoryError("keepass-history-restore-confirmation-required", "恢复 KeePass 历史版本需要明确确认。");
            }
            const { account, item } = await deps.requireKeePassHistoryTarget(request.providerId, request.itemId);
            return deps.executeKeePassDurableMutation({
                account,
                operationId: request.operationId,
                kind: "history-restore",
                intent: { itemId: request.itemId, historyId: request.historyId },
                replay: deps.replayKeePassHistoryResult,
                mutate: () => {
                    const result = deps.keePassProvider.restoreEntryHistory(account, item, request.operationId, request.historyId);
                    return { result, durableResult: deps.durableKeePassHistoryResult(result) };
                }
            });
        },
        "KEEPASS_EXPORT_FILE": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireKeePassAccount(request.providerId);
            const fileName = typeof account.config.fileName === "string" && account.config.fileName ? account.config.fileName : "monica.kdbx";
            if (hasLocalKeePassWorkingCopy(account.config)) {
                return deps.runKeePassMutationExclusive(account.id, async () => {
                    await deps.keePassProjectRemovals.assertProviderReady(account.id);
                    await deps.flushKeePassPendingMutations(account);
                    await deps.keePassDurableSync.synchronize(account);
                    const state = await deps.service.readState(false);
                    if (state.mutationQueue.some(row => row.providerId === account.id) || state.providerConflicts.some(row => row.providerId === account.id))
                        throw new Error("请先同步所有待写入修改并处理冲突，再导出 KeePass 数据库。");
                    const exported = await deps.keePassLocalCopies.exportFile(account);
                    try {
                        await deps.applyKeePassRemoteAccountConfig(account, exported.accountConfig);
                        deps.keePassProvider.markLocalFileExported(account);
                        return { fileName, file: bytesToBase64(exported.bytes) };
                    }
                    finally {
                        exported.bytes.fill(0);
                    }
                });
            }
            return { fileName, file: bytesToBase64(await deps.keePassProvider.exportFile(account.id)) };
        },
        "KEEPASS_LOCK": async (request, sender) => {
            assertManagerPage(sender);
            deps.keePassRecoveryDownloads.clear();
            const ids = request.providerId ? [request.providerId] : (await deps.service.readState(false)).providers.filter(account => account.kind === "keepass").map(account => account.id);
            for (const id of ids)
                await deps.runKeePassMutationExclusive(id, async () => {
                    const account = await deps.service.getProvider(id);
                    if (account && hasLocalKeePassWorkingCopy(account.config) && deps.keePassProvider.isUnlocked(id))
                        await deps.flushKeePassPendingMutations(account);
                });
            await deps.providerSync.pause(ids, true);
            await deps.waitForKeePassIdle(ids);
            if (request.providerId) {
                deps.keePassProvider.lockAccount(request.providerId);
                deps.clearKeePassPendingPersistence(request.providerId);
            }
            else {
                deps.keePassProvider.lock();
                deps.clearKeePassPendingPersistence();
            }
            deps.publishVaultChanged();
            return undefined;
        },
    };
    return { handlers };
}
export type KeePassCommandRuntime = ReturnType<typeof createKeePassCommandRuntime>;
