import { describe, expect, it, vi } from 'vitest';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultDeviceKeyStore } from './vault-device-key';
import { decryptVaultState, deriveVaultKey, encryptVaultState } from './vault-crypto';
import { createEmptyVaultState, createLoginItem } from '../core/model';
import { migrateVaultState } from '../core/migrations';
import { parseLosslessJson } from '../core/lossless-json';
import { changeNearbyPreferences, createNearbyPreferences, nearbyDeviceHello, nearbyPreferencesView, nearbySettingsCounter,
  readNearbyPreferences, type NearbySavedPeer } from '../nearby/preferences';

const peer: NearbySavedPeer = { deviceId: 'synthetic-peer', pairId: 'synthetic-pair', trustedKey: Buffer.alloc(32, 1).toString('base64url'),
  name: 'Synthetic phone', lastSyncedAt: 0, sentRevision: '', receivedRevision: '', receivedRequest: '0' };
function preferences() { return createNearbyPreferences(createEmptyVaultState().providers[0]); }
async function fixture() {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), keys = new MemoryVaultDeviceKeyStore();
  const service = new SecureVaultService(storage, sessions, Date.now, keys);
  await service.setup('', [createLoginItem({ title: 'Synthetic account', password: 'synthetic password' })]);
  return { storage, sessions, keys, service, sessionId: (await service.passkeySessionId())! };
}

describe('nearby identity and peer preferences', () => {
  it('keeps immutable identity and replica secrets private across preference changes', () => {
    const old = preferences(), next = changeNearbyPreferences(old, { kind: 'preferences', enabled: true, intervalSeconds: 60, mode: 'send_only' }, old.epoch);
    expect(old.enabled).toBe(false); expect(next).toMatchObject({ deviceId: old.deviceId, replicaKey: old.replicaKey, replicaStorageId: old.replicaStorageId,
      settingsVersion: '1', settingsWriter: old.deviceId, syncRequest: '1', enabled: true, intervalSeconds: 60, mode: 'send_only' });
    const paired = changeNearbyPreferences(next, { kind: 'remember', peer, enrollment: true }, next.epoch);
    const view = JSON.stringify(nearbyPreferencesView(paired));
    for (const value of [old.replicaKey, old.replicaStorageId, peer.trustedKey, peer.pairId]) expect(view).not.toContain(value);
    expect(nearbyDeviceHello(paired, peer.deviceId)).toMatchObject({ device_id: old.deviceId, pair_id: peer.pairId, sync_mode: 'send_only' });
    expect(changeNearbyPreferences(paired, { kind: 'remember', peer: { ...peer, name: '' }, enrollment: false }, paired.epoch).peers[0].name).toBe('');
  });

  it.each([
    { version: 2 }, { extra: true }, { enabled: 'yes' }, { incrementalOnly: 'yes' }, { intervalSeconds: 1 }, { syncRequest: '9223372036854775808' },
    { settingsVersion: 9007199254740992 }, { replicaKey: 'a'.repeat(43) }, { mode: 'both' }, { peers: [peer, peer] },
    { peers: [{ ...peer, trustedKey: 'invalid' }] }, { name: 'Name\nspoofed' }
  ])('rejects invalid encrypted preference state without resetting it: %j', patch => {
    const state = createEmptyVaultState(); state.nearbyPreferences = { ...preferences(), ...patch } as any;
    const before = structuredClone(state);
    expect(() => migrateVaultState(state)).toThrow(); expect(state).toEqual(before);
  });

  it('keeps local deletions local by default and for settings saved before the switch existed', () => {
    const created = preferences();
    expect(created.incrementalOnly).toBe(true);
    expect(nearbyPreferencesView(created).incrementalOnly).toBe(true);
    const legacy = { ...created } as Record<string, unknown>; delete legacy.incrementalOnly;
    expect(readNearbyPreferences(legacy)!.incrementalOnly).toBe(true);
    const off = changeNearbyPreferences(created, { kind: 'preferences', incrementalOnly: false }, created.epoch);
    expect(off.incrementalOnly).toBe(false);
    expect(nearbyPreferencesView(off).incrementalOnly).toBe(false);
  });

  it('retains exact Android Long settings and applies the Android version/writer order', () => {
    let p = preferences(); p.settingsVersion = '9007199254740993'; p.settingsWriter = 'b'; p.syncRequest = '9223372036854775807';
    p = changeNearbyPreferences(p, { kind: 'remember', peer, enrollment: true }, p.epoch);
    p = changeNearbyPreferences(p, { kind: 'remote-interval', peerId: peer.deviceId, pairId: peer.pairId, seconds: 60, version: '9007199254740993', writer: 'a' }, p.epoch);
    expect(p.intervalSeconds).toBe(0);
    p = changeNearbyPreferences(p, { kind: 'remote-interval', peerId: peer.deviceId, pairId: peer.pairId, seconds: 120, version: '9007199254740993', writer: 'c' }, p.epoch);
    expect(p.intervalSeconds).toBe(120);
    const hello = JSON.stringify(nearbyDeviceHello(p)); expect(hello).toContain('"settings_version":9007199254740993'); expect(hello).toContain('"sync_request":9223372036854775807');
    expect(nearbySettingsCounter(parseLosslessJson('9007199254740993'))).toBe('9007199254740993');
    expect(() => nearbySettingsCounter(9007199254740992)).toThrow(); expect(() => nearbySettingsCounter('1')).toThrow();
    expect(() => changeNearbyPreferences(p, { kind: 'request-sync' }, p.epoch)).toThrow('counter-exhausted');
  });

  it('does not replace trusted keys, regress history, or resurrect forgotten peers', () => {
    const initial = preferences(); const paired = changeNearbyPreferences(initial, { kind: 'remember', peer, enrollment: true }, initial.epoch);
    const different = { ...peer, trustedKey: preferences().replicaKey };
    expect(() => changeNearbyPreferences(paired, { kind: 'remember', peer: different, enrollment: true }, paired.epoch)).toThrow('peer-key-changed');
    const synced = changeNearbyPreferences(paired, { kind: 'remember', peer: { ...peer, receivedRequest: '19', lastSyncedAt: 123 }, enrollment: false }, paired.epoch);
    expect(() => changeNearbyPreferences(synced, { kind: 'remember', peer, enrollment: false }, synced.epoch)).toThrow('peer-history-regression');
    const forgotten = changeNearbyPreferences(paired, { kind: 'forget', deviceId: peer.deviceId }, paired.epoch);
    expect(() => changeNearbyPreferences(forgotten, { kind: 'remember', peer, enrollment: true }, paired.epoch)).toThrow('stale-session');
    expect(() => changeNearbyPreferences(forgotten, { kind: 'remember', peer, enrollment: false }, forgotten.epoch)).toThrow('peer-forgotten');
    expect(() => nearbyDeviceHello(forgotten, peer.deviceId)).toThrow('peer-forgotten');
  });
});

