import { isLoginItem, createLoginItem, type LoginItem, type ProviderAccount } from "../core/model";
import { loginMatchScore } from "../core/matching";
import { credentialSaveDecision, normalizedCredentialUsername } from "./credential-save-decision";
import type { CredentialCaptureInput, SavePromptContext, SavePromptProviderSummary } from "../runtime/messages";
import { isSecureSensitivePageUrl } from "../runtime/sender-policy";
import { VaultLockedError } from "../security/secure-vault-service";
import type { AutofillPolicyRuntime } from './autofill-policy-runtime';
import { assertWebPageSender } from './request-access';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    anyAutofillFieldSignatureBlocked: AutofillPolicyRuntime["anyAutofillFieldSignatureBlocked"];
    savePromptBlocked: AutofillPolicyRuntime["savePromptBlocked"];
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "getItem" | "getProvider" | "readState" | "status" | "upsertItem">;
}
export type CredentialRuntimeRequest = Extract<ExtensionRequest, {
    type: "CREDENTIAL_USERNAME_REMEMBER" | "CREDENTIAL_CAPTURE" | "CREDENTIAL_PENDING" | "CREDENTIAL_ACCEPT" | "CREDENTIAL_DISMISS";
}>;
export function createCredentialRuntime(deps: Dependencies) {
    const CAPTURE_TTL_MS = 60000;
    const USERNAME_CONTEXT_TTL_MS = 2 * 60000;
    interface PendingCredentialCapture extends CredentialCaptureInput {
        id: string;
        tabId: number;
        frameId: number;
        sourceOrigin: string;
        createdAt: number;
        expiresAt: number;
        existingItemId?: string;
        existingTitle?: string;
        existingItemIds: string[];
    }
    const pendingCredentialCaptures = new Map<string, PendingCredentialCapture>();
    interface PendingUsernameContext {
        tabId: number;
        frameId: number;
        documentId: string;
        origin: string;
        username: string;
        expiresAt: number;
    }
    const USERNAME_CONTEXT_PREFIX = "monica.credential.username.v1.";
    const pendingUsernameContexts = new Map<string, PendingUsernameContext>();
    function usernameContextStorageKey(source: {
        tabId: number;
        frameId: number;
        origin: string;
    }): string {
        return `${USERNAME_CONTEXT_PREFIX}${source.tabId}.${source.frameId}.${encodeURIComponent(source.origin)}`;
    }
    async function rememberCredentialUsername(usernameInput: string, sender: chrome.runtime.MessageSender): Promise<void> {
        const source = assertWebPageSender(sender);
        if (!isSecureSensitivePageUrl(source.url) || (await deps.service.status()) !== "unlocked")
            return;
        if (await deps.savePromptBlocked(source.url))
            return;
        const username = String(usernameInput || "").trim().slice(0, 1024);
        if (!username)
            return;
        const context: PendingUsernameContext = {
            tabId: source.tabId,
            frameId: source.frameId,
            documentId: source.documentId,
            origin: source.origin,
            username,
            expiresAt: Date.now() + USERNAME_CONTEXT_TTL_MS
        };
        const key = usernameContextStorageKey(source);
        pendingUsernameContexts.set(key, context);
        await chrome.storage.session.set({ [key]: context });
    }
    async function loadCredentialUsername(source: {
        tabId: number;
        frameId: number;
        documentId: string;
        origin: string;
    }): Promise<PendingUsernameContext | undefined> {
        const key = usernameContextStorageKey(source);
        const context = pendingUsernameContexts.get(key)
            || (await chrome.storage.session.get(key))[key] as PendingUsernameContext | undefined;
        if (!context
            || context.tabId !== source.tabId
            || context.frameId !== source.frameId
            || context.origin !== source.origin
            || context.expiresAt <= Date.now()) {
            pendingUsernameContexts.delete(key);
            if (context)
                await chrome.storage.session.remove(key);
            return undefined;
        }
        pendingUsernameContexts.set(key, context);
        return context;
    }
    async function deleteCredentialUsername(source: {
        tabId: number;
        frameId: number;
        origin: string;
    }): Promise<void> {
        const key = usernameContextStorageKey(source);
        pendingUsernameContexts.delete(key);
        await chrome.storage.session.remove(key);
    }
    async function clearPendingUsernameContexts(): Promise<void> {
        pendingUsernameContexts.clear();
        const stored = await chrome.storage.session.get(null);
        const keys = Object.keys(stored).filter((key) => key.startsWith(USERNAME_CONTEXT_PREFIX));
        if (keys.length)
            await chrome.storage.session.remove(keys);
    }
    async function captureCredentialCandidate(input: CredentialCaptureInput, sender: chrome.runtime.MessageSender): Promise<SavePromptContext | null> {
        const source = assertWebPageSender(sender);
        if ((await deps.service.status()) !== "unlocked")
            throw new VaultLockedError("密码库已锁定；请先解锁 Monica，再重新提交登录表单。");
        if (await deps.savePromptBlocked(source.url))
            throw new Error("此网站已禁止显示密码保存提示。");
        if (await deps.anyAutofillFieldSignatureBlocked(input.fieldSignatures))
            throw new Error("此表单包含已排除的自动填充字段，已禁止保存提示。");
        const submittedUsername = String(input.username || "").trim();
        const remembered = submittedUsername ? undefined : await loadCredentialUsername(source);
        let candidate: CredentialCaptureInput;
        try {
            candidate = validateCredentialCapture({
                ...input,
                username: submittedUsername || (remembered?.documentId !== source.documentId ? remembered?.username || "" : "")
            }, source.url);
        }
        finally {
            await deleteCredentialUsername(source);
        }
        purgeExpiredCaptures();
        const state = await deps.service.readState();
        const decision = credentialSaveDecision(candidate, state.items.filter(isLoginItem));
        if (decision.unchanged) {
            // A previous submission from this account may still be pending after an
            // edited password is reverted. Do not restore that stale update on navigation.
            for (const [id, pending] of pendingCredentialCaptures) {
                if (pending.tabId === source.tabId && pending.frameId === source.frameId
                    && pending.sourceOrigin === source.origin
                    && normalizedCredentialUsername(pending.username) === normalizedCredentialUsername(candidate.username))
                    pendingCredentialCaptures.delete(id);
            }
            if (source.frameId !== 0) {
                void chrome.tabs.sendMessage(source.tabId, { type: "MONICA_SHOW_SAVE_PROMPT", context: null }, { frameId: 0 }).catch(() => undefined);
            }
            return null;
        }
        const existingCandidates = decision.updateCandidates;
        const existing = existingCandidates.length === 1 ? existingCandidates[0] : undefined;
        const duplicate = [...pendingCredentialCaptures.values()].find((pending) => pending.tabId === source.tabId
            && pending.sourceOrigin === source.origin
            && pending.username === candidate.username
            && pending.password === candidate.password);
        const now = Date.now();
        const pending: PendingCredentialCapture = {
            ...candidate,
            id: duplicate?.id || crypto.randomUUID(),
            tabId: source.tabId,
            frameId: source.frameId,
            sourceOrigin: source.origin,
            createdAt: duplicate?.createdAt || now,
            expiresAt: now + CAPTURE_TTL_MS,
            existingItemId: existing?.id,
            existingTitle: existing?.title,
            existingItemIds: existingCandidates.map((item) => item.id)
        };
        pendingCredentialCaptures.set(pending.id, pending);
        scheduleCaptureExpiry(pending.id, pending.expiresAt);
        const context = savePromptContext(pending, state.providers, state.settings.defaultProviderId, state.items.filter(isLoginItem));
        if (source.frameId !== 0) {
            void chrome.tabs.sendMessage(source.tabId, { type: "MONICA_SHOW_SAVE_PROMPT", context }, { frameId: 0 }).catch(() => undefined);
        }
        return context;
    }
    async function pendingCredentialCandidate(sender: chrome.runtime.MessageSender): Promise<SavePromptContext | null> {
        const source = assertWebPageSender(sender);
        if (await deps.savePromptBlocked(source.url))
            return null;
        purgeExpiredCaptures();
        const pending = [...pendingCredentialCaptures.values()]
            .filter((candidate) => candidate.tabId === source.tabId && candidate.sourceOrigin === source.origin)
            .sort((left, right) => right.createdAt - left.createdAt)[0];
        if (!pending || (await deps.service.status()) !== "unlocked")
            return null;
        const state = await deps.service.readState();
        if (credentialSaveDecision(pending, state.items.filter(isLoginItem)).unchanged) {
            pendingCredentialCaptures.delete(pending.id);
            return null;
        }
        return savePromptContext(pending, state.providers, state.settings.defaultProviderId, state.items.filter(isLoginItem));
    }
    async function acceptCredentialCandidate(candidateId: string, requestedProviderId: string | undefined, requestedExistingItemId: string | undefined, sender: chrome.runtime.MessageSender) {
        const source = assertWebPageSender(sender);
        purgeExpiredCaptures();
        const pending = pendingCredentialCaptures.get(candidateId);
        if (!pending || pending.tabId !== source.tabId || (source.frameId !== pending.frameId && source.frameId !== 0))
            throw new Error("保存候选已过期，请重新提交表单。");
        if (await deps.savePromptBlocked(pending.pageUrl)) {
            pendingCredentialCaptures.delete(candidateId);
            throw new Error("此网站已禁止保存密码。");
        }
        if (await deps.anyAutofillFieldSignatureBlocked(pending.fieldSignatures)) {
            pendingCredentialCaptures.delete(candidateId);
            throw new Error("此表单包含已排除的自动填充字段，已禁止保存密码。");
        }
        if ((await deps.service.status()) !== "unlocked")
            throw new VaultLockedError("密码库已锁定，保存候选未写入。");
        let saved: LoginItem;
        let providerName = "Monica 本地库";
        const selectedExistingItemId = pending.existingItemId || requestedExistingItemId;
        if (requestedExistingItemId && !pending.existingItemIds.includes(requestedExistingItemId))
            throw new Error("所选更新目标不属于当前保存候选。");
        if (pending.existingItemId && requestedExistingItemId && requestedExistingItemId !== pending.existingItemId)
            throw new Error("当前保存候选只能更新已匹配的登录项。");
        if (selectedExistingItemId) {
            const existing = await deps.service.getItem(selectedExistingItemId);
            if (!existing || !isLoginItem(existing) || loginMatchScore(existing, pending.pageUrl) <= 0)
                throw new Error("待更新的登录项已不存在或网站不匹配。");
            saved = await deps.service.upsertItem({
                ...existing,
                username: pending.username.trim() || existing.username,
                password: pending.password
            }) as LoginItem;
            const firstReference = saved.providerRefs[0];
            if (firstReference)
                providerName = (await deps.service.getProvider(firstReference.providerId))?.name || providerName;
        }
        else {
            const state = await deps.service.readState();
            const providerId = requestedProviderId || state.settings.defaultProviderId;
            const provider = state.providers.find((candidate) => candidate.id === providerId && candidate.enabled);
            if (!provider)
                throw new Error("所选密码源不存在或已禁用。");
            providerName = provider.name;
            saved = await deps.service.upsertItem(createLoginItem({
                title: pending.pageTitle || new URL(pending.pageUrl).hostname,
                username: pending.username,
                password: pending.password,
                uris: [new URL(pending.pageUrl).origin],
                providerRefs: provider.kind === "local" ? [] : [{ providerId: provider.id }]
            })) as LoginItem;
        }
        pendingCredentialCaptures.delete(candidateId);
        return {
            action: selectedExistingItemId ? "updated" : "saved",
            itemId: saved.id,
            title: saved.title,
            providerName,
            isLocalSource: saved.providerRefs.length === 0,
            syncPending: saved.providerRefs.length > 0
        };
    }
    function dismissCredentialCandidate(candidateId: string, sender: chrome.runtime.MessageSender): void {
        const source = assertWebPageSender(sender);
        const pending = pendingCredentialCaptures.get(candidateId);
        if (pending?.tabId === source.tabId && (source.frameId === pending.frameId || source.frameId === 0))
            pendingCredentialCaptures.delete(candidateId);
    }
    function savePromptContext(pending: PendingCredentialCapture, providers: ProviderAccount[], defaultProviderId: string, logins: LoginItem[]): SavePromptContext {
        const summaries: SavePromptProviderSummary[] = providers.filter((provider) => provider.enabled).map((provider) => ({
            id: provider.id,
            name: provider.name,
            kind: provider.kind,
            isDefault: provider.id === defaultProviderId
        }));
        const updateTargets = pending.existingItemIds.flatMap((itemId) => {
            const item = logins.find((candidate) => candidate.id === itemId);
            if (!item)
                return [];
            const providerNames = item.providerRefs.map((reference) => providers.find((provider) => provider.id === reference.providerId)?.name).filter(Boolean);
            return [{ id: item.id, title: item.title, username: item.username, providerName: providerNames.join("、") || "Monica 本地库", isLocalSource: item.providerRefs.length === 0 }];
        });
        return {
            candidateId: pending.id,
            action: pending.existingItemId ? "update" : updateTargets.length > 1 ? "choose" : "save",
            title: pending.pageTitle,
            username: pending.username,
            host: new URL(pending.pageUrl).hostname,
            existingItemId: pending.existingItemId,
            existingTitle: pending.existingTitle,
            updateTargets,
            providers: summaries,
            defaultProviderId,
            expiresAt: pending.expiresAt
        };
    }
    function validateCredentialCapture(input: CredentialCaptureInput, senderUrl: string): CredentialCaptureInput {
        const page = new URL(input.pageUrl);
        const sender = new URL(senderUrl);
        if (!/^https?:$/.test(page.protocol) || page.origin !== sender.origin)
            throw new Error("凭据候选来源与当前页面不匹配。");
        if (!isSecureSensitivePageUrl(page.toString()))
            throw new Error("已阻止从不安全的 HTTP 页面保存密码。");
        const username = String(input.username || "").trim().slice(0, 1024);
        const password = String(input.password || "");
        if (!password || password.length > 8192)
            throw new Error("捕获的密码为空或过长。");
        const fieldSignatures = Array.isArray(input.fieldSignatures) ? [...new Set(input.fieldSignatures)] : [];
        if (fieldSignatures.length > 128 || fieldSignatures.some((signature) => typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)))
            throw new Error("表单字段签名无效或过多。");
        return {
            username,
            password,
            pageUrl: page.toString(),
            pageTitle: String(input.pageTitle || "").trim().slice(0, 200),
            captureKind: input.captureKind === "password-change" ? "password-change" : "login",
            fieldSignatures
        };
    }
    function purgeExpiredCaptures(): void {
        const now = Date.now();
        for (const [id, capture] of pendingCredentialCaptures)
            if (capture.expiresAt <= now)
                pendingCredentialCaptures.delete(id);
    }
    function scheduleCaptureExpiry(candidateId: string, expiresAt: number): void {
        setTimeout(() => {
            const candidate = pendingCredentialCaptures.get(candidateId);
            if (candidate && candidate.expiresAt <= Date.now())
                pendingCredentialCaptures.delete(candidateId);
        }, Math.max(0, expiresAt - Date.now()) + 50);
    }
    function clearCredentialCaptures(): void { pendingCredentialCaptures.clear(); }
    const handlers: CommandHandlers<CredentialRuntimeRequest> = {
        "CREDENTIAL_USERNAME_REMEMBER": async (request, sender) => {
            return rememberCredentialUsername(request.username, sender);
        },
        "CREDENTIAL_CAPTURE": async (request, sender) => {
            return captureCredentialCandidate(request.candidate, sender);
        },
        "CREDENTIAL_PENDING": async (request, sender) => {
            return pendingCredentialCandidate(sender);
        },
        "CREDENTIAL_ACCEPT": async (request, sender) => {
            return acceptCredentialCandidate(request.candidateId, request.providerId, request.existingItemId, sender);
        },
        "CREDENTIAL_DISMISS": async (request, sender) => {
            return dismissCredentialCandidate(request.candidateId, sender);
        },
    };
    return { clearCredentialCaptures, clearPendingUsernameContexts, handlers };
}
export type CredentialRuntime = ReturnType<typeof createCredentialRuntime>;
