import type { CommandExecutor } from './command-router';

import type { ExtensionRequest } from '../runtime/messages';

import { type ProviderAccount } from "../core/model";
import { ProviderRegistry, sameProviderBinding, type ProviderSyncContext, type ProviderSyncResult } from "../core/provider";
import { BitwardenClient } from "../providers/bitwarden/bitwarden-client";
import { BitwardenProvider } from "../providers/bitwarden/bitwarden-provider";
import { BitwardenDurableSyncCoordinator } from "../providers/bitwarden/bitwarden-durable-sync";
import { ProviderOperationQueue } from './provider-operation-queue';
import { KeePassProvider } from "../providers/keepass/keepass-provider";
import { KeePassDurableSyncCoordinator } from "../providers/keepass/keepass-durable-sync";
import { keePassRemoteFailureInfo, type KeePassRemoteFailureInfo } from "../providers/keepass/keepass-remote-session";
import { isRemoteKeePassSource } from "../providers/keepass/keepass-source";
import { createProviderDiagnostic } from "../providers/provider-diagnostics";
import { ProviderTransportError } from "../providers/provider-transport";
import { ChromeVaultSessionStore } from "../security/vault-session";
import { SecureVaultService, VaultLockedError } from "../security/secure-vault-service";
import { AutomaticSyncScheduler, mdbx2AutomaticSyncEligible } from "./automatic-sync";
import { BitwardenNotifications, bitwardenNotificationSession } from "../providers/bitwarden/bitwarden-notifications";
import { readAutomaticSyncEnabled } from "../providers/sync-preferences";
import { ProviderSyncActivity } from './provider-sync-activity';
import { readBitwardenSession } from './bitwarden-session-config';
import { syncBitwardenAccountsIsolated } from '../providers/bitwarden/bitwarden-multi-account-sync';
import type { CommandHandlers } from './command-router';
import { assertManagerPage } from './request-access';

export type ProviderSyncRequest = Extract<ExtensionRequest, { type: 'PROVIDER_SYNC' | 'PROVIDER_SYNC_CANCEL' | 'BITWARDEN_SYNC_ALL' }>;

export interface ProviderSyncDependencies {
  executeCommand: CommandExecutor;
  service: SecureVaultService;
  providers: ProviderRegistry;
  providerOperations: ProviderOperationQueue;
  bitwardenProvider: BitwardenProvider;
  bitwardenClient: BitwardenClient;
  bitwardenDurableSync: BitwardenDurableSyncCoordinator;
  keePassProvider: KeePassProvider;
  keePassDurableSync: Pick<KeePassDurableSyncCoordinator, 'clearProjectionCache'>;
  vaultSessions: Pick<ChromeVaultSessionStore, 'read'>;
  oneDriveSessions: { clear(): void };
  recoverProvider(account: ProviderAccount, signal: AbortSignal): Promise<ProviderAccount>;
  synchronizeKeePassProvider(account: ProviderAccount, signal: AbortSignal, checkOnly?: boolean): Promise<ProviderSyncResult>;
  persistKeePassRemoteFailure(providerId: string, failure: KeePassRemoteFailureInfo | undefined, message?: string): Promise<void>;
  clearKeePassPendingPersistence(providerId?: string): void;
  recordProviderDiagnosticIfUnlocked(diagnostic: Parameters<SecureVaultService['recordProviderDiagnostic']>[0]): Promise<void>;
  publishVaultChanged(): void;
  isVisible(): boolean;
}

/** Owns running operations, automatic polling, notification channels and pause
 * persistence. Callers reserve activity through the ownership-aware lease. */
