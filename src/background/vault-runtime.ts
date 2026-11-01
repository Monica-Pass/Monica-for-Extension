import { createAttachmentRuntime } from './attachment-runtime';
import { createBitwardenSendRuntime } from './bitwarden-send-runtime';
import { assertManagerPage, assertExtensionPage } from './request-access';
import { createProviderSyncRuntime } from './provider-sync-runtime';
import { createLoginItem, type LoginItem, type VaultItem } from "../core/model";
import { MDBX2_WINDOWS_HELLO_PROTOCOL_VERSION, MDBX2_WINDOWS_HELLO_RP_ID, type Mdbx2WindowsHelloStatus } from "../providers/mdbx2/native-contract";
import { runtimeInfo } from "../runtime/version";
import type { CredentialRuntime } from './credential-runtime';
import type { KeePassRuntime } from './keepass-runtime';
import type { PasskeyRuntime } from './passkey-runtime';
import type { TransferRuntime } from './transfer-runtime';
import type { MdbxRuntime } from './mdbx-runtime';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    attachmentRuntime: Pick<ReturnType<typeof createAttachmentRuntime>, "clear">;
    bitwardenSendRuntime: Pick<ReturnType<typeof createBitwardenSendRuntime>, "clear">;
    clearCredentialCaptures: CredentialRuntime["clearCredentialCaptures"];
    clearKeePassPendingPersistence: KeePassRuntime["clearKeePassPendingPersistence"];
    clearPendingPasskeyRequests: PasskeyRuntime["clearPendingPasskeyRequests"];
    clearPendingUsernameContexts: CredentialRuntime["clearPendingUsernameContexts"];
    clearTransferSessions: TransferRuntime["clearTransferSessions"];
    clearTransferStatuses: TransferRuntime["clearTransferStatuses"];
    clipboardLifecycle: Pick<import("./clipboard").ClipboardLifecycle, "arm">;
    keePassProvider: Pick<KeePassRuntime["keePassProvider"], "lock">;
    keePassRecoveryDownloads: Pick<KeePassRuntime["keePassRecoveryDownloads"], "clear">;
    mdbx2LocalFileExports: Pick<MdbxRuntime["mdbx2LocalFileExports"], "clear">;
    mdbx2NativeClient: Pick<MdbxRuntime["mdbx2NativeClient"], "close">;
    mdbx2Provider: Pick<MdbxRuntime["mdbx2Provider"], "lock">;
    nearbyOwner: Pick<import("./nearby-owner").NearbyManagerOwner, "close">;
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "abortAll">;
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "authenticatedExport" | "changeMasterPassword" | "getAutoLockMinutes" | "setAutoLockMinutes" | "clearRecoveryCopies" | "enrollWindowsHello" | "lock" | "protectionModeForRuntime" | "restoreEncryptedBackup" | "revokeWindowsHello" | "setup" | "status" | "storageOverview" | "unlock" | "unlockWithWindowsHello" | "windowsHelloBindingIdForRuntime">;
    windowsHelloNativeClient: Pick<MdbxRuntime["windowsHelloNativeClient"], "enrollWindowsHello" | "revokeWindowsHello" | "verifyWindowsHello" | "windowsHelloStatus">;
}
export type VaultRuntimeRequest = Extract<ExtensionRequest, {
    type: "RUNTIME_INFO" | "CLIPBOARD_ARM" | "VAULT_STATUS" | "VAULT_AUTO_LOCK_GET" | "VAULT_AUTO_LOCK_SET" | "VAULT_UNLOCK_HELLO" | "VAULT_HELLO_STATUS" | "VAULT_HELLO_ENROLL" | "VAULT_HELLO_REVOKE" | "VAULT_SETUP" | "VAULT_UNLOCK" | "VAULT_LOCK" | "VAULT_CHANGE_MASTER_PASSWORD" | "VAULT_EXPORT_ENCRYPTED" | "VAULT_AUTHENTICATED_EXPORT" | "VAULT_STORAGE_OVERVIEW" | "VAULT_RECOVERY_CLEAR" | "VAULT_RESTORE_ENCRYPTED";
}>;
export function createVaultRuntime(deps: Dependencies) {
    const LEGACY_VAULT_KEY = "monica.extension.credentials.v1";
    async function readLegacyItems(): Promise<VaultItem[]> {
        const result = await chrome.storage.local.get(LEGACY_VAULT_KEY);
        const records = result[LEGACY_VAULT_KEY];
        if (!Array.isArray(records))
            return [];
        return records.flatMap((record): LoginItem[] => {
            if (!record || typeof record !== "object")
                return [];
            const value = record as Record<string, unknown>;
            const password = typeof value.password === "string" ? value.password : "";
            const urls = Array.isArray(value.urls) ? value.urls.map(String) : [];
            if (!password || !urls.length)
                return [];
            return [
                createLoginItem({
                    title: typeof value.name === "string" ? value.name : "已迁移登录项",
                    username: typeof value.username === "string" ? value.username : "",
                    password,
                    uris: urls,
                    notes: typeof value.notes === "string" ? value.notes : "",
                    favorite: Boolean(value.favorite)
                })
            ];
        });
    }
    const handlers: CommandHandlers<VaultRuntimeRequest> = {
        "RUNTIME_INFO": async (request, sender, nativeWriteLocked) => {
            return runtimeInfo;
        },
        "CLIPBOARD_ARM": async (request, sender, nativeWriteLocked) => {
            assertExtensionPage(sender);
            return deps.clipboardLifecycle.arm(request.digest);
        },
        "VAULT_STATUS": async (request, sender, nativeWriteLocked) => {
            return deps.service.status();
        },
        "VAULT_AUTO_LOCK_GET": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            return deps.service.getAutoLockMinutes();
        },
        "VAULT_AUTO_LOCK_SET": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            return deps.service.setAutoLockMinutes(request.minutes);
        },
        "VAULT_UNLOCK_HELLO": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            const state = await deps.service.unlockWithWindowsHello((bindingId, challenge) => deps.windowsHelloNativeClient.verifyWindowsHello(bindingId, challenge).then(() => undefined));
            return state.items.filter((item) => !item.deletedAt && !item.archivedAt);
        },
        "VAULT_HELLO_STATUS": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            const bindingId = await deps.service.windowsHelloBindingIdForRuntime();
            const protectionMode = await deps.service.protectionModeForRuntime();
            let native: Mdbx2WindowsHelloStatus;
            try {
                native = await deps.windowsHelloNativeClient.windowsHelloStatus(bindingId);
            }
            catch {
                native = {
                    version: MDBX2_WINDOWS_HELLO_PROTOCOL_VERSION,
                    supported: false,
                    available: false,
                    enrolled: false,
                    bindingIdPresent: Boolean(bindingId),
                    rpId: MDBX2_WINDOWS_HELLO_RP_ID,
                    reason: "native-host-unavailable"
                };
            }
            const vaultEnrolled = Boolean(bindingId);
            const bindingConsistent = !vaultEnrolled || native.enrolled;
            return {
                native,
                vaultEnrolled,
                bindingConsistent,
                protectionMode,
                unlockAvailable: Boolean(vaultEnrolled && bindingConsistent && protectionMode === "device-key" && native.supported && native.available)
            };
        },
        "VAULT_HELLO_ENROLL": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            deps.nearbyOwner.close('protection-changed');
            const binding = await deps.service.enrollWindowsHello((bindingId) => deps.windowsHelloNativeClient.enrollWindowsHello(bindingId), (bindingId) => deps.windowsHelloNativeClient.revokeWindowsHello(bindingId).then(() => undefined));
            return binding;
        },
        "VAULT_HELLO_REVOKE": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new Error("撤销 Windows Hello 需要明确确认。");
            deps.nearbyOwner.close('protection-changed');
            return deps.service.revokeWindowsHello((bindingId) => deps.windowsHelloNativeClient.revokeWindowsHello(bindingId).then(() => undefined));
        },
        "VAULT_SETUP": async (request, sender, nativeWriteLocked) => {
            assertExtensionPage(sender);
            const initialItems = await readLegacyItems();
            const state = await deps.service.setup(request.masterPassword, initialItems);
            if (initialItems.length)
                await chrome.storage.local.remove(LEGACY_VAULT_KEY);
            return state.items.filter((item) => !item.deletedAt && !item.archivedAt);
        },
        "VAULT_UNLOCK": async (request, sender, nativeWriteLocked) => {
            assertExtensionPage(sender);
            return (await deps.service.unlock(request.masterPassword)).items.filter((item) => !item.deletedAt && !item.archivedAt);
        },
        "VAULT_LOCK": async (request, sender, nativeWriteLocked) => {
            assertExtensionPage(sender);
            deps.nearbyOwner.close('vault-locked');
            deps.keePassRecoveryDownloads.clear();
            deps.providerSync.abortAll();
            void deps.mdbx2LocalFileExports.clear();
            deps.mdbx2NativeClient.close();
            deps.mdbx2Provider.lock();
            deps.keePassProvider.lock();
            deps.clearKeePassPendingPersistence();
            deps.attachmentRuntime.clear();
            deps.bitwardenSendRuntime.clear();
            deps.clearCredentialCaptures();
            await deps.clearPendingUsernameContexts();
            await deps.clearPendingPasskeyRequests();
            deps.clearTransferStatuses();
            deps.clearTransferSessions();
            return deps.service.lock();
        },
        "VAULT_CHANGE_MASTER_PASSWORD": async (request, sender, nativeWriteLocked) => {
            assertExtensionPage(sender);
            deps.nearbyOwner.close('protection-changed');
            return deps.service.changeMasterPassword(request.currentPassword, request.newPassword);
        },
        "VAULT_EXPORT_ENCRYPTED": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            throw new Error('导出需要重新验证身份，请重新打开导出窗口。');
        },
        "VAULT_AUTHENTICATED_EXPORT": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            return deps.service.authenticatedExport(request.input, async (bindingId, challenge) => {
                const result = await deps.windowsHelloNativeClient.verifyWindowsHello(bindingId, challenge);
                if (!result.verified)
                    throw new Error('Windows Hello 未确认用户身份。');
            });
        },
        "VAULT_STORAGE_OVERVIEW": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            return deps.service.storageOverview();
        },
        "VAULT_RECOVERY_CLEAR": async (request, sender, nativeWriteLocked) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new Error('清理恢复副本需要明确确认。');
            return deps.service.clearRecoveryCopies();
        },
        "VAULT_RESTORE_ENCRYPTED": async (request, sender, nativeWriteLocked) => {
            assertExtensionPage(sender);
            deps.nearbyOwner.close('vault-restored');
            deps.clearTransferSessions();
            const replacedHelloBindingId = request.replaceExisting ? await deps.service.windowsHelloBindingIdForRuntime() : undefined;
            deps.providerSync.abortAll();
            void deps.mdbx2LocalFileExports.clear();
            deps.mdbx2NativeClient.close();
            deps.mdbx2Provider.lock();
            deps.keePassProvider.lock();
            deps.clearKeePassPendingPersistence();
            deps.attachmentRuntime.clear();
            deps.bitwardenSendRuntime.clear();
            const state = await deps.service.restoreEncryptedBackup(request.backup, request.backupPassword, {
                replaceExisting: request.replaceExisting,
                currentPassword: request.currentPassword
            });
            if (replacedHelloBindingId) {
                try {
                    await deps.windowsHelloNativeClient.revokeWindowsHello(replacedHelloBindingId);
                }
                catch { /* The restored vault no longer trusts this binding; native orphan cleanup is best effort. */ }
            }
            deps.clearCredentialCaptures();
            await deps.clearPendingUsernameContexts();
            await deps.clearPendingPasskeyRequests();
            return state.items.filter((item) => !item.deletedAt && !item.archivedAt);
        },
    };
    return { handlers };
}
export type VaultRuntime = ReturnType<typeof createVaultRuntime>;
