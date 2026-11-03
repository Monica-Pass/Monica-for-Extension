import { createAttachmentRuntime } from './attachment-runtime';
import { createBitwardenSendRuntime } from './bitwarden-send-runtime';
import { assertManagerPage } from './request-access';
import { createProviderSyncRuntime } from './provider-sync-runtime';
import { type ProviderAccount, type ProviderConflict, type ProviderConflictSummary } from "../core/model";
import { readPasswordProjectRemovalJournal, isPasswordProjectRemovalPending } from '../core/password-project-removal-journal';
import { type MonicaWebDavConfig } from "../providers/webdav/monica-webdav-provider";
import { redactProviderMessage } from "../providers/provider-diagnostics";
import { SecureVaultService, VaultLockedError } from "../security/secure-vault-service";
import type { KeePassRuntime } from './keepass-runtime';
import type { MdbxRuntime } from './mdbx-runtime';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    attachmentRuntime: Pick<ReturnType<typeof createAttachmentRuntime>, "clear">;
    bitwardenSendRuntime: Pick<ReturnType<typeof createBitwardenSendRuntime>, "clear">;
    clearKeePassPendingPersistence: KeePassRuntime["clearKeePassPendingPersistence"];
    keePassProvider: Pick<KeePassRuntime["keePassProvider"], "lockAccount">;
    keePassWorkingCopies: Pick<KeePassRuntime["keePassWorkingCopies"], "delete">;
    mdbx2LocalFileExports: Pick<MdbxRuntime["mdbx2LocalFileExports"], "clear">;
    mdbx2NativeClient: Pick<MdbxRuntime["mdbx2NativeClient"], "lockVault">;
    mdbx2Provider: Pick<MdbxRuntime["mdbx2Provider"], "lockAccount">;
    nearbyOwner: Pick<import("./nearby-owner").NearbyManagerOwner, "close">;
    providerOperations: Pick<import("./provider-operation-queue").ProviderOperationQueue, "run">;
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "activity">;
    providers: Pick<import("../core/provider").ProviderRegistry, "get">;
    runKeePassMutationExclusive: KeePassRuntime["runKeePassMutationExclusive"];
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "exportProviderDiagnostics" | "getProvider" | "listProviderConflicts" | "listProviders" | "readState" | "recordProviderDiagnostic" | "removeProvider" | "resolveProviderConflict" | "upsertProvider">;
}
export type ProviderCommandRuntimeRequest = Extract<ExtensionRequest, {
    type: "PROVIDER_LIST" | "PROVIDER_QUEUE_STATUS" | "PROVIDER_CONFLICT_LIST" | "PROVIDER_CONFLICT_RESOLVE" | "PROVIDER_DIAGNOSTIC_EXPORT" | "WEBDAV_TEST" | "WEBDAV_SAVE" | "PROVIDER_REMOVE";
}>;
export function createProviderCommandRuntime(deps: Dependencies) {
    function effectiveWebDavConfig(config: MonicaWebDavConfig, previous: Record<string, unknown> = {}): MonicaWebDavConfig {
        return {
            ...config,
            password: config.password || (typeof previous.password === "string" ? previous.password : ""),
            backupPassword: config.backupPassword || (typeof previous.backupPassword === "string" ? previous.backupPassword : undefined)
        };
    }
    async function recordProviderDiagnosticIfUnlocked(diagnostic: Parameters<SecureVaultService["recordProviderDiagnostic"]>[0]): Promise<void> {
        try {
            await deps.service.recordProviderDiagnostic(diagnostic);
        }
        catch (error) {
            if (!(error instanceof VaultLockedError))
                throw error;
        }
    }
    function toProviderConflictSummary(conflict: ProviderConflict): ProviderConflictSummary {
        return {
            id: conflict.id,
            providerId: conflict.providerId,
            reason: redactProviderMessage(conflict.reason),
            ...(conflict.local ? { local: { title: conflict.local.title } } : {}),
            ...(conflict.remote ? { remote: { title: conflict.remote.title } } : {}),
            detectedAt: conflict.detectedAt
        };
    }
    const handlers: CommandHandlers<ProviderCommandRuntimeRequest> = {
        "PROVIDER_LIST": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.listProviders();
        },
        "PROVIDER_QUEUE_STATUS": async (request, sender) => {
            assertManagerPage(sender);
            const state = await deps.service.readState();
            const preparationRecoveries = readPasswordProjectRemovalJournal(state.passwordProjectRemovals)
                .filter(record => isPasswordProjectRemovalPending(record) && record.bitwardenPreparationRecovery);
            const providerIds = new Set([
                ...state.providers.map((provider) => provider.id),
                ...state.mutationQueue.map((item) => item.providerId),
                ...state.providerMutationReceipts.map((receipt) => receipt.providerId)
            ]);
            return [...providerIds].map((providerId) => {
                const entries = state.mutationQueue.filter((item) => item.providerId === providerId);
                const receipts = state.providerMutationReceipts.filter((receipt) => receipt.providerId === providerId);
                const lastError = [...entries].reverse().find((item) => item.lastError)?.lastError;
                return {
                    providerId,
                    pending: entries.length,
                    failed: entries.filter((item) => item.lastError).length,
                    recovering: receipts.filter((receipt) => receipt.stage !== "prepared").length
                        + preparationRecoveries.filter(record => record.providerBindings.some(binding => binding.id === providerId)).length,
                    maxAttempts: Math.max(0, ...entries.map((item) => item.attempts), ...receipts.map((receipt) => receipt.attemptCount)),
                    lastError: lastError ? redactProviderMessage(lastError) : undefined
                };
            });
        },
        "PROVIDER_CONFLICT_LIST": async (request, sender) => {
            assertManagerPage(sender);
            return (await deps.service.listProviderConflicts(request.providerId)).map(toProviderConflictSummary);
        },
        "PROVIDER_CONFLICT_RESOLVE": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.resolveProviderConflict(request.conflictId, request.resolution);
        },
        "PROVIDER_DIAGNOSTIC_EXPORT": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.exportProviderDiagnostics();
        },
        "WEBDAV_TEST": async (request, sender) => {
            assertManagerPage(sender);
            const existing = request.providerId ? await deps.service.getProvider(request.providerId) : undefined;
            if (existing && existing.kind !== "monica-webdav")
                throw new Error("所选密码源不是 WebDAV。");
            const temporary: ProviderAccount = {
                id: "webdav-connection-test",
                kind: "monica-webdav",
                name: "WebDAV connection test",
                enabled: true,
                isDefaultSaveTarget: false,
                config: effectiveWebDavConfig(request.config, existing?.config)
            };
            return deps.providers.get("monica-webdav").testConnection(temporary);
        },
        "WEBDAV_SAVE": async (request, sender) => {
            assertManagerPage(sender);
            const existing = request.providerId ? await deps.service.getProvider(request.providerId) : undefined;
            if (existing && existing.kind !== "monica-webdav")
                throw new Error("所选密码源不是 WebDAV。");
            const previousConfig = existing?.config || {};
            const effectiveConfig = effectiveWebDavConfig(request.config, previousConfig);
            const connectionChanged = ["baseUrl", "username", "password", "backupPassword"].some((key) => previousConfig[key] !== effectiveConfig[key]);
            const config = connectionChanged
                ? effectiveConfig
                : { ...effectiveConfig, lastFileName: previousConfig.lastFileName, lastEtag: previousConfig.lastEtag };
            const account: ProviderAccount = {
                id: existing?.id || crypto.randomUUID(),
                kind: "monica-webdav",
                name: request.name.trim() || "Monica Android WebDAV",
                enabled: true,
                isDefaultSaveTarget: Boolean(request.isDefaultSaveTarget),
                config,
                lastSyncAt: connectionChanged ? undefined : existing?.lastSyncAt,
                lastError: undefined
            };
            await deps.providers.get("monica-webdav").testConnection(account);
            return deps.service.upsertProvider(account);
        },
        "PROVIDER_REMOVE": async (request, sender) => {
            assertManagerPage(sender);
            deps.nearbyOwner.close('provider-changed');
            return deps.providerOperations.run(request.providerId, () => deps.runKeePassMutationExclusive(request.providerId, async () => {
                void deps.mdbx2LocalFileExports.clear();
                deps.providerSync.activity.abort(request.providerId, new DOMException("密码源已移除", "AbortError"));
                {
                    const account = await deps.service.getProvider(request.providerId);
                    const vaultHandle = account?.kind === "mdbx2" && typeof account.config.vaultHandle === "string" ? account.config.vaultHandle : undefined;
                    if (vaultHandle)
                        await deps.mdbx2NativeClient.lockVault(vaultHandle).catch(() => undefined);
                }
                deps.mdbx2Provider.lockAccount(request.providerId);
                deps.keePassProvider.lockAccount(request.providerId);
                deps.clearKeePassPendingPersistence(request.providerId);
                deps.attachmentRuntime.clear(request.providerId);
                deps.bitwardenSendRuntime.clear(request.providerId);
                const result = await deps.service.removeProvider(request.providerId);
                await deps.keePassWorkingCopies.delete(request.providerId).catch(() => undefined);
                return result;
            }));
        },
    };
    return { handlers, recordProviderDiagnosticIfUnlocked };
}
export type ProviderCommandRuntime = ReturnType<typeof createProviderCommandRuntime>;
