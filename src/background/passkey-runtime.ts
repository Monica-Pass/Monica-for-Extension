import { createProviderSyncRuntime } from './provider-sync-runtime';
import { type PasskeyItem, type ProviderAccount } from "../core/model";
import { currentFrameDocument } from '../runtime/document-target';
import { isFirefoxExtension } from '../runtime/browser-platform';
import type { PasskeyPromptContext, PasskeyRequest, PasskeyResult } from "../runtime/messages";
import { createAssertion, createPasskey, validateRpId } from "../passkey/webauthn-core";
import { validatePasskeyRequest } from "../passkey/request-policy";
import { selectPasskeyRegistrationAlgorithm } from "../passkey/registration-policy";
import { duplicatePasskeyCredentialIds, hasExcludedUsablePasskey, normalizeCredentialId, passkeyAvailability, passkeyRpIdsEqual, selectPasskeyCandidates } from "../passkey/source-policy";
import { assertPasskeyCounterNotRegressed, resolvePasskeyOwnership, samePasskeySigningIdentity } from "../passkey/ownership-policy";
import { prepareBitwardenAssertion } from "../passkey/bitwarden-assertion";
import { prepareFileAssertion } from "../passkey/file-assertion";
import { VaultLockedError } from "../security/secure-vault-service";
import type { PasskeyVerificationRuntime } from './passkey-verification-runtime';
import type { AutofillPolicyRuntime } from './autofill-policy-runtime';
import type { PasskeyJournal } from './passkey-journal';
import type { LiveViews } from './live-views';
import type { MdbxRuntime } from './mdbx-runtime';
import { PASSKEY_PENDING_PREFIX } from './passkey-state-types';
import { PendingPasskeyRequest } from './passkey-state-types';
import { assertWebPageSender } from './request-access';
import { PasskeyUnavailableError } from './passkey-errors';
import { PasskeyCancelledError } from './passkey-errors';
import { PasskeyExcludedError } from './passkey-errors';
import { PasskeyCompletionReceipt } from './passkey-state-types';
import { PasskeyCommitUnknownError } from './passkey-errors';
import { PASSKEY_COMPLETION_TTL_MS } from './passkey-state-types';
import type { CommandHandlers } from './command-router';
import type { ExtensionRequest } from '../runtime/messages';
interface Dependencies {
    verification: Pick<PasskeyVerificationRuntime, "assertPasskeyUserVerificationAvailable" | "passkeyRequiresUserVerification" | "passkeyUserVerification" | "verifyPasskeyUserIfRequired">;
    journal: Pick<PasskeyJournal, "cachedPendingPasskeyRequests" | "deletePasskeyCompletionReceipt" | "deletePendingPasskeyRequest" | "forgetCachedPendingPasskeyRequest" | "loadPasskeyCompletionReceipt" | "loadPendingPasskeyRequest" | "passkeyReceiptCommitState" | "passkeyReceiptMatchesSource" | "persistPasskeyCompletionReceipt" | "persistPendingPasskeyRequest" | "promotePasskeyCompletionReceipt" | "schedulePasskeyCompletionExpiry" | "schedulePasskeyExpiry">;
    autofillBlocked: AutofillPolicyRuntime["autofillBlocked"];
    bitwardenDurableSync: import("../providers/bitwarden/bitwarden-durable-sync").BitwardenDurableSyncCoordinator;
    providerOperations: Pick<import("./provider-operation-queue").ProviderOperationQueue, "run">;
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "activity" | "execute" | "pending" | "reconcile">;
    publishVaultChanged: LiveViews["publishVaultChanged"];
    service: import("../security/secure-vault-service").SecureVaultService;
    windowsHelloNativeClient: Pick<MdbxRuntime["windowsHelloNativeClient"], "verifyWindowsHello">;
}
export type PasskeyRuntimeRequest = Extract<ExtensionRequest, {
    type: "PASSKEY_BEGIN" | "PASSKEY_UNLOCK_CONTINUE" | "PASSKEY_ACCEPT" | "PASSKEY_DISMISS";
}>;
export function createPasskeyRuntime(deps: Dependencies) {
    const processingPasskeyRequests = new Set<string>();
    const committingPasskeyRequests = new Set<string>();
    const cancelledPasskeyRequests = new Set<string>();
    const cancellingPasskeyRequests = new Set<string>();
    const passkeySyncControllers = new Map<string, AbortController>();
    async function cancelPendingPasskeyRequest(candidateId: string): Promise<boolean> {
        if (committingPasskeyRequests.has(candidateId))
            return false;
        passkeySyncControllers.get(candidateId)?.abort(new DOMException("Passkey 请求已取消", "AbortError"));
        deps.verification.passkeyUserVerification.cancelCandidate(candidateId);
        if (processingPasskeyRequests.has(candidateId)) {
            cancelledPasskeyRequests.add(candidateId);
            await Promise.allSettled([deps.journal.deletePendingPasskeyRequest(candidateId), deps.journal.deletePasskeyCompletionReceipt(candidateId)]);
            return true;
        }
        if (cancellingPasskeyRequests.has(candidateId))
            return true;
        cancellingPasskeyRequests.add(candidateId);
        try {
            const receipt = await deps.journal.loadPasskeyCompletionReceipt(candidateId);
            if (committingPasskeyRequests.has(candidateId))
                return false;
            if (receipt) {
                const commitState = await deps.journal.passkeyReceiptCommitState(receipt);
                if (commitState !== "not-committed") {
                    if (commitState === "committed")
                        await deps.journal.promotePasskeyCompletionReceipt(receipt);
                    return false;
                }
            }
            if (receipt)
                await deps.journal.deletePasskeyCompletionReceipt(candidateId);
            await deps.journal.deletePendingPasskeyRequest(candidateId);
            return true;
        }
        finally {
            cancellingPasskeyRequests.delete(candidateId);
        }
    }
    async function clearPendingPasskeyRequests(preserveUnlockRequests = false): Promise<void> {
        if (!preserveUnlockRequests)
            deps.verification.passkeyUserVerification.cancelAll();
        for (const controller of passkeySyncControllers.values())
            controller.abort(new DOMException("密码库已锁定", "AbortError"));
        const stored = await chrome.storage.session.get(null);
        const pendingById = new Map(deps.journal.cachedPendingPasskeyRequests().map(pending => [pending.id, pending]));
        for (const [key, value] of Object.entries(stored)) {
            if (!key.startsWith(PASSKEY_PENDING_PREFIX))
                continue;
            const pending = value as PendingPasskeyRequest | undefined;
            if (pending?.id && pending.expiresAt > Date.now())
                pendingById.set(pending.id, pending);
        }
        const cancelled: string[] = [];
        const keep = (id: string) => preserveUnlockRequests && pendingById.get(id)?.unlockRequired === true && pendingById.get(id)!.expiresAt > Date.now();
        for (const candidateId of processingPasskeyRequests) {
            if (keep(candidateId))
                continue;
            if (!committingPasskeyRequests.has(candidateId)) {
                cancelledPasskeyRequests.add(candidateId);
                cancelled.push(candidateId);
            }
        }
        await Promise.allSettled(cancelled.map((candidateId) => deps.journal.deletePasskeyCompletionReceipt(candidateId)));
        for (const id of pendingById.keys()) {
            if (keep(id))
                continue;
            deps.journal.forgetCachedPendingPasskeyRequest(id);
            deps.verification.passkeyUserVerification.cancelCandidate(id);
        }
        const keys = Object.keys(stored).filter((key) => key.startsWith(PASSKEY_PENDING_PREFIX) && !keep(key.slice(PASSKEY_PENDING_PREFIX.length)));
        if (keys.length)
            await chrome.storage.session.remove(keys);
        const cancelledPending: PendingPasskeyRequest[] = [];
        for (const pending of pendingById.values()) {
            if (keep(pending.id))
                continue;
            if (committingPasskeyRequests.has(pending.id))
                continue;
            const receipt = await deps.journal.loadPasskeyCompletionReceipt(pending.id);
            if (receipt) {
                const commitState = await deps.journal.passkeyReceiptCommitState(receipt);
                if (commitState !== "not-committed") {
                    if (commitState === "committed")
                        await deps.journal.promotePasskeyCompletionReceipt(receipt);
                    continue;
                }
            }
            cancelledPending.push(pending);
        }
        await Promise.allSettled(cancelledPending.map((pending) => chrome.tabs.sendMessage(pending.tabId, { type: "MONICA_CANCEL_PASSKEY", candidateId: pending.id }, { documentId: pending.documentId })));
    }
    async function beginPasskeyRequest(request: PasskeyRequest, sender: chrome.runtime.MessageSender, resumed?: PendingPasskeyRequest): Promise<PasskeyPromptContext> {
        request = validatePasskeyRequest(request);
        const source = assertWebPageSender(sender);
        const rpId = validateRpId(source.origin, request.rpId);
        const status = await deps.service.status();
        const id = resumed?.id || crypto.randomUUID();
        const expiresAt = resumed?.expiresAt || Date.now() + (request.timeoutMs || 120000);
        if (status === "uninitialized")
            throw new PasskeyUnavailableError("请先设置 Monica 密码库。");
        if (await deps.autofillBlocked(source.url))
            throw new Error("此网站已禁止使用 Monica 自动填充和 Passkey。");
        if (status !== "unlocked") {
            if (resumed)
                throw new PasskeyCancelledError("密码库已锁定，Passkey 请求已取消。");
            const method = await deps.verification.assertPasskeyUserVerificationAvailable() === "master-password" ? "master-password" : "windows-hello";
            const pending: PendingPasskeyRequest = { id, request, tabId: source.tabId, frameId: source.frameId, documentId: source.documentId, origin: source.origin, rpId, expiresAt, matches: [], saveTargets: [], unlockRequired: true };
            await assertPasskeyDocumentCurrent(pending);
            await deps.journal.persistPendingPasskeyRequest(pending);
            deps.journal.schedulePasskeyExpiry(id, expiresAt);
            return { candidateId: id, operation: request.operation, rpId, rpName: request.operation === "create" ? request.rpName : rpId, origin: source.origin, userName: "", credentials: [], saveTargets: [], expiresAt, unlockRequired: true, userVerificationRequired: true, userVerificationMethod: method };
        }
        if (deps.verification.passkeyRequiresUserVerification(request))
            await deps.verification.assertPasskeyUserVerificationAvailable();
        let state = await deps.service.readPasskeyContext();
        let passkeys = state.items.filter((item): item is PasskeyItem => item.kind === "passkey" && !item.deletedAt && passkeyRpIdsEqual(item.rpId, rpId));
        if (request.operation === "get") {
            const candidates = selectPasskeyCandidates(passkeys, rpId, request.allowCredentialIds);
            const positiveSources = new Set(candidates.filter(item => item.signCount > 0 || (item.signCountHighWaterMark ?? 0) > 0).flatMap(item => item.providerRefs.map(reference => reference.providerId)));
            const refreshAccounts = state.providers.filter(account => account.kind === "bitwarden" && account.enabled && (!candidates.length || positiveSources.has(account.id)));
            for (const account of refreshAccounts) {
                if (deps.providerSync.activity.isBusy(account.id))
                    continue;
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(new DOMException("同步超时", "TimeoutError")), 20000);
                deps.providerSync.activity.reserve(account.id, controller);
                try {
                    await deps.bitwardenDurableSync.synchronize(account, controller.signal, { readOnly: true });
                }
                catch (error) {
                    // A cached zero-counter credential remains available offline. Positive-counter
                    // selection will require a successful refresh before it can sign.
                    await deps.service.markProviderSyncFailure(account.id, error instanceof Error ? error.message : "Bitwarden 同步失败。").catch(() => undefined);
                }
                finally {
                    clearTimeout(timeout);
                    deps.providerSync.activity.release(account.id, controller);
                }
            }
            if (refreshAccounts.length) {
                state = await deps.service.readPasskeyContext();
                passkeys = state.items.filter((item): item is PasskeyItem => item.kind === "passkey" && !item.deletedAt && passkeyRpIdsEqual(item.rpId, rpId));
            }
        }
        const saveTargets = state.providers
            .filter((provider): provider is ProviderAccount & {
            kind: "local" | "bitwarden" | "mdbx2" | "keepass";
        } => provider.enabled && (provider.kind === "local" || provider.kind === "bitwarden" || provider.kind === "mdbx2" || provider.kind === "keepass"))
            .filter(provider => request.operation !== "create" || selectPasskeyRegistrationAlgorithm(request.algorithms, provider.kind) !== undefined)
            .map((provider) => ({ providerId: provider.id, name: provider.name, kind: provider.kind }));
        const configuredTarget = saveTargets.find((provider) => provider.providerId === state.settings.defaultProviderId);
        const defaultSaveTarget = configuredTarget || saveTargets.find((provider) => provider.kind === "local") || saveTargets[0];
        let matches: PasskeyItem[] = [];
        if (request.operation === "create") {
            if (!request.rpName || !request.userName || !request.userId)
                throw new Error("Passkey 注册请求缺少用户或网站信息。");
            if (!saveTargets.length)
                throw new PasskeyUnavailableError("所选 Passkey 保存位置不可用。");
            if (hasExcludedUsablePasskey(passkeys, rpId, request.excludeCredentialIds))
                throw new PasskeyExcludedError("网站已排除此账户现有的 Passkey。");
        }
        else {
            matches = selectPasskeyCandidates(passkeys, rpId, request.allowCredentialIds);
            if (!matches.length)
                throw new PasskeyUnavailableError("Monica 中没有可用于此网站的 Passkey。");
        }
        const pending: PendingPasskeyRequest = { id, request, tabId: source.tabId, frameId: source.frameId, documentId: source.documentId, origin: source.origin, rpId, expiresAt, matches: matches.map((item) => item.id), saveTargets: request.operation === "create" ? saveTargets : [], defaultSaveTargetId: request.operation === "create" ? defaultSaveTarget?.providerId : undefined, unlockSessionId: resumed?.unlockSessionId };
        await assertPasskeyDocumentCurrent(pending);
        await deps.journal.persistPendingPasskeyRequest(pending);
        deps.journal.schedulePasskeyExpiry(id, expiresAt);
        const duplicateCredentialIds = duplicatePasskeyCredentialIds(state.items.filter((item): item is PasskeyItem => item.kind === "passkey" && !item.deletedAt));
        return {
            candidateId: id,
            operation: request.operation,
            rpId,
            rpName: request.operation === "create" ? request.rpName : matches[0]?.rpName || rpId,
            origin: source.origin,
            userName: request.operation === "create" ? request.userName : matches[0]?.userName || "",
            userDisplayName: request.operation === "create" ? request.userDisplayName : matches[0]?.userDisplayName,
            userVerificationRequired: deps.verification.passkeyRequiresUserVerification(request) || matches.some(item => item.userVerificationRequired),
            userVerificationMethod: await deps.service.protectionModeForRuntime() === "master-password" ? "master-password" : "windows-hello",
            userVerified: Boolean(pending.unlockSessionId && pending.unlockSessionId === await deps.service.passkeySessionId()),
            saveTargets: request.operation === "create" ? saveTargets.map((target) => ({ providerId: target.providerId, name: target.name, sourceMode: target.kind === "bitwarden" ? "bitwarden" : "browser-local" })) : [],
            defaultSaveTargetId: request.operation === "create" ? defaultSaveTarget?.providerId : undefined,
            credentials: matches.map((item) => {
                const provider = item.providerRefs[0]
                    ? state.providers.find((candidate) => candidate.id === item.providerRefs[0].providerId)
                    : undefined;
                return {
                    itemId: item.id,
                    title: item.title,
                    userName: item.userName,
                    userDisplayName: item.userDisplayName,
                    sourceMode: provider?.kind === "bitwarden" ? "bitwarden" : "browser-local",
                    providerName: provider?.name || "Monica 本地库",
                    isLocalSource: !provider || provider.kind === "local",
                    credentialConflict: duplicateCredentialIds.has(normalizeCredentialId(item.credentialId)),
                    userVerificationRequired: item.userVerificationRequired === true,
                    useCount: item.useCount || 0,
                    lastUsedAt: item.lastUsedAt
                };
            }),
            expiresAt
        };
    }
    async function unlockAndContinuePasskeyRequest(candidateId: string, sender: chrome.runtime.MessageSender): Promise<PasskeyPromptContext> {
        const source = assertWebPageSender(sender);
        const pending = await deps.journal.loadPendingPasskeyRequest(candidateId);
        if (!pending || !deps.journal.passkeyReceiptMatchesSource(pending, source))
            throw new PasskeyCancelledError("Passkey 请求已过期或来源不匹配。");
        if (processingPasskeyRequests.has(candidateId))
            throw new Error("Passkey 请求正在处理中。");
        processingPasskeyRequests.add(candidateId);
        try {
            await assertPasskeyDocumentCurrent(pending);
            if (await deps.autofillBlocked(source.url))
                throw new PasskeyCancelledError("此网站已禁止使用 Monica 自动填充和 Passkey。");
            if (pending.unlockRequired) {
                const binding = await deps.verification.assertPasskeyUserVerificationAvailable();
                await deps.verification.passkeyUserVerification.request({ candidateId, operation: pending.request.operation, rpId: pending.rpId, origin: pending.origin, accountName: "", expiresAt: pending.expiresAt, unlockRequired: true, method: binding === "master-password" ? "master-password" : "windows-hello" }, async (password, assertActive) => {
                    await assertPasskeyDocumentCurrent(pending);
                    if (await deps.autofillBlocked(source.url))
                        throw new PasskeyCancelledError("此网站已禁止使用 Monica 自动填充和 Passkey。");
                    const guard = () => {
                        assertActive();
                        if (cancelledPasskeyRequests.has(candidateId))
                            throw new PasskeyCancelledError("Passkey 请求已取消。");
                    };
                    if (binding === "master-password") {
                        if (await deps.service.protectionModeForRuntime() !== "master-password")
                            throw new PasskeyCancelledError("密码库保护方式已变化。");
                        await deps.service.unlock(password, guard);
                    }
                    else {
                        if (await deps.service.windowsHelloBindingIdForRuntime() !== binding)
                            throw new PasskeyCancelledError("密码库保护方式已变化。");
                        await deps.service.unlockWithWindowsHello((bindingId, challenge) => deps.windowsHelloNativeClient.verifyWindowsHello(bindingId, challenge).then(result => {
                            if (!result.verified)
                                throw new Error("Windows Hello 未确认用户身份。");
                        }), guard);
                    }
                    guard();
                    pending.unlockSessionId = await deps.service.passkeySessionId();
                    if (!pending.unlockSessionId)
                        throw new PasskeyCancelledError("密码库已锁定，Passkey 请求已取消。");
                });
                await assertPasskeyDocumentCurrent(pending);
                deps.publishVaultChanged();
                void deps.providerSync.reconcile().catch(() => undefined);
            }
            return await beginPasskeyRequest(pending.request, sender, pending);
        }
        catch (error) {
            await deps.journal.deletePendingPasskeyRequest(candidateId);
            if (error instanceof PasskeyUnavailableError || error instanceof PasskeyExcludedError)
                throw error;
            throw new PasskeyCancelledError(error instanceof Error ? error.message : "Passkey 身份验证未完成。");
        }
        finally {
            processingPasskeyRequests.delete(candidateId);
            cancelledPasskeyRequests.delete(candidateId);
        }
    }
    async function acceptPasskeyRequest(candidateId: string, itemId: string | undefined, providerId: string | undefined, sender: chrome.runtime.MessageSender): Promise<PasskeyResult> {
        const source = assertWebPageSender(sender);
        if (await deps.autofillBlocked(source.url))
            throw new Error("此网站已禁止使用 Monica 自动填充和 Passkey。");
        if (cancellingPasskeyRequests.has(candidateId))
            throw new PasskeyCancelledError("Passkey 请求已取消。");
        if (processingPasskeyRequests.has(candidateId))
            throw new Error("Passkey 请求正在处理中。");
        processingPasskeyRequests.add(candidateId);
        let pending: PendingPasskeyRequest | undefined;
        let preparedReceipt: PasskeyCompletionReceipt | undefined;
        let commitSucceeded = false;
        let lockedProviderId: string | undefined;
        let syncController: AbortController | undefined;
        try {
            const existingReceipt = await deps.journal.loadPasskeyCompletionReceipt(candidateId);
            if (existingReceipt) {
                if (!deps.journal.passkeyReceiptMatchesSource(existingReceipt, source))
                    throw new Error("Passkey 请求已过期或来源不匹配。");
                const commitState = await deps.journal.passkeyReceiptCommitState(existingReceipt);
                if (commitState === "committed") {
                    await deps.journal.promotePasskeyCompletionReceipt(existingReceipt);
                    await deps.journal.deletePendingPasskeyRequest(candidateId).catch(() => undefined);
                    return existingReceipt.result;
                }
                if (commitState === "unknown")
                    throw new PasskeyCommitUnknownError("密码库已锁定，暂时无法确认 Passkey 是否已保存。");
                await deps.journal.deletePasskeyCompletionReceipt(candidateId);
            }
            pending = await deps.journal.loadPendingPasskeyRequest(candidateId);
            if (!pending || pending.expiresAt <= Date.now() || pending.tabId !== source.tabId || pending.frameId !== source.frameId || pending.documentId !== source.documentId || pending.origin !== source.origin)
                throw new Error("Passkey 请求已过期或来源不匹配。");
            const activePending = pending;
            if (cancelledPasskeyRequests.has(candidateId))
                throw new PasskeyCancelledError("Passkey 请求已取消。");
            if ((await deps.service.status()) !== "unlocked")
                throw new VaultLockedError("密码库已锁定。");
            if (cancelledPasskeyRequests.has(candidateId))
                throw new PasskeyCancelledError("Passkey 请求已取消。");
            if (activePending.request.operation === "create") {
                const target = activePending.saveTargets.find((candidate) => candidate.providerId === (providerId || activePending.defaultSaveTargetId));
                if (!target)
                    throw new Error("所选 Passkey 保存位置不可用。");
                const algorithm = selectPasskeyRegistrationAlgorithm(activePending.request.algorithms, target.kind);
                if (algorithm === undefined)
                    throw new Error("不支持此 Passkey 签名算法。");
                const userVerified = await deps.verification.verifyPasskeyUserIfRequired(activePending);
                await assertPasskeyDocumentCurrent(activePending);
                // Android and Bitwarden both understand UUID credential IDs. The WebAuthn response
                // still contains their original bytes; existing credential IDs are never rewritten.
                const created = await createPasskey({ ...activePending.request, algorithms: [algorithm], origin: activePending.origin, rpId: activePending.rpId, userVerified,
                    credentialIdFormat: target.kind === "bitwarden" ? "uuid" : undefined });
                if (cancelledPasskeyRequests.has(candidateId))
                    throw new PasskeyCancelledError("Passkey 请求已取消。");
                const liveState = await deps.service.readPasskeyContext();
                const liveTarget = liveState.providers.find((candidate) => candidate.id === target.providerId && candidate.enabled && candidate.kind === target.kind);
                if (!liveTarget)
                    throw new Error("所选 Passkey 保存位置已变化，请重新发起注册。");
                const currentPasskeys = liveState.items.filter((item): item is PasskeyItem => item.kind === "passkey" && !item.deletedAt && passkeyRpIdsEqual(item.rpId, activePending.rpId));
                if (hasExcludedUsablePasskey(currentPasskeys, activePending.rpId, activePending.request.excludeCredentialIds)) {
                    await deps.journal.deletePendingPasskeyRequest(candidateId);
                    throw new PasskeyExcludedError("网站已排除此账户现有的 Passkey。");
                }
                const now = new Date().toISOString();
                const bitwarden = target.kind === "bitwarden";
                const item: PasskeyItem = { id: candidateId, kind: "passkey", title: activePending.request.rpName || activePending.rpId, favorite: false, notes: "", createdAt: now, updatedAt: now, providerRefs: target.kind === "local" ? [] : [{ providerId: target.providerId }], credentialId: created.credentialId, rpId: created.rpId, rpName: activePending.request.rpName, userHandle: activePending.request.userId, userName: activePending.request.userName, userDisplayName: activePending.request.userDisplayName, algorithm: created.response.publicKeyAlgorithm, keyAlgorithm: created.response.publicKeyAlgorithm === -7 ? "ECDSA" : "RSA", publicKey: created.publicKeySpki, privateKeyPkcs8: created.privateKeyPkcs8, signCount: 0, discoverable: activePending.request.discoverable === true, userVerificationRequired: activePending.request.userVerificationRequired === true, transports: ["internal"], aaguid: "", lastUsedAt: now, useCount: 0, passkeyMode: target.kind === "keepass" ? "KEEPASS_COMPAT" : "BW_COMPAT", sourceMode: bitwarden ? "bitwarden" : "browser-local" };
                const result: PasskeyResult = { operation: "create", id: created.credentialId, rawId: created.credentialId, response: created.response, clientExtensionResults: activePending.request.credProps ? { credProps: { rk: item.discoverable } } : {} };
                preparedReceipt = {
                    id: candidateId,
                    tabId: activePending.tabId,
                    frameId: activePending.frameId,
                    documentId: activePending.documentId,
                    origin: activePending.origin,
                    operation: "create",
                    itemId: item.id,
                    result,
                    status: "prepared",
                    expiresAt: Date.now() + PASSKEY_COMPLETION_TTL_MS
                };
                await deps.journal.persistPasskeyCompletionReceipt(preparedReceipt);
                if (cancelledPasskeyRequests.has(candidateId))
                    throw new PasskeyCancelledError("Passkey 请求已取消。");
                committingPasskeyRequests.add(candidateId);
                await deps.service.upsertItem(item);
                commitSucceeded = true;
                await deps.journal.promotePasskeyCompletionReceipt(preparedReceipt);
                deps.journal.schedulePasskeyCompletionExpiry(candidateId, preparedReceipt.expiresAt);
                await deps.journal.deletePendingPasskeyRequest(candidateId).catch(() => undefined);
                return result;
            }
            const liveState = await deps.service.readPasskeyContext();
            const livePasskeys = liveState.items.filter((candidate): candidate is PasskeyItem => candidate.kind === "passkey" && !candidate.deletedAt);
            const liveMatches = selectPasskeyCandidates(livePasskeys, activePending.rpId, activePending.request.allowCredentialIds)
                .filter((candidate) => activePending.matches.includes(candidate.id));
            if (!itemId && duplicatePasskeyCredentialIds(liveMatches).size) {
                throw new Error("检测到重复的 Passkey 凭据 ID，请明确选择密码源。");
            }
            const selectedId = itemId || activePending.matches[0];
            let item = liveMatches.find((candidate) => candidate.id === selectedId);
            if (!item)
                throw new Error("所选 Passkey 不属于当前请求，或密码库内容已经变化。");
            if (passkeyAvailability(item, activePending.rpId) !== "ready" || !item.privateKeyPkcs8)
                throw new Error("所选 Passkey 没有可用私钥或算法不受支持。");
            const userVerified = await deps.verification.verifyPasskeyUserIfRequired(activePending, item.userVerificationRequired, item.userName || item.userDisplayName);
            await assertPasskeyDocumentCurrent(activePending);
            const currentContext = await deps.service.readPasskeyContext();
            const currentItem = currentContext.items.find(candidate => candidate.id === selectedId);
            if (!currentItem || currentItem.kind !== "passkey" || currentItem.deletedAt || currentItem.archivedAt || !samePasskeySigningIdentity(item, currentItem)) {
                throw new PasskeyCancelledError("身份验证期间 Passkey 已变化，请重新发起登录。");
            }
            item = currentItem;
            const ownership = resolvePasskeyOwnership(item, currentContext.providers);
            let signatureCounter = 0;
            if (ownership.kind === "bitwarden") {
                assertPasskeyCounterNotRegressed(item);
                if (item.signCount > 0) {
                    syncController = new AbortController();
                    passkeySyncControllers.set(candidateId, syncController);
                    // A background poll should not make a positive-counter login fail.
                    // Recheck after each awaited sync, while retaining cancellation/expiry.
                    for (;;) {
                        await assertPasskeyDocumentCurrent(activePending);
                        syncController.signal.throwIfAborted();
                        const running = deps.providerSync.pending(ownership.account.id);
                        if (!running)
                            break;
                        await waitForPasskeySyncCompletion(running, syncController.signal);
                    }
                    if (deps.providerSync.activity.isBusy(ownership.account.id))
                        throw new Error("此密码源正在处理另一笔 Passkey 登录，请稍后重试。");
                    lockedProviderId = ownership.account.id;
                    deps.providerSync.activity.reserve(lockedProviderId, syncController);
                    item = await prepareBitwardenAssertion(item, deps.service, deps.bitwardenDurableSync, () => assertPasskeyDocumentCurrent(activePending), syncController.signal);
                }
                signatureCounter = item.signCount;
            }
            else if (ownership.kind === "local") {
                item = await deps.service.advanceLocalPasskeyCounter(item);
                signatureCounter = item.signCount;
            }
            else {
                assertPasskeyCounterNotRegressed(item);
                if (item.signCount > 0) {
                    const selected = item;
                    syncController = new AbortController();
                    passkeySyncControllers.set(candidateId, syncController);
                    const signal = syncController.signal;
                    item = await deps.providerOperations.run(ownership.account.id, () => prepareFileAssertion(selected, deps.service, (account, signal) => deps.providerSync.execute(account.id, {}, signal), () => assertPasskeyDocumentCurrent(activePending), signal));
                }
                signatureCounter = item.signCount;
            }
            await assertPasskeyDocumentCurrent(activePending);
            const assertion = await createAssertion({ origin: activePending.origin, challenge: activePending.request.challenge, rpId: activePending.rpId, credentialId: item.credentialId, userHandle: item.userHandle, privateKeyPkcs8: item.privateKeyPkcs8!, algorithm: item.algorithm, signCount: signatureCounter, backupEligible: item.backupEligible, backupState: item.backupState, userVerified });
            if (cancelledPasskeyRequests.has(candidateId))
                throw new PasskeyCancelledError("Passkey 请求已取消。");
            const id = normalizeCredentialId(item.credentialId);
            const result: PasskeyResult = { operation: "get", id, rawId: id, response: assertion.response };
            preparedReceipt = {
                id: candidateId,
                tabId: activePending.tabId,
                frameId: activePending.frameId,
                documentId: activePending.documentId,
                origin: activePending.origin,
                operation: "get",
                itemId: item.id,
                result,
                status: "prepared",
                expiresAt: Date.now() + PASSKEY_COMPLETION_TTL_MS
            };
            await deps.journal.persistPasskeyCompletionReceipt(preparedReceipt);
            if (cancelledPasskeyRequests.has(candidateId))
                throw new PasskeyCancelledError("Passkey 请求已取消。");
            committingPasskeyRequests.add(candidateId);
            await deps.service.recordPasskeyUse(item.id, new Date().toISOString(), item);
            await assertPasskeyDocumentCurrent(activePending);
            commitSucceeded = true;
            await deps.journal.promotePasskeyCompletionReceipt(preparedReceipt);
            deps.journal.schedulePasskeyCompletionExpiry(candidateId, preparedReceipt.expiresAt);
            await deps.journal.deletePendingPasskeyRequest(candidateId).catch(() => undefined);
            return result;
        }
        finally {
            passkeySyncControllers.delete(candidateId);
            if (lockedProviderId && syncController)
                deps.providerSync.activity.release(lockedProviderId, syncController);
            if (preparedReceipt && !commitSucceeded)
                await deps.journal.deletePasskeyCompletionReceipt(candidateId).catch(() => undefined);
            processingPasskeyRequests.delete(candidateId);
            committingPasskeyRequests.delete(candidateId);
            cancelledPasskeyRequests.delete(candidateId);
            if (pending?.expiresAt && pending.expiresAt <= Date.now())
                await deps.journal.deletePendingPasskeyRequest(candidateId).catch(() => undefined);
        }
    }
    interface PasskeyDismissResult {
        cancelled: boolean;
        pending?: boolean;
        result?: PasskeyResult;
    }
    function waitForPasskeySyncCompletion(operation: Promise<unknown>, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        return new Promise((resolve, reject) => {
            const aborted = () => { cleanup(); reject(signal.reason); };
            const cleanup = () => signal.removeEventListener("abort", aborted);
            signal.addEventListener("abort", aborted, { once: true });
            // A failed background check does not authorize signing: the assertion path
            // still performs its own authoritative refresh and confirmed counter write.
            void operation.catch(() => undefined).then(() => { cleanup(); resolve(); });
        });
    }
    async function assertPasskeyDocumentCurrent(pending: PendingPasskeyRequest): Promise<void> {
        if (cancelledPasskeyRequests.has(pending.id) || pending.expiresAt <= Date.now())
            throw new PasskeyCancelledError("Passkey 请求已取消或过期。");
        const frame = await chrome.webNavigation.getFrame({ tabId: pending.tabId, frameId: pending.frameId });
        if (!currentFrameDocument(frame, pending.documentId, isFirefoxExtension()) || new URL(frame!.url).origin !== pending.origin)
            throw new PasskeyCancelledError("网站页面已变化，请重新发起 Passkey 登录。");
    }
    async function dismissPasskeyRequest(candidateId: string, sender: chrome.runtime.MessageSender): Promise<PasskeyDismissResult> {
        const source = assertWebPageSender(sender);
        if (committingPasskeyRequests.has(candidateId))
            return { cancelled: false, pending: true };
        const receipt = await deps.journal.loadPasskeyCompletionReceipt(candidateId);
        if (receipt && !deps.journal.passkeyReceiptMatchesSource(receipt, source))
            throw new Error("Passkey 请求来源不匹配。");
        if (receipt) {
            const commitState = await deps.journal.passkeyReceiptCommitState(receipt);
            if (commitState === "committed") {
                await deps.journal.promotePasskeyCompletionReceipt(receipt);
                return { cancelled: false, result: receipt.result };
            }
            if (commitState === "unknown")
                return { cancelled: false, pending: true };
        }
        const pending = await deps.journal.loadPendingPasskeyRequest(candidateId);
        if (pending && (pending.tabId !== source.tabId || pending.frameId !== source.frameId || pending.documentId !== source.documentId || pending.origin !== source.origin))
            throw new Error("Passkey 请求来源不匹配。");
        if (!receipt && !pending && !processingPasskeyRequests.has(candidateId) && !committingPasskeyRequests.has(candidateId))
            return { cancelled: true };
        const cancelled = await cancelPendingPasskeyRequest(candidateId);
        if (cancelled)
            return { cancelled: true };
        const completed = await deps.journal.loadPasskeyCompletionReceipt(candidateId);
        if (completed && deps.journal.passkeyReceiptMatchesSource(completed, source)) {
            const commitState = await deps.journal.passkeyReceiptCommitState(completed);
            if (commitState === "committed") {
                await deps.journal.promotePasskeyCompletionReceipt(completed);
                return { cancelled: false, result: completed.result };
            }
        }
        return { cancelled: false, pending: true };
    }
    function navigationCommitted(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): void {
        for (const pending of deps.journal.cachedPendingPasskeyRequests())
            if (pending.tabId === details.tabId && pending.frameId === details.frameId && pending.documentId !== details.documentId)
                void cancelPendingPasskeyRequest(pending.id).catch(() => undefined);
    }
    function tabRemoved(tabId: number): void {
        for (const pending of deps.journal.cachedPendingPasskeyRequests())
            if (pending.tabId === tabId)
                void cancelPendingPasskeyRequest(pending.id).catch(() => undefined);
    }
    const handlers: CommandHandlers<PasskeyRuntimeRequest> = {
        "PASSKEY_BEGIN": async (request, sender) => {
            return beginPasskeyRequest(request.request, sender);
        },
        "PASSKEY_UNLOCK_CONTINUE": async (request, sender) => {
            return unlockAndContinuePasskeyRequest(request.candidateId, sender);
        },
        "PASSKEY_ACCEPT": async (request, sender) => {
            return acceptPasskeyRequest(request.candidateId, request.itemId, request.providerId, sender);
        },
        "PASSKEY_DISMISS": async (request, sender) => {
            return dismissPasskeyRequest(request.candidateId, sender);
        },
    };
    return { cancelPendingPasskeyRequest, clearPendingPasskeyRequests, handlers, navigationCommitted, tabRemoved };
}
export type PasskeyRuntime = ReturnType<typeof createPasskeyRuntime>;
