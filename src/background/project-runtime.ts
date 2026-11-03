import { assertManagerPage } from './request-access';
import { type VaultItem } from "../core/model";
import { PasswordProjectRestoreWorkflow } from './password-project-restore';
import { Mdbx2PasswordProjectRemovalCoordinator } from '../providers/mdbx2/mdbx2-project-removal';
import { PasswordProjectRemovalWorkflow } from './password-project-removal';
import { BitwardenPasswordProjectRemovalCoordinator } from '../providers/bitwarden/bitwarden-project-removal';
import { BitwardenProjectRemovalRuntime } from './bitwarden-project-removal-runtime';
import type { BitwardenRuntime } from './bitwarden-runtime';
import type { KeePassRuntime } from './keepass-runtime';
import type { MdbxRuntime } from './mdbx-runtime';
import type { LiveViews } from './live-views';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    bitwardenAttachmentDownloads: BitwardenRuntime["bitwardenAttachmentDownloads"];
    bitwardenAttachmentMutations: BitwardenRuntime["bitwardenAttachmentMutations"];
    bitwardenClient: BitwardenRuntime["bitwardenClient"];
    bitwardenProvider: import("../providers/bitwarden/bitwarden-provider").BitwardenProvider;
    keePassProjectRemovals: Pick<KeePassRuntime["keePassProjectRemovals"], "cancel" | "pending" | "resume" | "sourceToken" | "stageFromManager" | "recoverProvider">;
    keePassProjectResolutions: Pick<KeePassRuntime["keePassProjectResolutions"], "cancel" | "deleteRecoveryCopy" | "exportRecoveryCopy" | "pending" | "recoveryCopies" | "resolve" | "resume" | "review" | "recoverProvider">;
    keePassRecoveryDownloads: Pick<KeePassRuntime["keePassRecoveryDownloads"], "begin" | "cancel" | "read" | "release" | "status">;
    mdbx2ExportOwner: MdbxRuntime["mdbx2ExportOwner"];
    mdbx2NativeClient: MdbxRuntime["mdbx2NativeClient"];
    mdbx2RestoreBatches: MdbxRuntime["mdbx2RestoreBatches"];
    mdbx2Restores: MdbxRuntime["mdbx2Restores"];
    providerOperations: import("./provider-operation-queue").ProviderOperationQueue;
    publishVaultChanged: LiveViews["publishVaultChanged"];
    service: import("../security/secure-vault-service").SecureVaultService;
    syncActivity: import("./provider-sync-activity").ProviderSyncActivity;
}
export type ProjectRuntimeRequest = Extract<ExtensionRequest, {
    type: "VAULT_PASSWORD_PROJECT_RESTORE" | "VAULT_PASSWORD_PROJECT_RESTORES" | "VAULT_PASSWORD_PROJECT_RESTORE_RESUME" | "VAULT_PASSWORD_PROJECT_REMOVE" | "VAULT_PASSWORD_PROJECT_REMOVALS" | "VAULT_PASSWORD_PROJECT_REMOVAL_RESUME" | "VAULT_PASSWORD_PROJECT_REMOVAL_CANCEL" | "VAULT_KEEPASS_PROJECT_SOURCE_TOKEN" | "VAULT_KEEPASS_PROJECT_REMOVE" | "VAULT_KEEPASS_PROJECT_REMOVALS" | "VAULT_KEEPASS_PROJECT_REMOVAL_RESUME" | "VAULT_KEEPASS_PROJECT_REMOVAL_CANCEL" | "VAULT_KEEPASS_PROJECT_CONFLICT_REVIEW" | "VAULT_KEEPASS_PROJECT_RESOLVE" | "VAULT_KEEPASS_PROJECT_RESOLUTIONS" | "VAULT_KEEPASS_PROJECT_RESOLUTION_RESUME" | "VAULT_KEEPASS_PROJECT_RESOLUTION_CANCEL" | "VAULT_KEEPASS_PROJECT_RECOVERY_LIST" | "VAULT_KEEPASS_PROJECT_RECOVERY_DELETE" | "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_BEGIN" | "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_STATUS" | "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_CANCEL" | "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_READ" | "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_RELEASE";
}>;
export function createProjectRuntime(deps: Dependencies) {
    const passwordProjectRestores = new PasswordProjectRestoreWorkflow(deps.service, deps.mdbx2RestoreBatches, deps.providerOperations, () => deps.publishVaultChanged());
    const passwordProjectRemovals = new PasswordProjectRemovalWorkflow(deps.service, new Mdbx2PasswordProjectRemovalCoordinator(deps.mdbx2NativeClient, deps.service), deps.mdbx2Restores, deps.providerOperations, () => deps.publishVaultChanged(), new BitwardenProjectRemovalRuntime(deps.service, new BitwardenPasswordProjectRemovalCoordinator(deps.service, deps.bitwardenClient, deps.bitwardenProvider, deps.bitwardenAttachmentDownloads, deps.bitwardenAttachmentMutations), deps.syncActivity, providerId => deps.bitwardenProvider.lockAccount(providerId)));
    async function restoreVaultItem(itemId: string): Promise<VaultItem> {
        const state = await deps.service.readState();
        const source = state.items.find(row => row.id === itemId);
        const providerId = source?.providerRefs.find(ref => state.providers.some(account => account.id === ref.providerId && account.kind === 'mdbx2'))?.providerId;
        if (!providerId)
            return deps.mdbx2Restores.restore(itemId);
        return deps.providerOperations.run(providerId, () => deps.mdbx2Restores.restore(itemId));
    }
    const handlers: CommandHandlers<ProjectRuntimeRequest> = {
        "VAULT_PASSWORD_PROJECT_RESTORE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new Error('请先确认整组恢复的范围。');
            return passwordProjectRestores.start(request.input);
        },
        "VAULT_PASSWORD_PROJECT_RESTORES": async (request, sender) => {
            assertManagerPage(sender);
            return passwordProjectRestores.pending(request.operationId);
        },
        "VAULT_PASSWORD_PROJECT_RESTORE_RESUME": async (request, sender) => {
            assertManagerPage(sender);
            return passwordProjectRestores.resume(request.operationId);
        },
        "VAULT_PASSWORD_PROJECT_REMOVE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new Error('请先确认移除的密码成员。');
            return passwordProjectRemovals.stage(request.input);
        },
        "VAULT_PASSWORD_PROJECT_REMOVALS": async (request, sender) => {
            assertManagerPage(sender);
            return passwordProjectRemovals.pending(request.operationId);
        },
        "VAULT_PASSWORD_PROJECT_REMOVAL_RESUME": async (request, sender) => {
            assertManagerPage(sender);
            return passwordProjectRemovals.resume(request.operationId);
        },
        "VAULT_PASSWORD_PROJECT_REMOVAL_CANCEL": async (request, sender) => {
            assertManagerPage(sender);
            return passwordProjectRemovals.cancel(request.operationId);
        },
        "VAULT_KEEPASS_PROJECT_SOURCE_TOKEN": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassProjectRemovals.sourceToken(request.providerId);
        },
        "VAULT_KEEPASS_PROJECT_REMOVE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new Error('请先确认移除的密码成员。');
            return deps.keePassProjectRemovals.stageFromManager(request.input);
        },
        "VAULT_KEEPASS_PROJECT_REMOVALS": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassProjectRemovals.pending(request.operationId);
        },
        "VAULT_KEEPASS_PROJECT_REMOVAL_RESUME": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassProjectRemovals.resume(request.operationId);
        },
        "VAULT_KEEPASS_PROJECT_REMOVAL_CANCEL": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassProjectRemovals.cancel(request.operationId);
        },
        "VAULT_KEEPASS_PROJECT_CONFLICT_REVIEW": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassProjectResolutions.review(request.providerId);
        },
        "VAULT_KEEPASS_PROJECT_RESOLVE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new Error('请先确认各项目保留的版本。');
            return deps.keePassProjectResolutions.resolve(request.providerId, request.input);
        },
        "VAULT_KEEPASS_PROJECT_RESOLUTIONS": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassProjectResolutions.pending(request.operationId);
        },
        "VAULT_KEEPASS_PROJECT_RESOLUTION_RESUME": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassProjectResolutions.resume(request.operationId);
        },
        "VAULT_KEEPASS_PROJECT_RESOLUTION_CANCEL": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassProjectResolutions.cancel(request.operationId);
        },
        "VAULT_KEEPASS_PROJECT_RECOVERY_LIST": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassProjectResolutions.recoveryCopies(request.providerId);
        },
        "VAULT_KEEPASS_PROJECT_RECOVERY_DELETE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new Error('请先确认删除所选恢复副本。');
            return deps.keePassProjectResolutions.deleteRecoveryCopy(request.providerId, request.operationId, request.expectedIntentTag);
        },
        "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_BEGIN": async (request, sender) => {
            assertManagerPage(sender);
            if (typeof request.requestId !== 'string')
                throw new Error('恢复副本下载请求无效。');
            return deps.keePassRecoveryDownloads.begin(request.providerId, deps.mdbx2ExportOwner(sender), () => deps.keePassProjectResolutions.exportRecoveryCopy(request.providerId, request.operationId, request.expectedIntentTag, request.exportPassword), request.requestId);
        },
        "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_STATUS": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassRecoveryDownloads.status(request.providerId, deps.mdbx2ExportOwner(sender), request.requestId);
        },
        "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_CANCEL": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassRecoveryDownloads.cancel(request.providerId, deps.mdbx2ExportOwner(sender), request.requestId);
        },
        "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_READ": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassRecoveryDownloads.read(request.providerId, deps.mdbx2ExportOwner(sender), request.downloadHandle, request.offset);
        },
        "VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_RELEASE": async (request, sender) => {
            assertManagerPage(sender);
            return deps.keePassRecoveryDownloads.release(request.providerId, deps.mdbx2ExportOwner(sender), request.downloadHandle);
        },
    };
    async function recoverProviderBeforeSync(account: import('../core/model').ProviderAccount, signal: AbortSignal): Promise<import('../core/model').ProviderAccount> {
        if (account.kind === 'keepass') {
            await deps.service.assertNoBitwardenKeePassMove(account.id);
            await deps.keePassProjectResolutions.recoverProvider(account.id, signal);
            await deps.keePassProjectRemovals.recoverProvider(account.id, signal);
        }
        if (account.kind === 'mdbx2') {
            await deps.service.assertNoBitwardenMdbxMove(account.id);
            await deps.service.assertNoNearbyNativeSequence(account.id);
            if ((await deps.service.readMdbx2MoveFinalizations()).some(row => row.status !== 'completed' && row.sourceProviderId === account.id))
                throw new Error('此密码源还有待恢复的移动，请先恢复后再同步。');
            await passwordProjectRemovals.recoverProvider(account.id, signal);
            for (const batch of (await deps.service.readMdbx2RestoreBatches()).filter(row => row.status === 'prepared' && row.members[0].provider.id === account.id)) {
                signal.throwIfAborted();
                await deps.mdbx2RestoreBatches.resume(batch.id);
            }
        }
        return account.kind === 'bitwarden' ? passwordProjectRemovals.recoverBeforeSync(account, signal) : account;
    }
    return { recoverProviderBeforeSync, handlers, passwordProjectRemovals, restoreVaultItem };
}
export type ProjectRuntime = ReturnType<typeof createProjectRuntime>;
