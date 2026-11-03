import { assertManagerPage, assertExtensionPage } from './request-access';
import type { ProjectRuntime } from './project-runtime';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    monicaWebDavProvider: Pick<import("../providers/webdav/monica-webdav-provider").MonicaWebDavProvider, "deleteGeneratorHistoryEntry" | "listGeneratorHistory">;
    restoreVaultItem: ProjectRuntime["restoreVaultItem"];
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "batchMutateItems" | "consumeHotp" | "deleteItem" | "deletePasswordGroup" | "deletePasswordHistory" | "emptyLocalTrash" | "getHomePreferences" | "getItem" | "getProvider" | "importItems" | "listArchivedItems" | "listDeletedItems" | "listItems" | "listLockedAutofillItemIds" | "readState" | "savePasswordGroup" | "setHomePreferences" | "setLockedAutofill" | "setPasswordCover" | "setPasswordStack" | "unarchiveItem" | "upsertItem">;
}
export type VaultItemRuntimeRequest = Extract<ExtensionRequest, {
    type: "VAULT_IMPORT_ITEMS" | "VAULT_LIST_ITEMS" | "VAULT_ITEM_SNAPSHOT" | "VAULT_LIST_ARCHIVED_ITEMS" | "VAULT_LIST_DELETED_ITEMS" | "VAULT_GET_ITEM" | "VAULT_HOME_GET" | "VAULT_HOME_SET" | "VAULT_UPSERT_ITEM" | "VAULT_SAVE_PASSWORD_GROUP" | "VAULT_CONSUME_HOTP" | "VAULT_UNARCHIVE_ITEM" | "VAULT_DELETE_PASSWORD_HISTORY" | "VAULT_SET_PASSWORD_COVER" | "VAULT_SET_PASSWORD_STACK" | "VAULT_LOCKED_AUTOFILL_IDS" | "VAULT_SET_LOCKED_AUTOFILL" | "VAULT_BATCH_MUTATE" | "VAULT_DELETE_ITEM" | "VAULT_EMPTY_LOCAL_TRASH" | "VAULT_DELETE_PASSWORD_GROUP" | "VAULT_RESTORE_ITEM" | "ANDROID_GENERATOR_HISTORY_LIST" | "ANDROID_GENERATOR_HISTORY_DELETE";
}>;
export function createVaultItemRuntime(deps: Dependencies) {
    const handlers: CommandHandlers<VaultItemRuntimeRequest> = {
        "VAULT_IMPORT_ITEMS": async (request, sender) => {
            assertExtensionPage(sender);
            return deps.service.importItems(request.items);
        },
        "VAULT_LIST_ITEMS": async (request, sender) => {
            assertExtensionPage(sender);
            return deps.service.listItems();
        },
        "VAULT_ITEM_SNAPSHOT": async (request, sender) => {
            assertManagerPage(sender);
            const state = await deps.service.readState(false);
            return { items: state.items, lockedAutofillIds: state.settings.lockedAutofillItemIds || [] };
        },
        "VAULT_LIST_ARCHIVED_ITEMS": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.listArchivedItems();
        },
        "VAULT_LIST_DELETED_ITEMS": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.listDeletedItems();
        },
        "VAULT_GET_ITEM": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.getItem(request.itemId);
        },
        "VAULT_HOME_GET": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.getHomePreferences();
        },
        "VAULT_HOME_SET": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.setHomePreferences(request.preferences);
        },
        "VAULT_UPSERT_ITEM": async (request, sender) => {
            assertExtensionPage(sender);
            if (request.allowLockedAutofill !== undefined) {
                assertManagerPage(sender);
                if (typeof request.allowLockedAutofill !== "boolean")
                    throw new Error("免解锁填写标记无效。");
            }
            return deps.service.upsertItem(request.item, request.allowLockedAutofill, request.expectedUpdatedAt);
        },
        "VAULT_SAVE_PASSWORD_GROUP": async (request, sender) => {
            assertManagerPage(sender);
            if (request.allowLockedAutofill !== undefined && typeof request.allowLockedAutofill !== "boolean")
                throw new Error("免解锁填写设置必须是布尔值。");
            return deps.service.savePasswordGroup(request.items, request.expected, request.allowLockedAutofill);
        },
        "VAULT_CONSUME_HOTP": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.consumeHotp(request.usage);
        },
        "VAULT_UNARCHIVE_ITEM": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.unarchiveItem(request.itemId, request.expectedUpdatedAt);
        },
        "VAULT_DELETE_PASSWORD_HISTORY": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.deletePasswordHistory(request.itemId, request.index, request.expectedUpdatedAt);
        },
        "VAULT_SET_PASSWORD_COVER": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.setPasswordCover(request.anchorItemId, request.enabled, request.expected);
        },
        "VAULT_SET_PASSWORD_STACK": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.setPasswordStack(request.anchorItemIds, request.action, request.expected);
        },
        "VAULT_LOCKED_AUTOFILL_IDS": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.listLockedAutofillItemIds();
        },
        "VAULT_SET_LOCKED_AUTOFILL": async (request, sender) => {
            assertManagerPage(sender);
            if (typeof request.enabled !== "boolean")
                throw new Error("免解锁填写标记无效。");
            return deps.service.setLockedAutofill(request.itemId, request.enabled);
        },
        "VAULT_BATCH_MUTATE": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.batchMutateItems(request.input);
        },
        "VAULT_DELETE_ITEM": async (request, sender) => {
            assertExtensionPage(sender);
            return deps.service.deleteItem(request.itemId);
        },
        "VAULT_EMPTY_LOCAL_TRASH": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.emptyLocalTrash();
        },
        "VAULT_DELETE_PASSWORD_GROUP": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.deletePasswordGroup(request.anchorItemId, request.expected);
        },
        "VAULT_RESTORE_ITEM": async (request, sender) => {
            assertManagerPage(sender);
            return deps.restoreVaultItem(request.itemId);
        },
        "ANDROID_GENERATOR_HISTORY_LIST": async (request, sender) => {
            assertManagerPage(sender);
            const account = await deps.service.getProvider(request.providerId);
            if (!account || account.kind !== "monica-webdav")
                throw new Error("Monica Android WebDAV 密码源不存在。");
            return deps.monicaWebDavProvider.listGeneratorHistory(account);
        },
        "ANDROID_GENERATOR_HISTORY_DELETE": async (request, sender) => {
            assertManagerPage(sender);
            if (request.confirmed !== true)
                throw new Error("删除 Android 生成历史需要明确确认。");
            if (!request.entryId || request.entryId.length > 1024)
                throw new Error("Android 生成历史标识无效。");
            const account = await deps.service.getProvider(request.providerId);
            if (!account || account.kind !== "monica-webdav")
                throw new Error("Monica Android WebDAV 密码源不存在。");
            return deps.monicaWebDavProvider.deleteGeneratorHistoryEntry(account, request.entryId);
        },
    };
    return { handlers };
}
export type VaultItemRuntime = ReturnType<typeof createVaultItemRuntime>;