export function createProviderSyncRuntime(dependencies: ProviderSyncDependencies, activity = new ProviderSyncActivity()) {
  const { executeCommand, service, providers, providerOperations, bitwardenProvider, bitwardenClient,
    bitwardenDurableSync, keePassProvider, keePassDurableSync, vaultSessions,
    oneDriveSessions, recoverProvider, synchronizeKeePassProvider,
    persistKeePassRemoteFailure, clearKeePassPendingPersistence,
    recordProviderDiagnosticIfUnlocked, publishVaultChanged, isVisible } = dependencies;
  const PAUSED_SYNC_KEY = "monica.sync.paused.v1";

  const providerSyncPromises = new Map<string, Promise<ProviderSyncResult>>();

  const automaticSyncControllers = new Set<AbortController>();

  const notificationChannels = new Map<string, { binding: string; channel: BitwardenNotifications }>();

  const pausedSyncOverrides = new Map<string, boolean>();

  let providerPauseWrite: Promise<void> = Promise.resolve();

  const automaticSync = new AutomaticSyncScheduler(async (providerId, hint) => {
    if (activity.isBusy(providerId)) return { busy: true };
    const result = await synchronizeProvider(providerId, { automatic: true, syncHint: hint });
    const state = await service.readProviderSyncSchedule();
    void reconcileAutomaticSync().catch(() => undefined);
    return { morePending: !result.conflicts.length && !result.unchanged && state.mutationQueue.some(mutation => mutation.providerId === providerId && !mutation.lastError) };
  });

  let automaticSyncGeneration = 0;

  let reconcileSyncPromise: Promise<void> | undefined;

  let reconcileSyncAgain = false;

  function synchronizeProvider(providerId: string, options: { allowEmptyRemote?: boolean; automatic?: boolean; syncHint?: ProviderSyncContext["syncHint"] } = {}): Promise<ProviderSyncResult> {
    const running = providerSyncPromises.get(providerId);
    // A manual sync must include writes made after the in-flight snapshot was read.
    // Automatic callers can share that snapshot; an explicit retry also survives its failure.
    if (running) return options.allowEmptyRemote || !options.automatic
      ? running.catch(() => undefined).then(() => synchronizeProvider(providerId, options)) : running;
    const operation = providerOperations.run(providerId, () => executeProviderSync(providerId, options)).finally(() => {
      if (providerSyncPromises.get(providerId) === operation) providerSyncPromises.delete(providerId);
    });
    providerSyncPromises.set(providerId, operation);
    return operation;
  }

  async function executeProviderSync(providerId: string, options: { allowEmptyRemote?: boolean; automatic?: boolean; syncHint?: ProviderSyncContext["syncHint"] }, signal?: AbortSignal): Promise<ProviderSyncResult> {
    signal?.throwIfAborted();
    const account = await service.getProvider(providerId);
    if (!account) throw new Error("密码源不存在。");
    if (account.kind === "local") throw new Error("本地密码源不需要同步。");
    if (account.kind === "mdbx-legacy") throw new Error("MDBX1 密码源已停用，请先在 Monica Android 或桌面端升级为 MDBX2。");
    if (!account.enabled) throw new Error("此密码源已停用。");
    if (options.automatic && (await readPausedSyncProviders()).has(providerId)) throw new Error("此密码源已锁定。");
    if (activity.isBusy(account.id)) throw new Error("此密码源正在同步。");
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    activity.reserve(account.id, controller);
    if (options.automatic) automaticSyncControllers.add(controller);
    const timeout = options.automatic ? setTimeout(() => controller.abort(new DOMException("自动同步超时", "TimeoutError")), 120_000) : undefined;
    const startedAt = Date.now();
    try {
      controller.signal.throwIfAborted();
      const recovered = await recoverProvider(account, controller.signal);
      let result: ProviderSyncResult;
      if (account.kind === "keepass") {
        result = await synchronizeKeePassProvider(account, controller.signal, options.syncHint?.type === "check-remote");
      } else if (account.kind === "bitwarden") {
        result = await bitwardenDurableSync.synchronize(recovered, controller.signal, { allowEmptyRemote: options.allowEmptyRemote === true, syncHint: options.syncHint, diagnosticStartedAt: startedAt });
      } else {
        // The adapter mutates its copy, so the snapshot is what `applyProviderSync` diffs a
        // concurrent local edit against. Both must be the same read of the vault.
        const state = await service.readState(false);
        const snapshot = state.items;
        result = await providers.get(account.kind).sync(account, {
          signal: controller.signal,
          now: new Date().toISOString(),
          localItems: structuredClone(snapshot),
          passwordProjectRemovals: structuredClone(state.passwordProjectRemovals),
          mdbx2RestoreBatches: structuredClone(state.mdbx2RestoreBatches),
          pendingMutations: structuredClone(state.mutationQueue.filter(mutation => mutation.providerId === account.id)),
          syncHint: options.syncHint
        });
        controller.signal.throwIfAborted();
        if (!result.unchanged) await service.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, snapshot, [], [], false, [], { expectedAccount: account });
      }
      // Bitwarden records this with the encrypted projection, avoiding another
      // whole-vault commit. Failure diagnostics below remain independently durable.
      if (!result.unchanged && account.kind !== 'bitwarden') await recordProviderDiagnosticIfUnlocked(createProviderDiagnostic(account.id, account.kind, undefined, new Date().toISOString(), {
        operation: "sync",
        outcome: result.conflicts.length ? "conflict" : "success",
        code: result.conflicts.length ? "conflict" : "ok",
        conflicts: result.conflicts.length,
        warnings: result.warnings.length,
        durationMs: Date.now() - startedAt,
        message: result.conflicts.length ? `发现 ${result.conflicts.length} 个同步冲突。` : "同步完成。"
      }));
      if (account.kind === "keepass" && isRemoteKeePassSource(account.config.sourceMode)) {
        await persistKeePassRemoteFailure(account.id, undefined);
      }
      if (!result.unchanged) publishVaultChanged();
      if (!options.automatic) automaticSync.completed(account.id);
      return result;
    } catch (error) {
      if (account.kind === "keepass" && isRemoteKeePassSource(account.config.sourceMode)) {
        keePassProvider.lockAccount(account.id);
        clearKeePassPendingPersistence(account.id);
      }
      const remoteFailure = account.kind === "keepass" && isRemoteKeePassSource(account.config.sourceMode)
        ? keePassRemoteFailureInfo(error)
        : undefined;
      const diagnostic = createProviderDiagnostic(account.id, account.kind, error, new Date().toISOString(), {
        operation: "sync",
        durationMs: Date.now() - startedAt,
        code: remoteFailure?.code,
        retryable: remoteFailure?.retryable
      });
      if (diagnostic.outcome !== "cancelled") {
        await service.markProviderSyncFailure(account.id, diagnostic.message);
        if (remoteFailure) await persistKeePassRemoteFailure(account.id, remoteFailure, diagnostic.message);
        else {
          const latest = await service.getProvider(account.id);
          if (latest) await service.upsertProvider({ ...latest, lastError: diagnostic.message }, false);
        }
      }
      await recordProviderDiagnosticIfUnlocked(diagnostic);
      publishVaultChanged();
      if (remoteFailure && remoteFailure.code !== "unknown") throw error;
      throw Object.assign(new Error(diagnostic.message), {
        retryable: diagnostic.retryable,
        retryAfterMs: error instanceof ProviderTransportError ? error.retryAfterMs : undefined
      });
    } finally {
      signal?.removeEventListener("abort", abort);
      if (timeout !== undefined) clearTimeout(timeout);
      automaticSyncControllers.delete(controller);
      activity.release(account.id, controller);
    }
  }

  function abortProviderSyncs(): void {
    oneDriveSessions.clear();
    stopAutomaticSync();
    activity.abortAll(new DOMException("密码库已锁定", "AbortError"));
  }

  function stopAutomaticSync(): void {
    automaticSyncGeneration += 1;
    automaticSync.stop();
    for (const controller of automaticSyncControllers) controller.abort(new DOMException("自动同步已暂停", "AbortError"));
    for (const { channel } of notificationChannels.values()) channel.stop();
    notificationChannels.clear();
    bitwardenProvider.lock();
    keePassDurableSync.clearProjectionCache();
  }

  function reconcileAutomaticSync(): Promise<void> {
    if (reconcileSyncPromise) { reconcileSyncAgain = true; return reconcileSyncPromise; }
    reconcileSyncPromise = (async () => {
      do {
        reconcileSyncAgain = false;
        const generation = automaticSyncGeneration;
        if (!await readAutomaticSyncEnabled()) { stopAutomaticSync(); return; }
        // This must not call status(): a periodic background tick must never
        // auto-unlock a device-key vault or renew its inactivity timeout.
        const state = await service.readProviderSyncSchedule();
        const paused = await readPausedSyncProviders();
        if (generation !== automaticSyncGeneration) continue;
        const accounts = state.providers.filter(account => account.enabled && !paused.has(account.id) && (
          account.kind === "bitwarden" && typeof account.config.accessToken === "string" && Boolean(account.config.accessToken)
          || account.kind === "monica-webdav" && Boolean(account.config.baseUrl)
          || account.kind === "keepass" && isRemoteKeePassSource(account.config.sourceMode)
          || account.kind === "mdbx2" && mdbx2AutomaticSyncEligible(account.config, state.mutationQueue.some(mutation => mutation.providerId === account.id))
        ));
        const visible = isVisible();
        automaticSync.configure(accounts.map(account => ({
          id: account.id,
          intervalMs: account.kind === "bitwarden" ? (notificationChannels.get(account.id)?.channel.connected ? 5 * 60_000 : 60_000) : visible ? 15_000 : 60_000
        })));
        for (const [id, { channel }] of notificationChannels) {
          if (!accounts.some(account => account.id === id && account.kind === "bitwarden")) {
            channel.stop(); notificationChannels.delete(id); bitwardenProvider.lockAccount(id);
          }
        }
        for (const account of accounts.filter(account => account.kind === "bitwarden")) {
          const accountState = account.config.accountState as { userId?: string } | undefined;
          if (!accountState?.userId) continue; // First authenticated /sync supplies the account identity.
          const binding = JSON.stringify([account.config.vaultUrl, accountState.userId, account.config.deviceId]);
          const previous = notificationChannels.get(account.id);
          if (previous?.binding === binding) continue;
          previous?.channel.stop();
          notificationChannels.delete(account.id);
          try {
            const channel = new BitwardenNotifications({
              vaultUrl: String(account.config.vaultUrl), userId: accountState.userId, deviceId: String(account.config.deviceId),
              accessToken: signal => providerOperations.run(account.id, async () => {
                const assertActive = () => {
                  signal.throwIfAborted();
                  if (generation !== automaticSyncGeneration || notificationChannels.get(account.id)?.channel !== channel) throw new VaultLockedError();
                };
                assertActive();
                const sessionId = (await vaultSessions.read())?.id;
                if (!sessionId) throw new VaultLockedError();
                const current = await service.getProvider(account.id);
                if (!current?.enabled || !current.config.accessToken || !sameProviderBinding(account, current)) throw new VaultLockedError();
                assertActive();
                const refreshed = await bitwardenNotificationSession(bitwardenClient, readBitwardenSession(current), signal);
                assertActive();
                const saved = await service.saveBitwardenSessionTokens(current, refreshed, sessionId);
                assertActive();
                // A concurrent login must never supply an unvalidated bearer or
                // apply stale refresh results to a replacement account/session.
                if (saved.config.accessToken !== refreshed.accessToken || refreshed.expiresAt <= Date.now()) throw new VaultLockedError();
                return refreshed.accessToken;
              }),
              receive: hint => {
                if (notificationChannels.get(account.id)?.channel !== channel) return;
                if (hint.type === "logout") void invalidateBitwardenSession(account.id).catch(() => undefined);
                else automaticSync.request(account.id, hint);
              },
              connected: () => {
                if (notificationChannels.get(account.id)?.channel !== channel) return;
                automaticSync.reconnected(account.id);
                void reconcileAutomaticSync().catch(() => undefined);
              },
              disconnected: () => {
                if (notificationChannels.get(account.id)?.channel !== channel) return;
                automaticSync.request(account.id, { type: "full" });
                void reconcileAutomaticSync().catch(() => undefined);
              }
            });
            notificationChannels.set(account.id, { binding, channel });
            channel.start();
          } catch {
            // A malformed/unsupported notification endpoint must not stop other
            // accounts. This account continues through the authenticated poll.
          }
        }
      } while (reconcileSyncAgain);
    })().catch(() => stopAutomaticSync()).finally(() => { reconcileSyncPromise = undefined; });
    return reconcileSyncPromise;
  }

  async function invalidateBitwardenSession(providerId: string): Promise<void> {
    notificationChannels.get(providerId)?.channel.stop();
    notificationChannels.delete(providerId);
    bitwardenProvider.lockAccount(providerId);
    activity.abort(providerId, new DOMException("Bitwarden 会话已失效", "AbortError"));
    const account = await service.getProvider(providerId);
    if (!account || account.kind !== "bitwarden") return;
    await service.upsertProvider({ ...account, config: { ...account.config, accessToken: "", refreshToken: undefined, expiresAt: 0 }, lastError: "Bitwarden 会话已失效，请重新登录。" }, false);
    publishVaultChanged();
    await reconcileAutomaticSync();
  }

  async function readPausedSyncProviders(): Promise<Set<string>> {
    const stored = await chrome.storage.session.get(PAUSED_SYNC_KEY);
    const ids = new Set(Array.isArray(stored[PAUSED_SYNC_KEY]) ? stored[PAUSED_SYNC_KEY] as string[] : []);
    for (const [id, paused] of pausedSyncOverrides) {
      if (paused) ids.add(id);
      else ids.delete(id);
    }
    return ids;
  }

  async function setProviderAutoSyncPaused(providerIds: string[], paused: boolean): Promise<void> {
    // Block queued work before the first asynchronous storage read. Serialize the
    // persisted set so locking two different databases cannot lose either pause.
    automaticSyncGeneration += 1;
    for (const id of providerIds) {
      pausedSyncOverrides.set(id, paused);
      if (paused) {
        automaticSync.remove(id);
        activity.abort(id, new DOMException("密码源已锁定", "AbortError"));
      }
    }
    const persisted = providerPauseWrite.catch(() => undefined).then(async () => {
      const ids = await readPausedSyncProviders();
      await chrome.storage.session.set({ [PAUSED_SYNC_KEY]: [...ids] });
    });
    providerPauseWrite = persisted;
    await persisted;
    if (paused) await Promise.allSettled(providerIds.map(id => providerSyncPromises.get(id)));
    await reconcileAutomaticSync();
  }
  const handlers: CommandHandlers<ProviderSyncRequest> = {
    "PROVIDER_SYNC": async (request, sender) => {
      assertManagerPage(sender);
      await service.recordUserActivity();
      const result = await synchronizeProvider(request.providerId, { allowEmptyRemote: request.allowEmptyRemote });
      return { warnings: result.warnings, conflicts: result.conflicts.length };
    },
    "PROVIDER_SYNC_CANCEL": async (request, sender) => {
      assertManagerPage(sender);
      return { cancelled: activity.abort(request.providerId, new DOMException("用户取消同步", "AbortError")) };
    },
    "BITWARDEN_SYNC_ALL": async (_request, sender) => {
      assertManagerPage(sender);
      const accounts = await service.listProviders();
      return syncBitwardenAccountsIsolated(accounts, async account =>
        await executeCommand({ type: "PROVIDER_SYNC", providerId: account.id }, sender, handlers.PROVIDER_SYNC) as { conflicts: number; warnings: string[] });
    }
  };
  return {
    handlers,
    activity,
    synchronize: synchronizeProvider,
    execute: executeProviderSync,
    pending: (providerId: string) => providerSyncPromises.get(providerId),
    abortAll: abortProviderSyncs,
    stop: stopAutomaticSync,
    reconcile: reconcileAutomaticSync,
    paused: readPausedSyncProviders,
    pause: setProviderAutoSyncPaused,
    invalidateBitwardenSession,
    request: automaticSync.request.bind(automaticSync),
    wake: automaticSync.wake.bind(automaticSync),
    reconnected: automaticSync.reconnected.bind(automaticSync)
  };
}
