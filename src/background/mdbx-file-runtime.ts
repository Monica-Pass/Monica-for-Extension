import { assertManagerPage } from './request-access';
import { createProviderSyncRuntime } from './provider-sync-runtime';
import { type ProviderAccount } from "../core/model";
import { Mdbx2NativeHostError } from "../providers/mdbx2/native-contract";
import { cancelMdbxImport, commitMdbxImport, detectMdbxImport, prepareMdbxImport, recoverMdbxImports } from "../providers/mdbx2/mdbx-import-coordinator";
import { VaultLockedError } from "../security/secure-vault-service";
import type { MdbxRuntime } from './mdbx-runtime';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    mdbx2ExportOwner: MdbxRuntime["mdbx2ExportOwner"];
    mdbx2ImportStore: MdbxRuntime["mdbx2ImportStore"];
    mdbx2LocalFileExports: Pick<MdbxRuntime["mdbx2LocalFileExports"], "begin" | "clear" | "read" | "release">;
    mdbx2NativeClient: MdbxRuntime["mdbx2NativeClient"];
    mdbx2Provider: Pick<MdbxRuntime["mdbx2Provider"], "lockAccount">;
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "pause" | "synchronize">;
    requireMdbx2VaultHandle: MdbxRuntime["requireMdbx2VaultHandle"];
    service: import("../security/secure-vault-service").SecureVaultService;
}
export type MdbxFileRuntimeRequest = Extract<ExtensionRequest, {
    type: "MDBX2_HOST_STATUS" | "MDBX2_FILE_EXPORT_BEGIN" | "MDBX2_FILE_EXPORT_READ" | "MDBX2_FILE_EXPORT_RELEASE" | "MDBX2_FILE_RELEASE" | "MDBX2_VAULT_INSPECT" | "MDBX2_IMPORT_DETECT" | "MDBX2_IMPORT_PREPARE" | "MDBX2_IMPORT_COMMIT" | "MDBX2_IMPORT_CANCEL" | "MDBX2_IMPORT_RECOVER" | "MDBX2_VAULT_OPEN" | "MDBX2_VAULT_CREATE" | "MDBX2_VAULT_STATUS" | "MDBX2_VAULT_DIAGNOSTICS" | "MDBX2_HEALTH_REPAIR_PLAN" | "MDBX2_HEALTH_REPAIR_APPLY" | "MDBX2_VAULT_TIGA" | "MDBX2_VAULT_LOCK";
}>;
export function createMdbxFileRuntime(deps: Dependencies) {
    const handlers: CommandHandlers<MdbxFileRuntimeRequest> = {
        "MDBX2_HOST_STATUS": async (request, sender) => {
            assertManagerPage(sender);
            const handle = request.providerId ? await deps.requireMdbx2VaultHandle(request.providerId) : undefined;
            const status = await deps.mdbx2NativeClient.status(15000, handle);
            return { ...status, runtimeBackend: handle ? await deps.mdbx2NativeClient.backendForVault(handle) : 'browser' };
        },
        "MDBX2_FILE_EXPORT_BEGIN": async (request, sender) => {
            assertManagerPage(sender);
            return deps.mdbx2LocalFileExports.begin(request.providerId, deps.mdbx2ExportOwner(sender));
        },
        "MDBX2_FILE_EXPORT_READ": async (request, sender) => {
            assertManagerPage(sender);
            return deps.mdbx2LocalFileExports.read(request.providerId, deps.mdbx2ExportOwner(sender), request.downloadHandle, request.offset);
        },
        "MDBX2_FILE_EXPORT_RELEASE": async (request, sender) => {
            assertManagerPage(sender);
            return deps.mdbx2LocalFileExports.release(request.providerId, deps.mdbx2ExportOwner(sender), request.downloadHandle);
        },
        "MDBX2_FILE_RELEASE": async (request, sender) => {
            assertManagerPage(sender);
            return deps.mdbx2NativeClient.releaseFile(request.fileHandle);
        },
        "MDBX2_VAULT_INSPECT": async (request, sender) => {
            assertManagerPage(sender);
            return deps.mdbx2NativeClient.inspectVault(request.source);
        },
        "MDBX2_IMPORT_DETECT": async (request, sender) => {
            assertManagerPage(sender);
            return detectMdbxImport(deps.mdbx2NativeClient, request.source, request.kind);
        },
        "MDBX2_IMPORT_PREPARE": async (request, sender) => {
            assertManagerPage(sender);
            return prepareMdbxImport(deps.mdbx2ImportStore, deps.mdbx2NativeClient, request);
        },
        "MDBX2_IMPORT_COMMIT": async (request, sender) => {
            assertManagerPage(sender);
            return commitMdbxImport(deps.mdbx2ImportStore, deps.mdbx2NativeClient, deps.service, (providerId) => deps.providerSync.synchronize(providerId), request);
        },
        "MDBX2_IMPORT_CANCEL": async (request, sender) => {
            assertManagerPage(sender);
            return cancelMdbxImport(deps.mdbx2ImportStore, deps.mdbx2NativeClient, request.operationId, deps.service);
        },
        "MDBX2_IMPORT_RECOVER": async (request, sender) => {
            assertManagerPage(sender);
            return recoverMdbxImports(deps.mdbx2ImportStore, deps.mdbx2NativeClient, deps.service);
        },
        "MDBX2_VAULT_OPEN": async (request, sender) => {
            assertManagerPage(sender);
            const sessionId = await deps.service.passkeySessionId();
            if (!sessionId)
                throw new VaultLockedError();
            const existing = request.input.providerId ? await deps.service.getProvider(request.input.providerId) : undefined;
            if (existing && existing.kind !== "mdbx2")
                throw new Error("所选密码源不是 MDBX2 保险库。");
            const existingHandle = typeof existing?.config.vaultHandle === "string" ? existing.config.vaultHandle : undefined;
            if (existing && (request.input.source.kind !== "vault" || request.input.source.handle !== existingHandle)) {
                throw new Error("已有 MDBX2 密码源只能重新打开其本机工作副本。");
            }
            const session = await deps.mdbx2NativeClient.openVault(request.input.source, request.input.credential);
            const account: ProviderAccount = {
                id: existing?.id || crypto.randomUUID(),
                kind: "mdbx2",
                name: request.input.name.trim() || "Monica MDBX2",
                enabled: true,
                isDefaultSaveTarget: Boolean(request.input.isDefaultSaveTarget),
                config: {
                    ...existing?.config,
                    ...(!existing ? { runtimeBackend: await deps.mdbx2NativeClient.backendForVault(session.vaultHandle) } : {}),
                    mdbxGeneration: 2,
                    formatVersion: "MDBX-2",
                    vaultHandle: session.vaultHandle,
                    nativeVaultId: session.vaultId,
                    schemaVersion: session.schemaVersion,
                    hostVerifiedAt: new Date().toISOString()
                },
                lastSyncAt: existing?.lastSyncAt,
                lastError: undefined
            };
            try {
                return { account: await deps.service.upsertProvider(account, true, existing, { sessionId }), session };
            }
            catch (error) {
                await deps.mdbx2NativeClient.lockVault(session.vaultHandle).catch(() => undefined);
                throw error;
            }
        },
        "MDBX2_VAULT_CREATE": async (request, sender) => {
            assertManagerPage(sender);
            const sessionId = await deps.service.passkeySessionId();
            if (!sessionId)
                throw new VaultLockedError();
            const name = request.input.name.trim();
            if (!name || name.length > 200)
                throw new Error('请填写不超过 200 个字符的数据库名称。');
            const session = await deps.mdbx2NativeClient.createVault(request.input.password);
            try {
                const account: ProviderAccount = { id: crypto.randomUUID(), kind: 'mdbx2', name, enabled: true,
                    isDefaultSaveTarget: request.input.isDefaultSaveTarget === true,
                    config: { runtimeBackend: 'browser', mdbxGeneration: 2, formatVersion: 'MDBX-2', vaultHandle: session.vaultHandle,
                        nativeVaultId: session.vaultId, schemaVersion: session.schemaVersion, hostVerifiedAt: new Date().toISOString() } };
                return { account: await deps.service.upsertProvider(account, true, undefined, { sessionId }), session };
            }
            catch (error) {
                await deps.mdbx2NativeClient.lockVault(session.vaultHandle).catch(() => undefined);
                throw error;
            }
        },
        "MDBX2_VAULT_STATUS": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.service.getProvider(request.providerId);
            if (!account || account.kind !== "mdbx2")
                throw new Error("MDBX2 密码源不存在。");
            const vaultHandle = typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : "";
            return deps.mdbx2NativeClient.vaultStatus(vaultHandle);
        },
        "MDBX2_VAULT_DIAGNOSTICS": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.vaultDiagnostics(vaultHandle);
        },
        "MDBX2_HEALTH_REPAIR_PLAN": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.planHealthRepair(vaultHandle);
        },
        "MDBX2_HEALTH_REPAIR_APPLY": async (request, sender) => {
            assertManagerPage(sender);
            if (!Array.isArray(request.decisions)) {
                throw new Mdbx2NativeHostError("params-invalid", "MDBX2 健康修复选择无效。", false);
            }
            const hasDeleteChoice = request.decisions.some((decision) => (decision as {
                choice?: unknown;
            } | null)?.choice === "delete-object");
            if (hasDeleteChoice && request.confirmedDelete !== true) {
                throw new Mdbx2NativeHostError("health-repair-delete-confirmation-required", "删除冲突项目需要再次明确确认。", false);
            }
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.applyHealthRepair(vaultHandle, request.planHandle, request.operationId, request.decisions);
        },
        "MDBX2_VAULT_TIGA": async (request, sender) => {
            assertManagerPage(sender);
            const vaultHandle = await deps.requireMdbx2VaultHandle(request.providerId);
            return deps.mdbx2NativeClient.vaultTiga(vaultHandle);
        },
        "MDBX2_VAULT_LOCK": async (request, sender) => {
            assertManagerPage(sender);
            void deps.mdbx2LocalFileExports.clear();
            const account = await deps.service.getProvider(request.providerId);
            if (!account || account.kind !== "mdbx2")
                throw new Error("MDBX2 密码源不存在。");
            await deps.providerSync.pause([request.providerId], true);
            const vaultHandle = typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : "";
            try {
                return await deps.mdbx2NativeClient.lockVault(vaultHandle);
            }
            finally {
                deps.mdbx2Provider.lockAccount(request.providerId);
            }
        },
    };
    return { handlers };
}
export type MdbxFileRuntime = ReturnType<typeof createMdbxFileRuntime>;
