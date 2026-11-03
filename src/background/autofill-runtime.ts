import { assertManagerPage, assertExtensionPage } from './request-access';
import { walletPayload } from "../autofill/wallet-payload";
import { isLoginItem, type BillingAddressItem, type CardItem, type IdentityItem, type LoginItem, type PaymentAccountItem, type VaultItem } from "../core/model";
import { loginMatchScore, matchingLogins } from "../core/matching";
import { customIconProjection } from '../core/custom-icon';
import { readInlineAutofillEnabled } from "../autofill/inline-preferences";
import { assertInlineSessionId, INLINE_SUGGESTION_LIMIT, type InlineAutofillResult } from "../autofill/inline-contract";
import { websiteAutofillFields } from "../autofill/custom-fields";
import { autofillCredentialIdentities } from "../autofill/credential-identity";
import { resolveLoginOtp } from "../core/login-otp";
import { currentFrameDocument } from '../runtime/document-target';
import { isFirefoxExtension } from '../runtime/browser-platform';
import { loginWebsiteOrigin } from "../core/website-icon";
import type { LoginMatchSummary, PasskeyMatchSummary, WalletFillKind, WalletFillResult, WalletMatchSummary } from "../runtime/messages";
import { isSecureSensitivePageUrl } from "../runtime/sender-policy";
import { normalizeRpId } from "../passkey/webauthn-core";
import { passkeyAvailability, passkeyMatchesPageHost } from "../passkey/source-policy";
import { isAutofillBlocked } from "../autofill/site-policy";
import { normalizeBlockedFieldSignature, type BlockedFieldSignatureRecord } from "../autofill/field-policy";
import type { AutofillFieldContext } from "../content/field-signature";
import type { CommandEffects } from './command-effects';
import type { AutofillPolicyRuntime } from './autofill-policy-runtime';
import { assertWebPageSender } from './request-access';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    afterRuntimeRequest: CommandEffects["afterRuntimeRequest"];
    autofillBlocked: AutofillPolicyRuntime["autofillBlocked"];
    dismissInlineMenus: CommandEffects["dismissInlineMenus"];
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "addAutofillBlockedFieldSignature" | "consumeHotp" | "dispatchAutofill" | "getAutofillSitePolicy" | "getItem" | "isAutofillFieldSignatureBlocked" | "listAutofillBlockedFieldSignatures" | "listItems" | "readAutofillContext" | "readPasskeyContext" | "removeAutofillBlockedFieldSignature" | "setAutofillSitePolicy" | "status">;
}
export type AutofillRuntimeRequest = Extract<ExtensionRequest, {
    type: "AUTOFILL_INLINE_QUERY" | "AUTOFILL_INLINE_FILL" | "AUTOFILL_INLINE_OPEN" | "VAULT_MATCH_LOGINS" | "VAULT_LIST_LOGIN_SUMMARIES" | "VAULT_LOGIN_SECRET" | "VAULT_MATCH_PASSKEYS" | "VAULT_FILL_LOGIN" | "VAULT_LIST_WALLET_ITEMS" | "VAULT_FILL_WALLET" | "AUTOFILL_SITE_POLICY_GET" | "AUTOFILL_SITE_POLICY_SET" | "AUTOFILL_FIELD_POLICY_LIST" | "AUTOFILL_FIELD_POLICY_STATUS" | "AUTOFILL_FIELD_POLICY_SET_CURRENT" | "AUTOFILL_FIELD_POLICY_REMOVE";
}>;
export function createAutofillRuntime(deps: Dependencies) {
    interface SensitiveFillTarget {
        url: string;
        origin: string;
        documentId: string;
        frameId: number;
    }
    async function resolveSensitiveFillTarget(tabId: number, frameId = 0, documentId?: string, expectedOrigin?: string): Promise<SensitiveFillTarget> {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active)
            throw new Error("已阻止向非活动标签页填充敏感信息。");
        const target = await chrome.webNavigation.getFrame({ tabId, frameId });
        if (!currentFrameDocument(target, documentId, isFirefoxExtension()))
            throw new Error("页面已变化，请重新打开 Monica 后再填充。");
        const origin = new URL(target.url).origin;
        if (expectedOrigin && origin !== expectedOrigin)
            throw new Error("页面来源已变化，已阻止敏感信息填充。");
        if (!isSecureSensitivePageUrl(target.url))
            throw new Error("已阻止向不安全的 HTTP 页面填充敏感信息。");
        return { url: target.url, origin, documentId: target.documentId, frameId };
    }
    async function currentFieldRecord(tabId: number, target: SensitiveFillTarget, inlineSessionId?: string): Promise<BlockedFieldSignatureRecord | undefined> {
        const response = await chrome.tabs.sendMessage(tabId, { type: inlineSessionId ? "MONICA_INLINE_GET_FIELD_CONTEXT" : "MONICA_GET_FIELD_CONTEXT", sessionId: inlineSessionId }, { documentId: target.documentId }) as {
            ok?: boolean;
            context?: AutofillFieldContext;
        };
        if (!response?.ok || !response.context) {
            if (inlineSessionId)
                throw new Error("自动填充菜单已失效，请重新选择输入框。");
            return undefined;
        }
        const record = normalizeBlockedFieldSignature({ ...response.context, blockedAt: new Date().toISOString() });
        if (record.hostname !== new URL(target.url).hostname.toLowerCase() || record.frameScope !== (target.frameId === 0 ? "top-level" : "frame")) {
            throw new Error("页面字段上下文已变化，请重新打开 Monica。");
        }
        return record;
    }
    async function assertCurrentFieldAllowed(tabId: number, target: SensitiveFillTarget, blockedSignatures?: string[], inlineSessionId?: string): Promise<BlockedFieldSignatureRecord | undefined> {
        const record = await currentFieldRecord(tabId, target, inlineSessionId);
        if (record && (blockedSignatures ? blockedSignatures.includes(record.signature) : await deps.service.isAutofillFieldSignatureBlocked(record.signature)))
            throw new Error("当前字段已禁止使用 Monica 自动填充。");
        return record;
    }
    async function queryInlineAutofill(sender: chrome.runtime.MessageSender, sessionId: string): Promise<InlineAutofillResult> {
        const source = assertWebPageSender(sender);
        assertInlineSessionId(sessionId);
        if (!await readInlineAutofillEnabled())
            throw new Error("自动填充菜单已失效，请重新选择输入框。");
        const target = await resolveSensitiveFillTarget(source.tabId, source.frameId, source.documentId, source.origin);
        const field = await currentFieldRecord(source.tabId, target, sessionId);
        if (!field || !["username", "current-password", "totp"].includes(field.role))
            throw new Error("当前页面没有与此登录项对应的可填写字段。");
        const status = await deps.service.status();
        if (status === "uninitialized")
            return { sessionId, enabled: true, status, candidates: [], total: 0 };
        const context = await deps.service.readAutofillContext();
        const blocked = isAutofillBlocked(target.url, { blockedHosts: context.blockedHosts, saveBlockedHosts: [] }) || context.blockedFieldSignatures.includes(field.signature);
        const matches = blocked ? [] : matchingLogins(context.items.filter(isLoginItem), target.url)
            .filter(item => field.role !== "totp" || !context.locked && toMatchSummary(item).hasTotp);
        const result: InlineAutofillResult = {
            sessionId, enabled: !blocked, status: context.locked ? "locked" : "unlocked", total: matches.length,
            candidates: matches.slice(0, INLINE_SUGGESTION_LIMIT).map(item => ({
                id: item.id, title: item.title.slice(0, 160), username: item.username.slice(0, 160),
                ...(context.credentialIdentities[item.id] ? { credentialIdentity: context.credentialIdentities[item.id] } : {}),
                hasTotp: !context.locked && toMatchSummary(item).hasTotp, allowLockedAutofill: context.allowedIds.includes(item.id)
            }))
        };
        if (!await readInlineAutofillEnabled())
            result.enabled = false;
        return deps.service.dispatchAutofill(context, () => Promise.resolve(result));
    }
    async function fillLogin(itemId: string, tabId: number, frameId?: number, documentId?: string, expectedOrigin?: string, inlineSessionId?: string) {
        if (inlineSessionId && !await readInlineAutofillEnabled())
            throw new Error("自动填充菜单已失效，请重新选择输入框。");
        const target = await resolveSensitiveFillTarget(tabId, frameId ?? 0, documentId, expectedOrigin);
        const context = await deps.service.readAutofillContext(itemId);
        if (isAutofillBlocked(target.url, { blockedHosts: context.blockedHosts, saveBlockedHosts: [] }))
            throw new Error("此网站已禁止使用 Monica 自动填充。");
        const field = await assertCurrentFieldAllowed(tabId, target, context.blockedFieldSignatures, inlineSessionId);
        const item = context.items.find((candidate) => candidate.id === itemId);
        if (!item || !isLoginItem(item) || item.deletedAt || item.archivedAt)
            throw new Error("登录项不存在、已归档或已被删除。");
        if (loginMatchScore(item, target.url) <= 0)
            throw new Error("登录项与目标页面不匹配，已阻止填充。");
        const otp = context.locked ? undefined : await resolveLoginOtp(item, context.items);
        if (inlineSessionId && !await readInlineAutofillEnabled())
            throw new Error("自动填充菜单已失效，请重新选择输入框。");
        const response = (await deps.service.dispatchAutofill(context, () => chrome.tabs.sendMessage(tabId, {
            type: inlineSessionId ? "MONICA_FILL_INLINE_CREDENTIAL" : "MONICA_FILL_CREDENTIAL",
            sessionId: inlineSessionId,
            expectedOrigin: target.origin,
            credential: inlineSessionId && field?.role === "totp" ? { totpCode: otp?.code } : { username: item.username, password: item.password, totpCode: otp?.code, customFields: websiteAutofillFields(item.customFields) }
        }, { documentId: target.documentId }))) as {
            ok?: boolean;
            error?: string;
            filledUsername?: boolean;
            filledPassword?: boolean;
            filledTotp?: boolean;
            filledCustomFields?: number;
        };
        // A later custom control can fail after the code has already reached its field.
        // Acknowledge that successful code fill before reporting the remaining error.
        if (response?.filledTotp === true && otp?.usage && await deps.service.consumeHotp(otp.usage)) {
            void deps.dismissInlineMenus();
            void deps.afterRuntimeRequest({ type: 'VAULT_CONSUME_HOTP', usage: otp.usage }).catch(() => undefined);
        }
        if (!response?.ok)
            throw new Error(response?.error || "网页拒绝了填充请求。");
        return { filledUsername: Boolean(response.filledUsername), filledPassword: Boolean(response.filledPassword), filledTotp: Boolean(response.filledTotp), filledCustomFields: response.filledCustomFields || 0 };
    }
    type WalletItem = IdentityItem | BillingAddressItem | CardItem | PaymentAccountItem;
    async function listWalletItems(requestedKinds: WalletFillKind[]): Promise<WalletMatchSummary[]> {
        const kinds = new Set(requestedKinds.filter(isWalletKind));
        return (await deps.service.listItems()).filter(isWalletItem).filter((item) => kinds.has(item.kind)).map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            subtitle: walletSubtitle(item),
            favorite: item.favorite,
            sensitive: item.kind !== "billing-address"
        })).sort((left, right) => Number(right.favorite) - Number(left.favorite) || left.title.localeCompare(right.title));
    }
    async function fillWalletItem(itemId: string, tabId: number, frameId?: number, documentId?: string, expectedOrigin?: string): Promise<WalletFillResult> {
        const target = await resolveSensitiveFillTarget(tabId, frameId ?? 0, documentId, expectedOrigin);
        if (await deps.autofillBlocked(target.url))
            throw new Error("此网站已禁止使用 Monica 自动填充。");
        await assertCurrentFieldAllowed(tabId, target);
        const item = await deps.service.getItem(itemId);
        if (!item || !isWalletItem(item))
            throw new Error("证件或支付项目不存在或已被删除。");
        const response = await chrome.tabs.sendMessage(tabId, { type: "MONICA_FILL_WALLET", expectedOrigin: target.origin, wallet: walletPayload(item) }, { documentId: target.documentId }) as {
            ok?: boolean;
            error?: string;
            filledCount?: number;
            filledFields?: WalletFillResult["filledFields"];
        };
        if (!response?.ok)
            throw new Error(response?.error || "网页拒绝了证件或支付信息填充。");
        return { filledCount: Number(response.filledCount) || 0, filledFields: response.filledFields || [] };
    }
    function isWalletItem(item: VaultItem): item is WalletItem {
        return !item.deletedAt && !item.archivedAt && isWalletKind(item.kind) && !(item.kind === 'identity' && item.walletTemplate?.trim());
    }
    function isWalletKind(kind: string): kind is WalletFillKind {
        return kind === "identity" || kind === "billing-address" || kind === "card" || kind === "payment-account";
    }
    function walletSubtitle(item: WalletItem): string {
        if (item.kind === "card")
            return `${item.brand || "银行卡"}${lastFour(item.number)}`;
        if (item.kind === "identity")
            return `${documentLabel(item.documentType)}${lastFour(item.documentNumber)}`;
        if (item.kind === "billing-address")
            return [item.city, item.country].filter(Boolean).join(" · ") || "地址";
        return [item.provider, item.accountName || item.accountHolderName].filter(Boolean).join(" · ") || item.paymentType || "支付账户";
    }
    function lastFour(value: string): string {
        const suffix = value.replace(/\s+/g, "").slice(-4);
        return suffix ? ` · •••• ${suffix}` : "";
    }
    function documentLabel(type: IdentityItem["documentType"]): string {
        return ({ ID_CARD: "身份证", PASSPORT: "护照", DRIVER_LICENSE: "驾驶证", SOCIAL_SECURITY: "社会保障号", OTHER: "证件" } as const)[type];
    }
    function toMatchSummary(item: LoginItem, credentialIdentity?: LoginMatchSummary['credentialIdentity']): LoginMatchSummary {
        return { id: item.id, title: item.title, username: item.username, favorite: item.favorite, uris: item.uris, loginType: item.loginType, iconOrigin: loginWebsiteOrigin(item), ...customIconProjection(item), hasTotp: Boolean(item.totpSecret || item.boundTotpItemId), ...(credentialIdentity ? { credentialIdentity } : {}) };
    }
    const handlers: CommandHandlers<AutofillRuntimeRequest> = {
        "AUTOFILL_INLINE_QUERY": async (request, sender) => {
            return queryInlineAutofill(sender, request.sessionId);
        },
        "AUTOFILL_INLINE_FILL": async (request, sender) => {
            const source = assertWebPageSender(sender);
            assertInlineSessionId(request.sessionId);
            if (typeof request.itemId !== "string" || !request.itemId || request.itemId.length > 512)
                throw new Error("登录项标识无效。");
            return fillLogin(request.itemId, source.tabId, source.frameId, source.documentId, source.origin, request.sessionId);
        },
        "AUTOFILL_INLINE_OPEN": async (request, sender) => {
            const source = assertWebPageSender(sender);
            assertInlineSessionId(request.sessionId);
            if (!await readInlineAutofillEnabled())
                throw new Error("自动填充菜单已失效，请重新选择输入框。");
            const target = await resolveSensitiveFillTarget(source.tabId, source.frameId, source.documentId, source.origin);
            await currentFieldRecord(source.tabId, target, request.sessionId);
            await chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
            return { opened: true };
        },
        "VAULT_MATCH_LOGINS": async (request, sender) => {
            assertExtensionPage(sender);
            if (!isSecureSensitivePageUrl(request.pageUrl))
                return [];
            const context = await deps.service.readAutofillContext();
            if (isAutofillBlocked(request.pageUrl, { blockedHosts: context.blockedHosts, saveBlockedHosts: [] }))
                return [];
            if (request.fieldSignature && context.blockedFieldSignatures.includes(request.fieldSignature))
                return [];
            return matchingLogins(context.items.filter(isLoginItem), request.pageUrl)
                .map((item) => ({ ...toMatchSummary(item, context.credentialIdentities[item.id]), allowLockedAutofill: context.allowedIds.includes(item.id) }));
        },
        "VAULT_LIST_LOGIN_SUMMARIES": async (request, sender) => {
            assertExtensionPage(sender);
            const items = await deps.service.listItems();
            const identities = autofillCredentialIdentities(items);
            return items
                .filter((item): item is LoginItem => isLoginItem(item) && !item.deletedAt)
                .sort((left, right) => Number(right.favorite) - Number(left.favorite) || right.updatedAt.localeCompare(left.updatedAt))
                .map(item => toMatchSummary(item, identities[item.id]));
        },
        "VAULT_LOGIN_SECRET": async (request, sender) => {
            assertExtensionPage(sender);
            const item = (await deps.service.listItems()).find((candidate): candidate is LoginItem => candidate.id === request.itemId && isLoginItem(candidate) && !candidate.deletedAt);
            if (!item)
                throw new Error("登录项不存在或已删除。");
            return { value: request.field === "password" ? item.password : item.username };
        },
        "VAULT_MATCH_PASSKEYS": async (request, sender) => {
            assertExtensionPage(sender);
            const page = new URL(request.pageUrl);
            if (!isSecureSensitivePageUrl(page.toString()))
                return [];
            if (await deps.autofillBlocked(page.toString()))
                return [];
            const pageHost = normalizeRpId(page.hostname);
            return (await deps.service.readPasskeyContext()).items
                .filter((item) => !item.deletedAt && !item.archivedAt && passkeyMatchesPageHost(item, pageHost))
                .map((item): PasskeyMatchSummary => ({ id: item.id, title: item.title, userName: item.userName, userDisplayName: item.userDisplayName, sourceMode: item.sourceMode, availability: passkeyAvailability(item) as PasskeyMatchSummary["availability"], discoverable: item.discoverable, lastUsedAt: item.lastUsedAt, useCount: item.useCount || 0 }));
        },
        "VAULT_FILL_LOGIN": async (request, sender) => {
            assertExtensionPage(sender);
            return fillLogin(request.itemId, request.tabId, request.frameId, request.documentId, request.expectedOrigin);
        },
        "VAULT_LIST_WALLET_ITEMS": async (request, sender) => {
            assertExtensionPage(sender);
            if (await deps.autofillBlocked(request.pageUrl))
                return [];
            if (request.fieldSignature && await deps.service.isAutofillFieldSignatureBlocked(request.fieldSignature))
                return [];
            return listWalletItems(request.kinds);
        },
        "VAULT_FILL_WALLET": async (request, sender) => {
            assertExtensionPage(sender);
            return fillWalletItem(request.itemId, request.tabId, request.frameId, request.documentId, request.expectedOrigin);
        },
        "AUTOFILL_SITE_POLICY_GET": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.getAutofillSitePolicy();
        },
        "AUTOFILL_SITE_POLICY_SET": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.setAutofillSitePolicy(request.policy);
        },
        "AUTOFILL_FIELD_POLICY_LIST": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.listAutofillBlockedFieldSignatures();
        },
        "AUTOFILL_FIELD_POLICY_STATUS": async (request, sender) => {
            assertExtensionPage(sender);
            return (await deps.service.readAutofillContext()).blockedFieldSignatures.includes(request.signature);
        },
        "AUTOFILL_FIELD_POLICY_SET_CURRENT": async (request, sender) => {
            assertExtensionPage(sender);
            const target = await resolveSensitiveFillTarget(request.tabId, request.frameId ?? 0, request.documentId, request.expectedOrigin);
            const record = await currentFieldRecord(request.tabId, target);
            if (!record)
                throw new Error("当前没有可管理的自动填充字段。");
            if (request.blocked)
                return deps.service.addAutofillBlockedFieldSignature(record);
            await deps.service.removeAutofillBlockedFieldSignature(record.signature);
            return null;
        },
        "AUTOFILL_FIELD_POLICY_REMOVE": async (request, sender) => {
            assertManagerPage(sender);
            return deps.service.removeAutofillBlockedFieldSignature(request.signature);
        },
    };
    return { handlers };
}
export type AutofillRuntime = ReturnType<typeof createAutofillRuntime>;
