import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderSyncRuntime, type ProviderSyncDependencies } from './provider-sync-runtime';
import { ProviderSyncActivity } from './provider-sync-activity';
import { ProviderOperationQueue } from './provider-operation-queue';

const notifications = vi.hoisted(() => ({ channels: [] as Array<{ options: Record<string, any>; stop: ReturnType<typeof vi.fn> }>, refresh: vi.fn() }));
vi.mock('../providers/bitwarden/bitwarden-notifications', () => ({
  BitwardenNotifications: class {
    connected = false;
    stop = vi.fn();
    constructor(readonly options: Record<string, any>) { notifications.channels.push(this); }
    start() {}
  },
  bitwardenNotificationSession: notifications.refresh
}));

beforeEach(() => {
  notifications.channels.length = 0; notifications.refresh.mockReset();
  vi.stubGlobal('chrome', { storage: {
    session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    local: { get: vi.fn(async () => ({ 'monica.sync.automatic.enabled.v1': false })) }
  } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const account = { id: 'source', kind: 'monica-webdav', enabled: true, config: { baseUrl: 'https://example.test/' } };
  const result = { items: [], conflicts: [], warnings: [], accountPatch: {}, sourceRecords: [], unchanged: false };
  const sync = vi.fn(async (_account: unknown, _context: any) => result);
  const service = {
    getProvider: vi.fn(async () => account), readState: vi.fn(async () => ({ items: [], providers: [account], mutationQueue: [] })),
    readProviderSyncSchedule: vi.fn(async () => ({ providers: [account], mutationQueue: [] })),
    applyProviderSync: vi.fn(async () => {}), markProviderSyncFailure: vi.fn(async () => {}), upsertProvider: vi.fn(async () => {}),
    saveBitwardenSessionTokens: vi.fn(async (current, session) => ({ ...current, config: { ...current.config, ...session } }))
  };
  const dependencies = {
    service, providers: { get: () => ({ sync }) }, providerOperations: new ProviderOperationQueue(),
    bitwardenProvider: { lock: vi.fn(), lockAccount: vi.fn() }, bitwardenClient: {}, bitwardenDurableSync: {},
    keePassProvider: { lockAccount: vi.fn() }, keePassDurableSync: { clearProjectionCache: vi.fn() },
    vaultSessions: { read: vi.fn(async () => ({ id: 'session' })) }, oneDriveSessions: { clear: vi.fn() },
    recoverProvider: vi.fn(async account => account), synchronizeKeePassProvider: vi.fn(),
    persistKeePassRemoteFailure: vi.fn(), clearKeePassPendingPersistence: vi.fn(),
    recordProviderDiagnosticIfUnlocked: vi.fn(), publishVaultChanged: vi.fn(), isVisible: () => false
  };
  const runtime = createProviderSyncRuntime(dependencies as unknown as ProviderSyncDependencies);
  return { account, result, sync, service, dependencies, runtime };
}

describe('synchronization runtime behavior', () => {
  it('lets Bitwarden persist ordinary telemetry with adoption instead of writing it again', async () => {
    const f = fixture();
    Object.assign(f.account, { kind: 'bitwarden' });
    const synchronize = vi.fn(async () => f.result);
    Object.assign(f.dependencies.bitwardenDurableSync, { synchronize });
    await f.runtime.synchronize('source');
    expect(synchronize).toHaveBeenCalledWith(f.account, expect.any(AbortSignal), expect.objectContaining({ diagnosticStartedAt: expect.any(Number) }));
    expect(f.dependencies.recordProviderDiagnosticIfUnlocked).not.toHaveBeenCalled();
    expect(f.dependencies.publishVaultChanged).toHaveBeenCalledTimes(1);
    f.runtime.stop();
  });
  it('shares automatic work but a manual request reads a new snapshot after the first sync', async () => {
    const f = fixture(), first = deferred<typeof f.result>();
    f.sync.mockImplementationOnce(() => first.promise);
    const automatic = f.runtime.synchronize('source', { automatic: true });
    await vi.waitFor(() => expect(f.sync).toHaveBeenCalledTimes(1));
    expect(f.runtime.synchronize('source', { automatic: true })).toBe(automatic);
    const manual = f.runtime.synchronize('source');
    first.resolve(f.result); await automatic; await manual;
    expect(f.sync).toHaveBeenCalledTimes(2);
    expect(f.service.readState).toHaveBeenCalledTimes(2);
    expect(f.runtime.pending('source')).toBeUndefined();
    expect(f.runtime.activity.isBusy('source')).toBe(false);
    f.runtime.stop();
  });

  it('rejects late sync results after lock and does not apply them', async () => {
    const f = fixture(), first = deferred<typeof f.result>();
    f.sync.mockImplementationOnce(() => first.promise);
    const operation = f.runtime.synchronize('source');
    const rejected = expect(operation).rejects.toThrow();
    await vi.waitFor(() => expect(f.sync).toHaveBeenCalledTimes(1));
    f.runtime.abortAll(); first.resolve(f.result); await rejected;
    expect(f.sync.mock.calls[0][1].signal.aborted).toBe(true);
    expect(f.service.applyProviderSync).not.toHaveBeenCalled();
    expect(f.runtime.activity.isBusy('source')).toBe(false);
    expect(f.runtime.pending('source')).toBeUndefined();
  });

  it('preserves both pauses when two providers lock concurrently', async () => {
    const f = fixture();
    // Disable automatic work without touching the vault status or inactivity timer.
    chrome.storage.local.get = vi.fn(async () => ({ 'monica.sync.preferences.v1': { enabled: false } })) as any;
    await Promise.all([f.runtime.pause(['one'], true), f.runtime.pause(['two'], true)]);
    expect(await f.runtime.paused()).toEqual(new Set(['one', 'two']));
    expect(chrome.storage.session.set).toHaveBeenLastCalledWith({ 'monica.sync.paused.v1': ['one', 'two'] });
    f.runtime.stop();
  });

  it('does not persist a notification token refresh after its channel was stopped', async () => {
    const f = fixture();
    Object.assign(f.account, { kind: 'bitwarden', config: {
      vaultUrl: 'https://example.test/', apiUrl: 'https://example.test/api', identityUrl: 'https://example.test/identity',
      accountState: { userId: 'user' }, email: 'synthetic@example.test', deviceId: 'device', accessToken: 'old',
      vaultKeyEnc: 'enc', vaultKeyMac: 'mac', kdf: {}, expiresAt: Date.now() + 60_000
    } });
    const refresh = deferred<Record<string, unknown>>(); notifications.refresh.mockReturnValueOnce(refresh.promise);
    await f.runtime.reconcile();
    const channel = notifications.channels[0]; expect(channel).toBeDefined();
    const token = channel.options.accessToken(new AbortController().signal);
    const rejected = expect(token).rejects.toThrow();
    await vi.waitFor(() => expect(notifications.refresh).toHaveBeenCalledTimes(1));
    f.runtime.stop(); refresh.resolve({ accessToken: 'new', expiresAt: Date.now() + 60_000 }); await rejected;
    expect(f.service.saveBitwardenSessionTokens).not.toHaveBeenCalled();
  });

  it('retains a replacement activity when the canceled owner finishes late', () => {
    const activity = new ProviderSyncActivity(), old = new AbortController(), replacement = new AbortController();
    activity.reserve('source', old); activity.abortAll('locked'); activity.reserve('source', replacement);
    activity.release('source', old);
    expect(activity.owns('source', replacement.signal)).toBe(true);
    expect(() => activity.reserve('source', new AbortController())).toThrow();
    activity.release('source', replacement); expect(activity.isBusy('source')).toBe(false);
  });
});
