import { createAttachmentRuntime, unsupportedAttachmentProvider } from './attachment-runtime';
import type { BitwardenAttachmentContext } from './bitwarden-attachment-context';
import { assertManagerPage } from './request-access';
import { createProviderSyncRuntime } from './provider-sync-runtime';
import { readBitwardenSession } from './bitwarden-session-config';
import { type ProviderAccount, type VaultItem } from "../core/model";
import { sameProviderBinding } from "../core/provider";
import { ProviderAttachmentError } from "../providers/attachments/attachment-contract";
import { BitwardenClient } from "../providers/bitwarden/bitwarden-client";
import { BitwardenDeviceIdentity } from "../providers/bitwarden/bitwarden-device-identity";
import type { BitwardenSessionConfig } from "../providers/bitwarden/bitwarden-client";
import { BitwardenAttachmentDownloadService } from "../providers/bitwarden/bitwarden-attachments";
import { BitwardenTransferAttachmentSource } from '../providers/bitwarden/bitwarden-transfer-attachments';
import { bitwardenProjectCipherId } from '../core/bitwarden-project-removal-local';
import { BitwardenAttachmentMutationService } from "../providers/bitwarden/bitwarden-attachment-mutations";
import { resolveBitwardenOrganizationKeys } from "../providers/bitwarden/bitwarden-organization";
import type { BitwardenSymmetricKey } from "../providers/bitwarden/bitwarden-crypto";
import { BitwardenFolderError, BitwardenFolderService, type BitwardenFolderMutationResult } from "../providers/bitwarden/bitwarden-folders";
import { BitwardenCollectionError, BitwardenCollectionService, type BitwardenCollectionMutationResult } from "../providers/bitwarden/bitwarden-collections";
import { createSourceRecord } from "../core/source-records";
import type { IdentityFlowRuntime } from './identity-flow-runtime';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    attachmentRuntime: Pick<ReturnType<typeof createAttachmentRuntime>, "clear">;
    bitwardenProvider: Pick<import("../providers/bitwarden/bitwarden-provider").BitwardenProvider, "lockAccount">;
    completeBitwardenDuo: IdentityFlowRuntime["completeBitwardenDuo"];
    completeBitwardenWebAuthn: IdentityFlowRuntime["completeBitwardenWebAuthn"];
    loginBitwardenWithSso: IdentityFlowRuntime["loginBitwardenWithSso"];
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "activity">;
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "applyProviderSync" | "getItem" | "getProvider" | "readState" | "upsertProvider">;
}
export type BitwardenRuntimeRequest = Extract<ExtensionRequest, {
    type: "BITWARDEN_LOGIN" | "BITWARDEN_LOGOUT" | "BITWARDEN_SEND_EMAIL_CODE" | "BITWARDEN_FOLDER_LIST" | "BITWARDEN_FOLDER_CREATE" | "BITWARDEN_FOLDER_RENAME" | "BITWARDEN_FOLDER_DELETE" | "BITWARDEN_CIPHER_MOVE_FOLDER" | "BITWARDEN_COLLECTION_LIST" | "BITWARDEN_CIPHER_MOVE_COLLECTIONS";
}>;
export function createBitwardenRuntime(deps: Dependencies) {
    const bitwardenClient = new BitwardenClient();
    const bitwardenDeviceIdentity = new BitwardenDeviceIdentity(chrome.storage.local);
    const bitwardenFolders = new BitwardenFolderService(bitwardenClient);
    const bitwardenCollections = new BitwardenCollectionService(bitwardenClient);
    const bitwardenAttachmentDownloads = new BitwardenAttachmentDownloadService();
    const bitwardenTransferAttachmentSource = new BitwardenTransferAttachmentSource(bitwardenAttachmentDownloads, loadBitwardenTransferAttachmentContext, persistBitwardenSession);
    const bitwardenAttachmentMutations = new BitwardenAttachmentMutationService();
    async function requireBitwardenAccountRecord(providerId: string): Promise<ProviderAccount> {
        const account = await deps.service.getProvider(providerId);
        if (!account || account.kind !== "bitwarden")
            throw new BitwardenFolderError("folder-provider-not-found", "Bitwarden 密码源不存在。");
        return account;
    }
    /**
     * A folder-only mutation changes encrypted routing metadata, not the decrypted item body. Apply
     * the authoritative Cipher projection to every local sibling (including Passkey children) while
     * keeping raw encrypted fields in the source envelope. No raw Cipher is returned to runtime pages.
     */
    async function acknowledgeBitwardenCipherProjection(account: ProviderAccount, session: BitwardenSessionConfig, rawCiphers: Record<string, unknown>[], requiredItemId?: string): Promise<void> {
        if (account.kind !== "bitwarden")
            throw new BitwardenFolderError("folder-provider-not-found", "Bitwarden 密码源不存在。");
        const state = await deps.service.readState();
        const scoped = state.items.filter((item) => item.providerRefs.some((reference) => reference.providerId === account.id));
        const hasBaseline = scoped.some((item) => Boolean(item.providerRefs.find((reference) => reference.providerId === account.id)?.revision));
        if (!rawCiphers.length && hasBaseline)
            throw new BitwardenFolderError("sync-empty-protected", "Bitwarden 返回空密码库，未更新本地文件夹路由。");
        const rawByCipherId = new Map<string, Record<string, unknown>>();
        for (const raw of rawCiphers) {
            const cipherId = bitwardenStringValue(raw, "Id", "id");
            const revision = bitwardenStringValue(raw, "RevisionDate", "revisionDate");
            if (!cipherId || !revision || !Number.isFinite(Date.parse(revision))) {
                throw new BitwardenFolderError("cipher-projection-invalid", "Bitwarden 返回了无法验证的 Cipher 修订信息，未更新本地状态。");
            }
            rawByCipherId.set(cipherId, raw);
        }
        let requiredFound = requiredItemId === undefined;
        const patchedItems = state.items.map((candidate) => {
            const reference = candidate.providerRefs.find((entry) => entry.providerId === account.id);
            if (!reference)
                return candidate;
            const cipherId = bitwardenProjectCipherId(reference.remoteId || '');
            const raw = rawByCipherId.get(cipherId);
            if (!raw)
                return candidate;
            if (candidate.id === requiredItemId)
                requiredFound = true;
            const revision = bitwardenStringValue(raw, "RevisionDate", "revisionDate");
            const folderId = bitwardenStringValue(raw, "FolderId", "folderId");
            const collectionIds = bitwardenStringArrayValue(raw, "CollectionIds", "collectionIds");
            const organizationId = bitwardenStringValue(raw, "OrganizationId", "organizationId");
            const updatedReference = {
                ...reference,
                revision,
                remoteFolderId: folderId || undefined
            };
            if (organizationId)
                updatedReference.remoteCollectionIds = collectionIds || [];
            else
                delete updatedReference.remoteCollectionIds;
            return {
                ...candidate,
                updatedAt: revision,
                providerRefs: [...candidate.providerRefs.filter((entry) => entry.providerId !== account.id), updatedReference]
            } as VaultItem;
        });
        if (!requiredFound)
            throw new BitwardenFolderError("cipher-target-not-found", "移动完成后找不到本地项目，已停止更新本地状态。");
        const newRecords = await Promise.all([...rawByCipherId.entries()].map(async ([cipherId, raw]) => createSourceRecord({
            providerId: account.id,
            remoteId: cipherId,
            revision: bitwardenStringValue(raw, "RevisionDate", "revisionDate"),
            format: "bitwarden-cipher",
            encoding: "json",
            payload: JSON.stringify(raw)
        })));
        const sourceRecords = [
            ...state.sourceRecords.filter((record) => !(record.providerId === account.id && rawByCipherId.has(record.remoteId))),
            ...newRecords
        ];
        await deps.service.applyProviderSync(account.id, patchedItems, { config: { ...account.config, ...session }, lastSyncAt: new Date().toISOString(), lastError: undefined }, [], sourceRecords, state.items, [], [], false, [], { expectedAccount: account });
        account.config = { ...account.config, ...session };
    }
    function publicBitwardenFolderMutationResult(result: BitwardenFolderMutationResult): BitwardenFolderMutationResult {
        const { rawCipher: _rawCipher, ...publicResult } = result;
        return publicResult;
    }
    function publicBitwardenCollectionMutationResult(result: BitwardenCollectionMutationResult): BitwardenCollectionMutationResult {
        const { rawCipher: _rawCipher, ...publicResult } = result;
        return publicResult;
    }
    async function loadBitwardenAttachmentContext(account: ProviderAccount, item: VaultItem): Promise<BitwardenAttachmentContext> {
        if (account.kind !== "bitwarden")
            throw unsupportedAttachmentProvider(account.kind);
        const session = readBitwardenSession(account);
        const cipherId = bitwardenCipherIdForItem(account.id, item);
        const synced = await bitwardenClient.sync(session);
        const ciphers = bitwardenRecordArray(synced.payload, "Ciphers", "ciphers");
        const rawCipher = ciphers.find((candidate) => bitwardenStringValue(candidate, "Id", "id") === cipherId);
        if (!rawCipher)
            throw new ProviderAttachmentError("attachment-target-not-found", "Bitwarden 项目不存在或已被删除，请先同步密码源。");
        const vaultKey = bitwardenClient.vaultKey(synced.session);
        try {
            const organizations = await resolveBitwardenOrganizationKeys(synced.payload, vaultKey);
            return {
                providerId: account.id,
                itemId: item.id,
                session: synced.session,
                rawCipher,
                organizationKeys: organizations.keys
            };
        }
        finally {
            clearBitwardenSymmetricKey(vaultKey);
        }
    }
    async function loadBitwardenTransferAttachmentContext(account: ProviderAccount, item: VaultItem): Promise<BitwardenAttachmentContext> {
        const current = await deps.service.getProvider(account.id);
        if (!current?.enabled || !sameProviderBinding(current, account))
            throw new Error('Bitwarden 传输来源连接已变化。');
        // Personal attachments need one Cipher, not a full vault download per file.
        const detail = await bitwardenClient.getCipherDetails(readBitwardenSession(current), bitwardenCipherIdForItem(account.id, item));
        if (!detail.payload)
            throw new Error('Bitwarden 来源项目不存在或已删除。');
        if (!bitwardenStringValue(detail.payload, 'OrganizationId', 'organizationId')) {
            return { providerId: account.id, itemId: item.id, session: detail.session, rawCipher: detail.payload, organizationKeys: new Map() };
        }
        const synced = await bitwardenClient.sync(detail.session);
        const vaultKey = bitwardenClient.vaultKey(synced.session);
        try {
            const organizations = await resolveBitwardenOrganizationKeys(synced.payload, vaultKey);
            return { providerId: account.id, itemId: item.id, session: synced.session, rawCipher: detail.payload, organizationKeys: organizations.keys };
        }
        finally {
            clearBitwardenSymmetricKey(vaultKey);
        }
    }
    function bitwardenCipherIdForItem(providerId: string, item: VaultItem): string {
        const reference = item.providerRefs.find((candidate) => candidate.providerId === providerId);
        const remoteId = bitwardenProjectCipherId(reference?.remoteId || '');
        if (!remoteId)
            throw new ProviderAttachmentError("attachment-target-not-synced", "该项目尚未写入 Bitwarden，完成项目同步后才能管理附件。");
        return remoteId;
    }
    async function persistBitwardenSession(account: ProviderAccount, session: BitwardenSessionConfig): Promise<void> {
        if (account.kind !== "bitwarden")
            return;
        const config = { ...account.config, ...session };
        if (sameBitwardenConfig(account.config, config))
            return;
        await deps.service.upsertProvider({ ...account, config, lastError: undefined }, false, account);
        account.config = config;
    }
    async function acknowledgeBitwardenAttachmentMutation(account: ProviderAccount, item: VaultItem, session: BitwardenSessionConfig, rawCipher: Record<string, unknown>): Promise<void> {
        if (account.kind !== "bitwarden")
            throw unsupportedAttachmentProvider(account.kind);
        const cipherId = bitwardenStringValue(rawCipher, "Id", "id");
        const revision = bitwardenStringValue(rawCipher, "RevisionDate", "revisionDate");
        if (!cipherId || !revision || !Number.isFinite(Date.parse(revision))) {
            throw new ProviderAttachmentError("bitwarden-cipher-revision-invalid", "Bitwarden 附件操作返回了无效的 Cipher 修订时间。");
        }
        const state = await deps.service.readState();
        const folderValue = bitwardenStringValue(rawCipher, "FolderId", "folderId");
        let matchedTarget = false;
        const patchedItems = state.items.map((candidate) => {
            const reference = candidate.providerRefs.find((entry) => entry.providerId === account.id);
            if (!reference || bitwardenProjectCipherId(reference.remoteId || '') !== cipherId)
                return candidate;
            if (candidate.id === item.id)
                matchedTarget = true;
            const updatedReference = {
                ...reference,
                revision,
                remoteFolderId: folderValue || undefined
            };
            return {
                ...candidate,
                updatedAt: revision,
                providerRefs: [...candidate.providerRefs.filter((entry) => entry.providerId !== account.id), updatedReference]
            } as VaultItem;
        });
        if (!matchedTarget) {
            throw new ProviderAttachmentError("attachment-target-not-found", "Bitwarden 附件操作完成后找不到原项目，已停止更新本地状态。");
        }
        const sourceRecord = await createSourceRecord({
            providerId: account.id,
            remoteId: cipherId,
            revision,
            format: "bitwarden-cipher",
            encoding: "json",
            payload: JSON.stringify(rawCipher)
        });
        const sourceRecords = [
            ...state.sourceRecords.filter((record) => !(record.providerId === account.id && record.remoteId === cipherId)),
            sourceRecord
        ];
        await deps.service.applyProviderSync(account.id, patchedItems, { config: { ...account.config, ...session }, lastSyncAt: new Date().toISOString(), lastError: undefined }, [], sourceRecords, state.items);
        account.config = { ...account.config, ...session };
    }
    function clearBitwardenOrganizationKeys(keys: Map<string, BitwardenSymmetricKey>): void {
        for (const key of keys.values())
            clearBitwardenSymmetricKey(key);
        keys.clear();
    }
    function clearBitwardenSymmetricKey(key: BitwardenSymmetricKey): void {
        key.encKey.fill(0);
        key.macKey.fill(0);
    }
    function sameBitwardenConfig(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
        const normalize = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => a.localeCompare(b)));
        return normalize(left) === normalize(right);
    }
    function bitwardenRecordArray(raw: Record<string, unknown>, ...names: string[]): Record<string, unknown>[] {
        const value = names.map((name) => raw[name]).find((candidate) => candidate !== undefined);
        if (!Array.isArray(value))
            throw new ProviderAttachmentError("bitwarden-sync-response-invalid", "Bitwarden 同步响应缺少 Cipher 列表。");
        return value.filter((candidate): candidate is Record<string, unknown> => Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate));
    }
    function bitwardenStringValue(raw: Record<string, unknown>, ...names: string[]): string {
        for (const name of names)
            if (typeof raw[name] === "string")
                return raw[name] as string;
        return "";
    }
    function bitwardenStringArrayValue(raw: Record<string, unknown>, ...names: string[]): string[] | undefined {
        for (const name of names) {
            if (!(name in raw))
                continue;
            const value = raw[name];
            if (!Array.isArray(value))
                return [];
            return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 512))];
        }
        return undefined;
    }
    const handlers: CommandHandlers<BitwardenRuntimeRequest> = {
        "BITWARDEN_LOGIN": async (request, sender) => {
            assertManagerPage(sender);
            const existing = request.providerId ? await deps.service.getProvider(request.providerId) : undefined;
            if (existing && existing.kind !== "bitwarden")
                throw new Error("所选密码源不是 Bitwarden。");
            if (request.twoFactorProvider === 5 && !request.twoFactorProviderData)
                throw new Error("Bitwarden WebAuthn 验证数据已过期，请重新开始登录。");
            if ((request.twoFactorProvider === 2 || request.twoFactorProvider === 4) && !request.twoFactorProviderData)
                throw new Error("Bitwarden Duo 验证数据已过期，请重新开始登录。");
            const webAuthnToken = request.twoFactorProvider === 5 && request.twoFactorProviderData
                ? await deps.completeBitwardenWebAuthn(request.vaultUrl, request.twoFactorProviderData)
                : undefined;
            const duoToken = (request.twoFactorProvider === 2 || request.twoFactorProvider === 4) && request.twoFactorProviderData
                ? await deps.completeBitwardenDuo(request.twoFactorProviderData, request.twoFactorProvider)
                : undefined;
            const result = request.ssoOrganizationIdentifier?.trim()
                ? await deps.loginBitwardenWithSso(request, existing?.config.deviceId)
                : await bitwardenClient.login({
                    vaultUrl: request.vaultUrl,
                    email: request.email,
                    masterPassword: request.masterPassword,
                    deviceId: await bitwardenDeviceIdentity.get(existing?.config.deviceId),
                    twoFactorCode: webAuthnToken || duoToken || request.twoFactorCode,
                    twoFactorProvider: request.twoFactorProvider,
                    rememberTwoFactor: request.rememberTwoFactor,
                    newDeviceOtp: request.newDeviceOtp
                });
            if (result.status === "two-factor-required")
                return { status: result.status, providers: result.providers, providerData: result.providerData };
            if (result.status === "device-verification-required")
                return result;
            if (result.status === "sso-required")
                return result;
            const account: ProviderAccount = {
                id: existing?.id || crypto.randomUUID(),
                kind: "bitwarden",
                name: request.name.trim() || "Bitwarden",
                enabled: true,
                isDefaultSaveTarget: Boolean(request.isDefaultSaveTarget),
                config: {
                    ...result.session,
                    ...(existing?.config.accountState && typeof existing.config.accountState === "object" && !Array.isArray(existing.config.accountState)
                        ? { accountState: existing.config.accountState }
                        : {})
                },
                lastSyncAt: existing?.lastSyncAt,
                lastError: undefined,
                compatibility: existing?.compatibility
            };
            await deps.service.upsertProvider(account);
            return { status: "authenticated", providerId: account.id };
        },
        "BITWARDEN_LOGOUT": async (request, sender) => {
            assertManagerPage(sender);
            deps.providerSync.activity.abort(request.providerId, new DOMException('Bitwarden 已退出登录', 'AbortError'));
            deps.bitwardenProvider.lockAccount(request.providerId);
            const account = await deps.service.getProvider(request.providerId);
            if (!account || account.kind !== "bitwarden")
                throw new Error("所选密码源不是 Bitwarden。");
            if (typeof account.config.refreshToken === "string" && account.config.refreshToken) {
                try {
                    await bitwardenClient.revoke(readBitwardenSession(account));
                }
                catch {
                    // Local logout must still complete when the identity server is unavailable.
                }
            }
            const config = { ...account.config };
            for (const key of ["accessToken", "refreshToken", "expiresAt", "vaultKeyEnc", "vaultKeyMac"])
                delete config[key];
            deps.attachmentRuntime.clear(account.id);
            await deps.service.upsertProvider({ ...account, config, lastError: undefined });
            return undefined;
        },
        "BITWARDEN_SEND_EMAIL_CODE": async (request, sender) => {
            assertManagerPage(sender);
            const existing = request.providerId ? await deps.service.getProvider(request.providerId) : undefined;
            return bitwardenClient.sendTwoFactorEmailCode({
                vaultUrl: request.vaultUrl,
                email: request.email,
                masterPassword: request.masterPassword,
                deviceId: await bitwardenDeviceIdentity.get(existing?.config.deviceId)
            });
        },
        "BITWARDEN_FOLDER_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const account = await requireBitwardenAccountRecord(request.providerId);
            const result = await bitwardenFolders.list(readBitwardenSession(account), request, undefined);
            await persistBitwardenSession(account, result.session);
            return result.page;
        },
        "BITWARDEN_FOLDER_CREATE": async (request, sender) => {
            assertManagerPage(sender);
            const account = await requireBitwardenAccountRecord(request.providerId);
            const result = await bitwardenFolders.create(readBitwardenSession(account), request.name);
            await persistBitwardenSession(account, result.session);
            return result.result;
        },
        "BITWARDEN_FOLDER_RENAME": async (request, sender) => {
            assertManagerPage(sender);
            const account = await requireBitwardenAccountRecord(request.providerId);
            const result = await bitwardenFolders.rename(readBitwardenSession(account), request.folderId, request.name, request.expectedRevision);
            await persistBitwardenSession(account, result.session);
            return result.result;
        },
        "BITWARDEN_FOLDER_DELETE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new BitwardenFolderError("folder-delete-confirmation-required", "删除 Bitwarden 文件夹需要明确确认。");
            const account = await requireBitwardenAccountRecord(request.providerId);
            const result = await bitwardenFolders.remove(readBitwardenSession(account), request.folderId, request.expectedRevision);
            await persistBitwardenSession(account, result.session);
            // Bitwarden clears FolderId on affected Ciphers after deleting a folder. Re-read the
            // encrypted projection before touching local references; an empty response is never
            // allowed to erase an existing local baseline.
            const synced = await bitwardenClient.sync(result.session);
            await acknowledgeBitwardenCipherProjection(account, synced.session, bitwardenRecordArray(synced.payload, "Ciphers", "ciphers"));
            await persistBitwardenSession(account, synced.session);
            return result.result;
        },
        "BITWARDEN_CIPHER_MOVE_FOLDER": async (request, sender) => {
            assertManagerPage(sender);
            const account = await requireBitwardenAccountRecord(request.providerId);
            const item = await deps.service.getItem(request.itemId);
            if (!item || !item.providerRefs.some((reference) => reference.providerId === account.id)) {
                throw new BitwardenFolderError("cipher-target-not-found", "项目不存在或不属于所选 Bitwarden 密码源。");
            }
            const cipherId = bitwardenCipherIdForItem(account.id, item);
            const result = await bitwardenFolders.moveCipher(readBitwardenSession(account), cipherId, request.targetFolderId, request.expectedCipherRevision, request.expectedTargetFolderRevision);
            if (!result.result.rawCipher)
                throw new BitwardenFolderError("cipher-response-invalid", "Bitwarden 移动响应缺少项目状态。");
            await acknowledgeBitwardenCipherProjection(account, result.session, [result.result.rawCipher], request.itemId);
            await persistBitwardenSession(account, result.session);
            return publicBitwardenFolderMutationResult(result.result);
        },
        "BITWARDEN_COLLECTION_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const account = await requireBitwardenAccountRecord(request.providerId);
            const result = await bitwardenCollections.list(readBitwardenSession(account), request, undefined);
            await persistBitwardenSession(account, result.session);
            return result.page;
        },
        "BITWARDEN_CIPHER_MOVE_COLLECTIONS": async (request, sender) => {
            assertManagerPage(sender);
            const account = await requireBitwardenAccountRecord(request.providerId);
            const item = await deps.service.getItem(request.itemId);
            if (!item || !item.providerRefs.some((reference) => reference.providerId === account.id)) {
                throw new BitwardenCollectionError("cipher-target-not-found", "项目不存在或不属于所选 Bitwarden 密码源。");
            }
            const cipherId = bitwardenCipherIdForItem(account.id, item);
            const result = await bitwardenCollections.moveCipher(readBitwardenSession(account), cipherId, request.collectionIds, request.expectedCipherRevision);
            if (!result.result.rawCipher)
                throw new BitwardenCollectionError("cipher-response-invalid", "Bitwarden Collection 响应缺少项目状态。");
            await acknowledgeBitwardenCipherProjection(account, result.session, [result.result.rawCipher], request.itemId);
            await persistBitwardenSession(account, result.session);
            return publicBitwardenCollectionMutationResult(result.result);
        },
    };
    return { acknowledgeBitwardenAttachmentMutation, bitwardenAttachmentDownloads, bitwardenAttachmentMutations, bitwardenClient, bitwardenDeviceIdentity, bitwardenTransferAttachmentSource, clearBitwardenOrganizationKeys, handlers, loadBitwardenAttachmentContext, loadBitwardenTransferAttachmentContext, persistBitwardenSession, requireBitwardenAccountRecord };
}
export type BitwardenRuntime = ReturnType<typeof createBitwardenRuntime>;