describe('encrypted nearby preference service', () => {
  it('initializes once under concurrent callers and survives a service restart without plaintext storage', async () => {
    const f = await fixture(), write = vi.spyOn(f.storage, 'write');
    const [one, two] = await Promise.all([f.service.nearbySessionPreferences(f.sessionId), f.service.nearbySessionPreferences(f.sessionId)]);
    expect(one).toEqual(two); expect(one.enabled).toBe(false); expect(write).toHaveBeenCalledOnce();
    await f.service.updateNearbyPreferences({ kind: 'remember', peer, enrollment: true }, one.epoch, f.sessionId);
    const next = new SecureVaultService(f.storage, f.sessions, Date.now, f.keys), saved = await next.nearbySessionPreferences(f.sessionId);
    expect(saved).toMatchObject({ deviceId: one.deviceId, replicaStorageId: one.replicaStorageId, replicaKey: one.replicaKey, peers: [peer] });
    const encrypted = JSON.stringify(await f.storage.read());
    for (const secret of [one.replicaKey, peer.trustedKey, peer.name, 'synthetic password']) expect(encrypted).not.toContain(secret);
    saved.peers.length = 0; expect((await next.nearbySessionPreferences(f.sessionId)).peers).toHaveLength(1);
  });

  it('preference changes invalidate previously captured application sources', async () => {
    const f = await fixture(), p = await f.service.nearbySessionPreferences(f.sessionId);
    const before = await f.service.nearbyLocalSnapshotHash();
    await f.service.updateNearbyPreferences({ kind: 'preferences', mode: 'receive_only' }, p.epoch, f.sessionId);
    expect(await f.service.nearbyLocalSnapshotHash()).not.toBe(before);
    expect((await f.service.readState()).items[0]).toMatchObject({ password: 'synthetic password' });
  });

  it('recovers stored response loss and rejects stale settings, lock, and quota-failure writes', async () => {
    const f = await fixture(), settings = await f.service.nearbySessionPreferences(f.sessionId), original = f.storage.write.bind(f.storage);
    vi.spyOn(f.storage, 'write').mockImplementationOnce(async envelope => { await original(envelope); throw Error('synthetic lost reply'); });
    await expect(f.service.updateNearbyPreferences({ kind: 'preferences', enabled: true }, settings.epoch, f.sessionId)).rejects.toThrow('synthetic lost reply');
    const restarted = new SecureVaultService(f.storage, f.sessions, Date.now, f.keys), saved = await restarted.nearbySessionPreferences(f.sessionId);
    expect(saved.enabled).toBe(true); expect(saved.deviceId).toBe(settings.deviceId);
    const before = await f.storage.read();
    await expect(restarted.updateNearbyPreferences({ kind: 'preferences', enabled: false }, settings.epoch, f.sessionId)).rejects.toThrow('stale-session');
    vi.spyOn(f.storage, 'write').mockRejectedValueOnce(Error('synthetic quota failure'));
    await expect(restarted.updateNearbyPreferences({ kind: 'remember', peer, enrollment: true }, saved.epoch, f.sessionId)).rejects.toThrow('quota');
    expect(await f.storage.read()).toEqual(before);
    await restarted.lock();
    await expect(restarted.updateNearbyPreferences({ kind: 'remember', peer, enrollment: true }, saved.epoch, f.sessionId)).rejects.toThrow();
    await expect(restarted.nearbySessionPreferences(f.sessionId)).rejects.toThrow();
    expect(await f.storage.read()).toEqual(before);
  });

  it('portable backup restores contents with a new disabled identity and no foreign peer trust', async () => {
    const f = await fixture(), saved = await f.service.nearbySessionPreferences(f.sessionId);
    await f.service.updateNearbyPreferences({ kind: 'remember', peer, enrollment: true }, saved.epoch, f.sessionId);
    const backup = await f.service.exportEncryptedBackup('Synthetic portable backup password');
    const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), next = new SecureVaultService(storage, sessions);
    const restored = await next.restoreEncryptedBackup(backup, 'Synthetic portable backup password');
    expect(restored.nearbyPreferences).toBeUndefined(); expect(restored.items[0].title).toBe('Synthetic account');
    const fresh = await next.nearbySessionPreferences((await next.passkeySessionId())!);
    expect(fresh.enabled).toBe(false); expect(fresh.peers).toEqual([]); expect(fresh.deviceId).not.toBe(saved.deviceId); expect(fresh.replicaKey).not.toBe(saved.replicaKey);
    expect((await f.service.nearbySessionPreferences(f.sessionId)).peers).toEqual([peer]);
  });

  it('unknown trust versions stop decryption without overwriting the encrypted original', async () => {
    const derived = await deriveVaultKey('Synthetic future state password'), state = createEmptyVaultState();
    state.nearbyPreferences = { ...preferences(), version: 9 } as any;
    const envelope = await encryptVaultState(state, derived.key, derived.kdf);
    await expect(decryptVaultState(envelope, derived.key)).rejects.toThrow();
    expect(() => readNearbyPreferences(state.nearbyPreferences)).toThrow();
  });
});

