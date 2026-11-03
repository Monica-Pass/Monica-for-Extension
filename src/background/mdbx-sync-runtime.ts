import { assertManagerPage } from './request-access';
import { normalizeMdbx2RemotePath } from "../providers/mdbx2/mdbx2-sync-paths";
import { parseOneDriveConnection, type OneDriveConnection } from "../providers/onedrive/onedrive-token-manager";
import type { Mdbx2BootstrapDownloadInput } from "../runtime/messages";
import { VaultLockedError } from "../security/secure-vault-service";
import type { MdbxRuntime } from './mdbx-runtime';
import type { KeePassRuntime } from './keepass-runtime';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    effectiveMdbx2WebDavSettings: MdbxRuntime["effectiveMdbx2WebDavSettings"];
    managerSyncStatus: MdbxRuntime["managerSyncStatus"];
    mdbx2CloudSyncInput: MdbxRuntime["mdbx2CloudSyncInput"];
    mdbx2RemoteSyncConfig: MdbxRuntime["mdbx2RemoteSyncConfig"];
    mdbx2SyncCoordinator: Pick<MdbxRuntime["mdbx2SyncCoordinator"], "downloadBootstrap" | "publishBootstrap" | "registerDownloadedBootstrap" | "status">;
    oneDriveSessions: Pick<KeePassRuntime["oneDriveSessions"], "cancel" | "connectionForLogin" | "driveForLogin">;
    requireMdbx2Account: MdbxRuntime["requireMdbx2Account"];
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "passkeySessionId" | "upsertProvider">;
    stringAccountConfig: MdbxRuntime["stringAccountConfig"];
}
export type MdbxSyncRuntimeRequest = Extract<ExtensionRequest, {
    type: "MDBX2_WEBDAV_SAVE" | "MDBX2_ONEDRIVE_SAVE" | "MDBX2_BOOTSTRAP_DOWNLOAD" | "MDBX2_BOOTSTRAP_PUBLISH" | "MDBX2_BOOTSTRAP_REGISTER" | "MDBX2_SYNC_STATUS";
}>;
export function createMdbxSyncRuntime(deps: Dependencies) {
    const handlers: CommandHandlers<MdbxSyncRuntimeRequest> = {
        "MDBX2_WEBDAV_SAVE": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireMdbx2Account(request.providerId);
            const previous = account.config;
            const config = deps.effectiveMdbx2WebDavSettings(request.config, previous);
            const previousBaseUrl = deps.stringAccountConfig(account, "webDavBaseUrl");
            const previousRemotePath = deps.stringAccountConfig(account, "remotePath");
            const remoteBindingChanged = Boolean(previousBaseUrl || previousRemotePath)
                && (previousBaseUrl !== config.baseUrl || previousRemotePath !== config.remotePath);
            return deps.service.upsertProvider({
                ...account,
                name: request.name.trim() || account.name || "Monica MDBX2",
                isDefaultSaveTarget: Boolean(request.isDefaultSaveTarget),
                config: {
                    ...previous,
                    syncTransport: "webdav",
                    webDavBaseUrl: config.baseUrl,
                    webDavUsername: config.username,
                    webDavPassword: config.password,
                    remotePath: config.remotePath,
                    syncStateHandle: remoteBindingChanged ? undefined : previous.syncStateHandle
                },
                lastSyncAt: remoteBindingChanged ? undefined : account.lastSyncAt,
                lastError: undefined
            });
        },
        "MDBX2_ONEDRIVE_SAVE": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireMdbx2Account(request.providerId);
            const previous = account.config;
            const remotePath = normalizeMdbx2RemotePath(request.config.remotePath);
            const previousConnection = parseOneDriveConnection(previous.oneDriveConnection);
            const previousDriveId = deps.stringAccountConfig(account, "oneDriveDriveId");
            const previousRemotePath = deps.stringAccountConfig(account, "remotePath");
            let connection: OneDriveConnection;
            let driveId: string;
            if (request.config.loginId) {
                connection = await deps.oneDriveSessions.connectionForLogin(request.config.loginId);
                driveId = (await deps.oneDriveSessions.driveForLogin(request.config.loginId)).id;
            }
            else {
                if (!previousConnection || !previousDriveId)
                    throw new Error("请先登录 OneDrive。");
                connection = previousConnection;
                driveId = previousDriveId;
            }
            // A same-account reauthorization keeps the durable connection id, so token
            // rotation stays bound to the stored provider.
            const savedConnection = previousConnection && previousConnection.profile.id === connection.profile.id && previousConnection.clientId === connection.clientId
                ? { ...connection, id: previousConnection.id } : connection;
            const remoteBindingChanged = Boolean(previousRemotePath || previousDriveId)
                && (previousDriveId !== driveId || previousRemotePath !== remotePath);
            const saved = await deps.service.upsertProvider({
                ...account,
                name: request.name.trim() || account.name || "Monica MDBX2",
                isDefaultSaveTarget: Boolean(request.isDefaultSaveTarget),
                config: {
                    ...previous,
                    syncTransport: "onedrive",
                    oneDriveConnection: savedConnection,
                    oneDriveDriveId: driveId,
                    remotePath,
                    syncStateHandle: remoteBindingChanged ? undefined : previous.syncStateHandle
                },
                lastSyncAt: remoteBindingChanged ? undefined : account.lastSyncAt,
                lastError: undefined
            });
            if (request.config.loginId)
                deps.oneDriveSessions.cancel(request.config.loginId);
            return saved;
        },
        "MDBX2_BOOTSTRAP_DOWNLOAD": async (request, sender) => {
            assertManagerPage(sender);
            const config: Mdbx2BootstrapDownloadInput = request.config;
            if (config.transport === "onedrive") {
                return deps.mdbx2SyncCoordinator.downloadBootstrap({
                    transport: "onedrive", driveId: config.driveId, remotePath: config.remotePath, loginId: config.loginId
                });
            }
            return deps.mdbx2SyncCoordinator.downloadBootstrap(deps.effectiveMdbx2WebDavSettings(config));
        },
        "MDBX2_BOOTSTRAP_PUBLISH": async (request, sender) => {
            assertManagerPage(sender);
            const sessionId = await deps.service.passkeySessionId();
            if (!sessionId)
                throw new VaultLockedError();
            const account = await deps.requireMdbx2Account(request.providerId);
            const input = deps.mdbx2CloudSyncInput(account, false);
            const published = await deps.mdbx2SyncCoordinator.publishBootstrap(input, undefined, stateHandle => deps.service.upsertProvider({
                ...account, config: { ...account.config, syncStateHandle: stateHandle }, lastError: undefined
            }, false, account, { sessionId }).then(() => undefined));
            return deps.managerSyncStatus(published.status, true, true);
        },
        "MDBX2_BOOTSTRAP_REGISTER": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireMdbx2Account(request.providerId);
            const config = deps.mdbx2RemoteSyncConfig(account);
            const vaultHandle = deps.stringAccountConfig(account, "vaultHandle");
            if (!vaultHandle)
                throw new Error("MDBX2 密码源缺少本机工作副本。");
            const status = await deps.mdbx2SyncCoordinator.registerDownloadedBootstrap(vaultHandle, config);
            await deps.service.upsertProvider({
                ...account,
                config: { ...account.config, syncStateHandle: status.stateHandle },
                lastError: undefined
            });
            return deps.managerSyncStatus(status, true, true);
        },
        "MDBX2_SYNC_STATUS": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.requireMdbx2Account(request.providerId);
            const configured = Boolean((deps.stringAccountConfig(account, "webDavBaseUrl") || account.config.syncTransport === "onedrive")
                && deps.stringAccountConfig(account, "remotePath"));
            const syncStateHandle = deps.stringAccountConfig(account, "syncStateHandle");
            if (!configured || !syncStateHandle)
                return deps.managerSyncStatus(undefined, configured, false);
            return deps.managerSyncStatus(await deps.mdbx2SyncCoordinator.status(deps.mdbx2CloudSyncInput(account, true)), true, true);
        },
    };
    return { handlers };
}
export type MdbxSyncRuntime = ReturnType<typeof createMdbxSyncRuntime>;
