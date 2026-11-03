import { assertExtensionPage } from './request-access';
import { type LoginItem, type TotpItem } from "../core/model";
import { projectSteamItem } from "../core/steam-item";
import { cancelSteamMarketListing, getSteamInventoryOverview, getSteamMarketQuote, getSteamMiniProfileBackground, listSteamInventoryItems, listSteamMarketListings, sellSteamMarketItems } from "../providers/steam/steam-market";
import { listSteamAuthorizedDevices, listSteamConfirmations, listSteamPendingLogins, respondToSteamConfirmation, respondToSteamLogin } from "../providers/steam/steam-network";
import { revokeSteamAuthorizedDevice } from "../providers/steam/steam-revocation";
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "getItem" | "upsertItem">;
}
export type SteamRuntimeRequest = Extract<ExtensionRequest, {
    type: "STEAM_LIST_CONFIRMATIONS" | "STEAM_RESPOND_CONFIRMATION" | "STEAM_LIST_PENDING_LOGINS" | "STEAM_RESPOND_LOGIN" | "STEAM_LIST_AUTHORIZED_DEVICES" | "STEAM_GET_INVENTORY_OVERVIEW" | "STEAM_LIST_INVENTORY_ITEMS" | "STEAM_GET_MARKET_QUOTE" | "STEAM_LIST_MARKET_LISTINGS" | "STEAM_SELL_MARKET_ITEMS" | "STEAM_CANCEL_MARKET_LISTING" | "STEAM_GET_MINI_PROFILE_BACKGROUND" | "STEAM_REVOKE_AUTHORIZED_DEVICE";
}>;
export function createSteamRuntime(deps: Dependencies) {
    async function requireSteamItem(itemId: string): Promise<TotpItem> {
        const item = await deps.service.getItem(itemId);
        const projected = item && projectSteamItem(item as LoginItem | TotpItem);
        if (!projected)
            throw new Error("Steam 验证器不存在或类型不正确。");
        return structuredClone(projected);
    }
    async function runSteamOperation<T>(itemId: string, operation: (item: TotpItem) => Promise<T>): Promise<T> {
        const source = await deps.service.getItem(itemId);
        const item = await requireSteamItem(itemId);
        const before = JSON.stringify([item.steamAccessToken, item.steamRefreshToken, item.steamLoginSecure, item.steamRawJson]);
        const result = await operation(item);
        const after = JSON.stringify([item.steamAccessToken, item.steamRefreshToken, item.steamLoginSecure, item.steamRawJson]);
        // A Bitwarden Steam entry is canonically a login Cipher. Its projected view
        // must never be persisted as a second Monica TOTP item.
        if (before !== after && source?.kind === "totp")
            await deps.service.upsertItem({ ...item, updatedAt: new Date().toISOString() });
        return result;
    }
    const handlers: CommandHandlers<SteamRuntimeRequest> = {
        "STEAM_LIST_CONFIRMATIONS": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, listSteamConfirmations);
        },
        "STEAM_RESPOND_CONFIRMATION": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, (item) => respondToSteamConfirmation(item, request.confirmation, request.accept));
        },
        "STEAM_LIST_PENDING_LOGINS": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, listSteamPendingLogins);
        },
        "STEAM_RESPOND_LOGIN": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, (item) => respondToSteamLogin(item, request.login, request.approve));
        },
        "STEAM_LIST_AUTHORIZED_DEVICES": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, listSteamAuthorizedDevices);
        },
        "STEAM_GET_INVENTORY_OVERVIEW": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, getSteamInventoryOverview);
        },
        "STEAM_LIST_INVENTORY_ITEMS": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, (item) => listSteamInventoryItems(item, request));
        },
        "STEAM_GET_MARKET_QUOTE": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, (item) => getSteamMarketQuote(item, request));
        },
        "STEAM_LIST_MARKET_LISTINGS": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, (item) => listSteamMarketListings(item, request));
        },
        "STEAM_SELL_MARKET_ITEMS": async (request, sender) => {
            assertExtensionPage(sender);
            if (request.confirmed !== true)
                throw new Error("Steam 出售操作需要明确确认。");
            return runSteamOperation(request.itemId, (item) => sellSteamMarketItems(item, request));
        },
        "STEAM_CANCEL_MARKET_LISTING": async (request, sender) => {
            assertExtensionPage(sender);
            if (request.confirmed !== true)
                throw new Error("Steam 撤销挂单需要明确确认。");
            return runSteamOperation(request.itemId, (item) => cancelSteamMarketListing(item, request.listingId));
        },
        "STEAM_GET_MINI_PROFILE_BACKGROUND": async (request, sender) => {
            assertExtensionPage(sender);
            return runSteamOperation(request.itemId, getSteamMiniProfileBackground);
        },
        "STEAM_REVOKE_AUTHORIZED_DEVICE": async (request, sender) => {
            assertExtensionPage(sender);
            if (request.confirmed !== true)
                throw new Error("Steam 设备撤销需要明确确认。");
            let password = request.password;
            request.password = "";
            try {
                return await runSteamOperation(request.itemId, async (item) => {
                    const target = (await listSteamAuthorizedDevices(item)).find((device) => device.tokenId === request.tokenId);
                    if (!target)
                        throw new Error("Steam 授权设备已不存在，请刷新列表。");
                    if (target.isCurrent)
                        throw new Error("当前 Steam 授权设备不能从 Monica 中撤销。");
                    const input = { accountName: request.accountName, password, tokenId: target.tokenId };
                    password = "";
                    return revokeSteamAuthorizedDevice(item, input);
                });
            }
            finally {
                password = "";
                request.password = "";
            }
        },
    };
    return { handlers };
}
export type SteamRuntime = ReturnType<typeof createSteamRuntime>;