describe('nearby connection hints', () => {
  it('creates browser identities that take the outbound dialing role against Android IDs', () => {
    const created = preferences();
    expect(created.deviceId).toMatch(/^00[a-f0-9]{30}$/);
    // Android IDs are UUID hex; a smaller browser ID makes the browser dial the phone.
    expect(created.deviceId < '0a'.padEnd(32, '0')).toBe(true);
  });

  it('stores only a private IPv4 peer address and never exposes it in the view', () => {
    const base = preferences(), paired = changeNearbyPreferences(base, { kind: 'remember', peer: { ...peer, address: '192.168.4.9' }, enrollment: true }, base.epoch);
    expect(paired.peers[0].address).toBe('192.168.4.9');
    expect(JSON.stringify(nearbyPreferencesView(paired))).not.toContain('192.168.4.9');
    for (const address of ['8.8.8.8', '192.168.4', '192.168.04.9', 'fe80::1'])
      expect(() => changeNearbyPreferences(base, { kind: 'remember', peer: { ...peer, address }, enrollment: true }, base.epoch)).toThrow('invalid-address');
    // Saved trust from before this field existed still loads.
    expect(readNearbyPreferences(changeNearbyPreferences(base, { kind: 'remember', peer, enrollment: true }, base.epoch))!.peers[0].address).toBeUndefined();
  });
});
