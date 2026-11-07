import { describe, expect, it, vi } from 'vitest';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultStorage } from '../security/vault-storage';
import { MemoryVaultSessionStore } from '../security/vault-session';
import { MemoryVaultDeviceKeyStore } from '../security/vault-device-key';
import { createLoginItem, type PasskeyItem, type VaultItem } from '../core/model';
import { bytesToBase64 } from '../security/encoding';
import { NearbyLocalCoordinator } from './local-coordinator';
import type { NearbyNativeTransport, NearbyOperation } from './native-transport';
import { collectNearbyPending, groupNearbyPending } from './pending';
import { nearbyLocalItemToWire } from './application-codec';
import type { NearbyIncomingRecord } from './local-adoption';
import { localNearbySource } from './source-adapter';
import { NearbyDataError } from './wire-shape';
import { nearbySha256 } from './native-transport';

const handle = '11111111-1111-4111-8111-111111111111';
const peer = { deviceId: 'phone', name: 'Synthetic phone', pairId: 'pair-one', trustedKey: Buffer.alloc(32, 9).toString('base64url'),
  lastSyncedAt: 0, sentRevision: '', receivedRevision: '', receivedRequest: '0' };
const discovered = { protocol: 'monica-lan', version: 2, session: peer.pairId, name: 'Synthetic phone', port: 5555,
  address: '192.168.1.20', addresses: ['192.168.1.20', '10.0.0.7'], device_id: peer.deviceId, trusted: true, revision: 'r:0::0' };

describe('authenticated incremental receive and resume lifecycle', () => {
  it.each(['valid', 'corrupt', 'wrong-size', 'changed-source', 'missing', 'legacy'] as const)('validates locally retained incremental assets (%s)', async mode => {
    const f = await fixture(); f.transport.supportsIncrementalSync = mode !== 'legacy';
    await f.coordinator.prepare(peer.deviceId); await f.coordinator.start();
    const bytes = new Uint8Array([17, 31, 49]), id = await nearbySha256(bytes);
    const original = await f.service.captureNearbyLocalRecords();
    const readAsset = vi.fn(async () => mode === 'corrupt' ? new Uint8Array([0, 0, 0]) : bytes.slice());
    (f.coordinator as any).source.capture = vi.fn(async () => ({
      sourceHash: mode === 'changed-source' ? 'changed' : original.sourceHash,
      records: mode === 'missing' ? [] : [{ data: { assets: [{ id, size: mode === 'wrong-size' ? 4 : 3 }] } }], readAsset
    }));
    const call = f.transport.call.getMockImplementation()!;
    f.transport.call.mockImplementation(async (op, params) => op === 'asset_list' ? { items: [] } : call(op, params));
    const result = (f.coordinator as any).readIncomingAsset({ id, size: 3 });
    if (mode === 'valid') expect(await result).toEqual(bytes);
    else await expect(result).rejects.toThrow();
    if (mode === 'missing' || mode === 'legacy' || mode === 'changed-source' || mode === 'wrong-size') expect(readAsset).not.toHaveBeenCalled();
    expect(f.operations).not.toContain('acknowledge'); f.coordinator.close();
  });
  async function receiving() {
    const f = await fixture(); f.transport.supportsIncrementalSync = true;
    await f.coordinator.prepare(peer.deviceId); await f.coordinator.start();
    const original = f.transport.call.getMockImplementation()!;
    const remote = { device_id: peer.deviceId, name: peer.name, revision: 'remote', content_type: 'vault', vault_content_version: 2,
      receive_content: true, send_content: true, pairing: {}, sync_request: 0, interval_seconds: 60, settings_version: 0, settings_writer: '' };
    f.transport.call.mockImplementation(async (op, params) => op === 'progress' ? { phase: 'received', peer: remote }
      : op === 'replica_merge_preview' ? { deletions: 1, review_revision: 'c'.repeat(64) } : original(op, params));
    return f;
  }
  it.each(['omit', 'include'] as const)('waits for receive deletion review and actual application before acknowledging (%s)', async choice => {
    const f = await receiving(), before = await f.service.nearbyLocalSnapshotHash();
    const review = await f.coordinator.poll();
    expect(review).toMatchObject({ phase: 'review', deletionReview: { count: 1, incoming: true } });
    expect(f.operations).not.toContain('replica_merge'); expect(f.operations).not.toContain('acknowledge');
    expect(await f.service.nearbyLocalSnapshotHash()).toBe(before);
    expect((await f.coordinator.poll()).deletionReview?.id).toBe(review.deletionReview!.id);
    await f.coordinator.confirmDeletions(review.deletionReview!.id, choice);
    const merge = f.operations.indexOf('replica_merge'), ack = f.operations.indexOf('acknowledge');
    expect(f.params[merge]).toMatchObject({ deletion_policy: choice, review_revision: 'c'.repeat(64) });
    expect(ack).toBeGreaterThan(merge);
    expect((await f.service.nearbySessionPreferences(f.sessionId)).peers[0].lastSyncedAt).toBe(0);
  });
  it('revokes a pending receive review on vault lock without an apply or receipt', async () => {
    const f = await receiving(), view = await f.coordinator.poll(); await f.service.lock();
    await expect(f.coordinator.confirmDeletions(view.deletionReview!.id, 'include')).rejects.toThrow();
    expect(f.operations).not.toContain('replica_merge'); expect(f.operations).not.toContain('acknowledge');
  });
  it('rejects a changed native review without publishing an applied receipt', async () => {
    const f = await receiving(), review = await f.coordinator.poll(), original = f.transport.call.getMockImplementation()!;
    f.transport.call.mockImplementation(async (op, params) => { if (op === 'replica_merge') throw Error('review_changed'); return original(op, params); });
    await expect(f.coordinator.confirmDeletions(review.deletionReview!.id, 'include')).rejects.toThrow();
    expect(f.operations).not.toContain('acknowledge'); expect(f.transport.close).toHaveBeenCalled();
  });
  it('unwraps Android hotspot hints without sending Wi-Fi credentials to the native host', async () => {
    const f = await fixture(), link = `monica-lan:2:192.168.43.1:12345:${peer.trustedKey}`;
    const encode = (s: string) => Buffer.from(s).toString('base64url');
    await f.coordinator.pair(`monica-hotspot:1:${encode('Monica synthetic')}:${encode('synthetic-pass')}:${encode(link)}`);
    const params = f.params[f.operations.indexOf('connect')];
    expect(params.invitation).toBe(link);
    expect(JSON.stringify(f.params)).not.toContain('synthetic-pass');
    expect(JSON.stringify(f.params)).not.toContain('Monica synthetic');
  });
});

it('keeps a manual request while the paired phone is still preparing its listener', async () => {
  const f = await fixture();
  const original = f.transport.call.getMockImplementation()!;
  let searches = 0;
  f.transport.call.mockImplementation(async (operation, input) => {
    if (operation === 'discovery_result') return { ready: true, result: { devices: ++searches < 5 ? [] : [discovered] } };
    return original(operation, input);
  });
  vi.spyOn(f.coordinator as any, 'pause').mockResolvedValue(undefined);
  await f.coordinator.prepare(peer.deviceId);
  const view = await f.coordinator.start();
  expect(searches).toBe(5);
  expect(view.phase).toBe('transferring');
  expect(f.operations.filter(operation => operation === 'connect')).toHaveLength(1);
  f.coordinator.close();
});

it('keeps polling a still-running background discovery until it reports the peer', async () => {
  const f = await fixture();
  const original = f.transport.call.getMockImplementation()!;
  let searches = 0;
  f.transport.call.mockImplementation(async (operation, input) => {
    if (operation === 'discovery_result') return ++searches < 45 ? { ready: false } : { ready: true, result: { devices: [discovered] } };
    return original(operation, input);
  });
  vi.spyOn(f.coordinator as any, 'pause').mockResolvedValue(undefined);
  await f.coordinator.prepare(peer.deviceId);
  const view = await f.coordinator.start();
  expect(searches).toBe(45);
  expect(view.phase).toBe('transferring');
  expect(f.operations.filter(operation => operation === 'connect')).toHaveLength(1);
  f.coordinator.close();
});

it('reports discovery-unavailable only after the bounded connection window expires', async () => {
  const f = await fixture();
  const original = f.transport.call.getMockImplementation()!;
  f.transport.call.mockImplementation(async (operation, input) => {
    if (operation === 'discovery_result') { (f.coordinator as any).connectionDeadline = Date.now() - 1; return { ready: false }; }
    return original(operation, input);
  });
  vi.spyOn(f.coordinator as any, 'pause').mockResolvedValue(undefined);
  await f.coordinator.prepare(peer.deviceId);
  await expect(f.coordinator.start()).rejects.toThrow('discovery-unavailable');
  expect(f.coordinator.status()).toMatchObject({ phase: 'failed', error: 'discovery-unavailable' });
  expect(f.operations).not.toContain('connect');
});

it('rediscovers a replaced listener before sending and never retries authentication rejection', async () => {
  for (const code of ['connection_failed', 'authentication_failed']) {
    const f = await fixture();
    const original = f.transport.call.getMockImplementation()!;
    vi.spyOn(f.coordinator as any, 'pause').mockResolvedValue(undefined);
    await f.coordinator.prepare(peer.deviceId); await f.coordinator.start();
    f.transport.call.mockImplementation(async (operation, input) => operation === 'progress'
      ? { phase: 'failed', failed_at: 'authenticating', error: code } : original(operation, input));
    if (code === 'connection_failed') {
      expect((await f.coordinator.poll()).phase).toBe('transferring');
      expect(f.operations.filter(operation => operation === 'connect')).toHaveLength(2);
      expect(f.operations.filter(operation => operation === 'replica_export')).toHaveLength(1);
      expect(f.operations).not.toContain('replica_merge');
    } else {
      await expect(f.coordinator.poll()).rejects.toMatchObject({ code: 'authentication-failed' });
      expect(f.operations.filter(operation => operation === 'connect')).toHaveLength(1);
    }
    f.coordinator.close();
  }
});
async function fixture(items: VaultItem[] = [createLoginItem({ title: 'Original', password: 'synthetic password' })], saved: typeof peer = peer,
  devices: unknown[] = [discovered]) {
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore(), service = new SecureVaultService(storage, sessions, Date.now, new MemoryVaultDeviceKeyStore());
  await service.setup('', items); const sessionId = (await service.passkeySessionId())!;
  const preferences = await service.nearbySessionPreferences(sessionId);
  await service.updateNearbyPreferences({ kind: 'remember', peer: saved, enrollment: true }, preferences.epoch, sessionId);
  const operations: string[] = [], params: Record<string, unknown>[] = [];
  const transport = { supportsIncrementalSync: false, close: vi.fn(), call: vi.fn(async (operation: NearbyOperation, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    operations.push(operation); params.push(input);
    switch (operation) {
      case 'snapshot_pairing': return { handle, revision: 'pairing-only-v1', asset_ids: [], pending: false };
      case 'snapshot_receive_only': return { handle, revision: 'receive-only-v1', asset_ids: [], pending: false };
      case 'replica_open': return { handle };
      case 'replica_pending': return { items: [], total: 0, next_cursor: null };
      case 'replica_export': return { handle, revision: 'revision', asset_ids: [], pending: false, deletion_policy: input.deletion_policy, deletion_count: 0 };
      case 'replica_revision': return { revision: 'revision', pending: false };
      case 'start': return { handle, code: '123456', invitations: [`monica-lan:2:127.0.0.1:12345:${peer.trustedKey}`] };
      case 'connect': return { handle };
      case 'discover': return { handle };
      case 'discovery_result': return { ready: true, result: { devices } };
      default: return {};
    }
  }) };
  const factory = vi.fn(() => transport as unknown as NearbyNativeTransport), coordinator = new NearbyLocalCoordinator(service, factory, '127.0.0.1');
  return { storage, service, sessionId, transport, operations, params, factory, coordinator };
}

describe('nearby coordinator authorization and cancellation', () => {
  async function deletionFixture(items?: VaultItem[]) {
    const f = await fixture(items), original = f.transport.call.getMockImplementation()!;
    f.transport.call.mockImplementation(async (op, input = {}) => {
      const result = await original(op, input);
      return op === 'replica_export' ? { ...result, deletion_count: 2 } : result;
    });
    return f;
  }
  it.each(['omit', 'include'] as const)('waits for explicit deletion review and applies only this transfer choice: %s', async choice => {
    const f = await deletionFixture();
    const view = await f.coordinator.prepare(peer.deviceId);
    expect(view.phase).toBe('review'); expect(view.deletionReview).toMatchObject({ count: 2 });
    expect(f.operations).not.toContain('start'); expect(f.operations).not.toContain('connect');
    const resolved = await f.coordinator.confirmDeletions(view.deletionReview!.id, choice);
    expect(resolved.phase).toBe('ready'); expect(resolved.deletionReview).toBeUndefined();
    expect(f.params.filter((_, i) => f.operations[i] === 'replica_export').map(row => row.deletion_policy)).toEqual(choice === 'include' ? ['omit', 'include'] : ['omit']);
    expect((await f.service.nearbySessionPreferences(f.sessionId)).incrementalOnly).toBe(true);
    await f.coordinator.start(); expect(f.operations).toContain('connect');
    f.coordinator.close();
  });
  it('cannot start before the deletion decision or reuse a stale decision', async () => {
    const f = await deletionFixture(); await f.coordinator.prepare(peer.deviceId);
    await expect(f.coordinator.start()).rejects.toMatchObject({ code: 'not-ready' });
    expect(f.operations).not.toContain('connect');
    const other = await deletionFixture(), review = (await other.coordinator.prepare(peer.deviceId)).deletionReview!;
    await other.service.upsertItem({ ...(await other.service.readState()).items[0], notes: 'edited while reviewing' });
    await expect(other.coordinator.confirmDeletions(review.id, 'include')).rejects.toMatchObject({ code: 'source-changed' });
    expect(other.params.filter((_, i) => other.operations[i] === 'replica_export')).toHaveLength(1);
  });
  it('cancels deletion review without disclosing a snapshot', async () => {
    const f = await deletionFixture(), review = (await f.coordinator.prepare(peer.deviceId)).deletionReview!;
    f.coordinator.close();
    await expect(f.coordinator.confirmDeletions(review.id, 'include')).rejects.toThrow();
    expect(f.operations).not.toContain('connect'); expect(f.operations).not.toContain('start');
  });
  it('fails closed with a helper that does not acknowledge deletion filtering', async () => {
    const f = await fixture(), original = f.transport.call.getMockImplementation()!;
    f.transport.call.mockImplementation(async (op, input) => op === 'replica_export' ? { handle, revision: 'revision', pending: false, asset_ids: [] } as any : original(op, input));
    await expect(f.coordinator.prepare(peer.deviceId)).rejects.toMatchObject({ code: 'host-update-required' });
    expect(f.operations).not.toContain('connect'); expect(f.operations).not.toContain('start');
  });
  it.each(['passkey-first', 'deletion-first'] as const)('requires both independent reviews: %s', async order => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const key: PasskeyItem = { ...createLoginItem({ title: 'Restricted key' }), kind: 'passkey', rpId: 'example.test', rpName: 'Example',
      userHandle: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic', credentialId: 'AQID', signCount: 0, algorithm: -7, discoverable: true,
      backupEligible: false, sourceMode: 'browser-local', publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
      privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))) };
    const f = await deletionFixture([key]), view = await f.coordinator.prepare(peer.deviceId);
    expect(view.review).toBeDefined(); expect(view.deletionReview).toBeDefined();
    const passkey = () => f.coordinator.confirm(view.review!.id);
    const deletion = () => f.coordinator.confirmDeletions(view.deletionReview!.id, 'omit');
    expect((await (order === 'passkey-first' ? passkey() : deletion())).phase).toBe('review');
    expect((await (order === 'passkey-first' ? deletion() : passkey())).phase).toBe('ready');
    expect(f.operations).not.toContain('connect'); f.coordinator.close();
  });
  it('recovers a retained native intent without peers or any LAN calls', async () => {
    const f=await fixture(), preferences=await f.service.nearbySessionPreferences(f.sessionId);
    await f.service.updateNearbyPreferences({kind:'forget',deviceId:peer.deviceId},preferences.epoch,f.sessionId);
    const recover=vi.fn(async()=>[{recordId:'incoming'}] as any);
    const coordinator=new NearbyLocalCoordinator(f.service,f.factory,undefined,undefined,async()=>({
      ...localNearbySource(f.service,f.sessionId,()=>{}),native:true,recover
    }));
    expect(await coordinator.recover(handle)).toEqual({applied:1}); expect(recover).toHaveBeenCalledWith(handle);
    expect(f.operations).toEqual([]);expect(coordinator.status()).toEqual({phase:'idle'});coordinator.close();
  });
  it('reports a retained sequence conflict accurately and sends nothing',async()=>{
    const f=await fixture();
    const coordinator=new NearbyLocalCoordinator(f.service,f.factory,undefined,undefined,async()=>({
      ...localNearbySource(f.service,f.sessionId,()=>{}),native:true,recover:async()=>{throw new NearbyDataError('native-sequence-conflict');}
    }));
    await expect(coordinator.recover(handle)).rejects.toMatchObject({code:'native-sequence-conflict'});
    expect(coordinator.status()).toEqual({phase:'failed',error:'native-sequence-conflict'});expect(f.operations).toEqual([]);
  });
  it('pairs without reading/exporting local source items', async () => {
    const f = await fixture(), capture = vi.spyOn(f.service, 'captureNearbyLocalRecords');
    const view = await f.coordinator.pair(); expect(view.phase).toBe('pairing');
    expect(capture).not.toHaveBeenCalled(); expect(f.operations).toEqual(['snapshot_pairing', 'start']);
    f.coordinator.close(); expect(f.transport.close).toHaveBeenCalled();
  });

  it('resends the live replica record instead of local deletions while incremental-only sync is on', async () => {
    const f = await fixture([createLoginItem({ title: 'Purged', password: 'purged secret' })]);
    const [purged] = (await f.service.readState(false)).items;
    await f.service.deleteItem(purged.id);
    await f.service.emptyLocalTrash();
    expect((await f.service.readState(false)).nearbyRetainedLocals).toEqual([`local:${purged.id}`]);
    const trashed = await f.service.upsertItem(createLoginItem({ title: 'Trashed', password: 'synthetic password' }));
    const live = new Map([[trashed.id, await nearbyLocalItemToWire(trashed, {})], [purged.id, await nearbyLocalItemToWire(purged, {})]]);
    const original = f.transport.call.getMockImplementation()!;
    f.transport.call.mockImplementation(async (operation, input = {}) => {
      if (operation !== 'replica_local') return original(operation, input);
      const ids = input.local_ids as string[];
      return { items: [...live.entries()].filter(([id]) => ids.includes(`local:${id}`)).map(([id, data]) =>
        ({ local_id: `local:${id}`, global_id: crypto.randomUUID(), deleted: false, data })) } as any;
    });
    await f.service.deleteItem(trashed.id);
    await f.coordinator.prepare(peer.deviceId);
    const scan = f.params.filter((_, index) => f.operations[index] === 'replica_scan_batch').flatMap(row => row.entries as any[]);
    expect(scan.map(row => [row.local_id, row.deleted]).sort()).toEqual([[`local:${trashed.id}`, false], [`local:${purged.id}`, false]].sort());
    expect(scan.find(row => row.local_id === `local:${purged.id}`)?.data).toEqual(live.get(purged.id));
    expect(f.params.filter((_, index) => f.operations[index] === 'replica_local').every(row => row.include_data === true)).toBe(true);
  });

  it('sends local deletions to the peer when incremental-only sync is turned off', async () => {
    const f = await fixture([createLoginItem({ title: 'Trashed', password: 'synthetic password' })]);
    const [trashed] = (await f.service.readState(false)).items;
    const preferences = await f.service.nearbySessionPreferences(f.sessionId);
    await f.service.updateNearbyPreferences({ kind: 'preferences', incrementalOnly: false }, preferences.epoch, f.sessionId);
    await f.service.deleteItem(trashed.id);
    await f.coordinator.prepare(peer.deviceId);
    const scan = f.params.filter((_, index) => f.operations[index] === 'replica_scan_batch').flatMap(row => row.entries as any[]);
    expect(scan).toEqual([expect.objectContaining({ local_id: `local:${trashed.id}`, deleted: true })]);
    expect(f.operations).not.toContain('replica_local');
  });

  it('does not revive a closed coordinator while vault initialization is awaiting', async () => {
    const f = await fixture(), saved = await f.service.nearbySessionPreferences(f.sessionId);
    let resume!: (value: typeof saved) => void;
    const gate = new Promise<typeof saved>(resolve => { resume = resolve; });
    vi.spyOn(f.service, 'nearbySessionPreferences').mockReturnValueOnce(gate);
    const operation = f.coordinator.pair(); await vi.waitFor(() => expect(f.service.nearbySessionPreferences).toHaveBeenCalled());
    f.coordinator.close(); resume(saved);
    await expect(operation).rejects.toThrow('session-closed'); expect(f.factory).not.toHaveBeenCalled();
  });

  it.each(['edit', 'lock', 'forget'] as const)('does not start a prepared snapshot after %s', async action => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId);
    if (action === 'edit') await f.service.upsertItem({ ...(await f.service.readState()).items[0], notes: 'edited later' });
    if (action === 'lock') await f.service.lock();
    if (action === 'forget') {
      const p = await f.service.nearbySessionPreferences(f.sessionId);
      await f.service.updateNearbyPreferences({ kind: 'forget', deviceId: peer.deviceId }, p.epoch, f.sessionId);
    }
    await expect(f.coordinator.start()).rejects.toThrow(); expect(f.operations).not.toContain('start'); expect(f.transport.close).toHaveBeenCalled();
  });

  it('requires current per-peer consent for restricted keys before network disclosure', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const key: PasskeyItem = { ...createLoginItem({ title: 'Restricted key' }), kind: 'passkey', rpId: 'example.test', rpName: 'Example',
      userHandle: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic', credentialId: 'AQID', signCount: 0, algorithm: -7, discoverable: true,
      backupEligible: false, sourceMode: 'browser-local', publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
      privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))) };
    const f = await fixture([key]), view = await f.coordinator.prepare(peer.deviceId);
    expect(view.phase).toBe('review'); expect(view.review?.peers).toEqual([peer.deviceId]);
    expect(JSON.stringify(view)).not.toContain(key.privateKeyPkcs8);
    await f.coordinator.confirm(view.review!.id);
    const started = await f.coordinator.start(); expect(started.phase).toBe('transferring');
    expect(JSON.stringify(started)).not.toContain(peer.trustedKey); expect(started.role).toBe('dialing');
    expect(started.endpoint).toEqual({ addresses: ['192.168.1.20', '10.0.0.7'], port: 5555 });
    f.coordinator.close();
    const blocked = await fixture([key]); await blocked.coordinator.prepare(peer.deviceId);
    await expect(blocked.coordinator.start()).rejects.toThrow('not-ready'); expect(blocked.operations).not.toContain('start');
  });

  it('rejects an external endpoint before constructing a trusted network connection', async () => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId);
    await expect(f.coordinator.start({ addresses: ['8.8.8.8'], port: 42 })).rejects.toThrow('local-network-only');
    expect(f.operations).not.toContain('connect');
  });

  it('reopens native ownership after completion and a different unlocked vault session', async () => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId); await f.coordinator.start();
    const original = f.transport.call.getMockImplementation()!;
    let phase = 'received';
    f.transport.call.mockImplementation(async operation => operation === 'progress' ? ({ phase, peer: {
      device_id: peer.deviceId, name: peer.name, revision: 'remote-revision', content_type: 'vault', vault_content_version: 2,
      receive_content: false, pairing: {}, sync_request: 0, interval_seconds: 60, settings_version: 0, settings_writer: ''
    } } as any) : original(operation));
    await f.coordinator.poll();
    expect((await f.service.nearbySessionPreferences(f.sessionId)).peers[0].lastSyncedAt).toBe(0);
    phase = 'confirming'; await f.coordinator.poll();
    expect(f.coordinator.status().phase).toBe('confirming');
    expect(f.coordinator.status().result).toBeUndefined();
    expect((await f.service.nearbySessionPreferences(f.sessionId)).peers[0].lastSyncedAt).toBe(0);
    phase = 'completed'; await f.coordinator.poll();
    expect((await f.service.nearbySessionPreferences(f.sessionId)).peers[0].lastSyncedAt).toBeGreaterThan(0);
    expect(f.coordinator.status().result).toMatchObject({processed:0,items:[]});
    expect(f.coordinator.status().phase).toBe('completed');
    await f.service.lock(); await f.service.unlock('');
    expect(await f.service.passkeySessionId()).not.toBe(f.sessionId);
    await f.coordinator.pair();
    expect(f.transport.close).toHaveBeenCalledOnce(); expect(f.factory).toHaveBeenCalledTimes(2);
  });

  it('does not acknowledge pairing sessions that unexpectedly contain vault content', async () => {
    const f = await fixture(); await f.coordinator.pair();
    f.transport.call.mockImplementationOnce(async () => ({ phase: 'received', peer: { device_id: 'new-phone', content_type: 'vault', vault_content_version: 2,
      revision: 'contains-content', receive_content: true } }) as any);
    const before = await f.storage.read(); await expect(f.coordinator.poll()).rejects.toThrow('unexpected-pairing-mode');
    expect(await f.storage.read()).toEqual(before); expect(f.operations).not.toContain('acknowledge');
  });
  it('keeps the last successful sync unchanged when the peer rejects its save', async () => {
    const f=await fixture(); await f.coordinator.prepare(peer.deviceId); await f.coordinator.start();
    const original=f.transport.call.getMockImplementation()!;let rejected=false;
    f.transport.call.mockImplementation(async op=>op==='progress' ? (rejected ? {phase:'failed',error:'peer_merge_failed'} : {phase:'received',peer:{device_id:peer.deviceId,name:peer.name,revision:'remote',content_type:'vault',vault_content_version:2,receive_content:false,pairing:{},sync_request:0,interval_seconds:60,settings_version:0,settings_writer:''}}) as any : original(op));
    await f.coordinator.poll();rejected=true;
    await expect(f.coordinator.poll()).rejects.toMatchObject({code:'peer-save-rejected'});
    expect((await f.service.nearbySessionPreferences(f.sessionId)).peers[0].lastSyncedAt).toBe(0);
    expect(f.coordinator.status().result).toBeUndefined();
  });
});

describe('nearby connection roles and recovery hints', () => {
  const progress = (address = '192.168.1.20') => ({ phase: 'received', remote_address: address, transferred: 10, total: 20, peer: {
    device_id: peer.deviceId, name: peer.name, revision: 'remote-revision', content_type: 'vault', vault_content_version: 2,
    receive_content: false, pairing: {}, sync_request: 0, interval_seconds: 60, settings_version: 0, settings_writer: '' } });

  it('dials an Android peer with the greater ID instead of also listening', async () => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId);
    const view = await f.coordinator.start();
    expect(f.operations).toContain('discover'); expect(f.operations).not.toContain('start');
    const connect = f.params[f.operations.indexOf('connect')];
    expect(connect.invitation).toBe(`monica-lan:2:192.168.1.20,10.0.0.7:5555:${peer.trustedKey}`);
    expect(connect.expected_device_id).toBe(peer.deviceId); expect(view.phase).toBe('transferring');
  });

  it('listens with the trusted key when the browser has the greater ID', async () => {
    const lower = { ...peer, deviceId: '0' }, f = await fixture(undefined, lower);
    await f.coordinator.prepare(lower.deviceId); const view = await f.coordinator.start();
    expect(f.operations).not.toContain('discover'); expect(f.operations).toContain('start');
    expect(view.role).toBe('listening'); expect(view.endpoint).toEqual({ addresses: ['127.0.0.1'], port: 12345 });
  });

  it('ignores untrusted or differently paired advertisements and reports a missing phone', async () => {
    const f = await fixture(undefined, peer, [{ ...discovered, trusted: false }, { ...discovered, session: 'other-pair' }, { ...discovered, address: '8.8.8.8', addresses: [] }]);
    vi.spyOn(f.coordinator as any, 'pause').mockResolvedValue(undefined);
    await f.coordinator.prepare(peer.deviceId);
    await expect(f.coordinator.start()).rejects.toThrow('peer-not-found');
    expect(f.operations).not.toContain('connect'); expect(f.coordinator.status()).toMatchObject({ phase: 'failed', error: 'peer-not-found' });
  }, 15_000);

  it('remembers the authenticated peer address and probes it on the next sync', async () => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId); await f.coordinator.start();
    const original = f.transport.call.getMockImplementation()!;
    let phase: string = 'received';
    f.transport.call.mockImplementation(async (operation, input) => operation === 'progress' ? ({ ...progress(), phase } as any) : original(operation, input));
    const received = await f.coordinator.poll(); expect(received.transport).toEqual({ stage: 'received', transferred: 10, total: 20 });
    phase = 'completed'; await f.coordinator.poll();
    const saved = (await f.service.nearbySessionPreferences(f.sessionId)).peers.find(entry => entry.deviceId === peer.deviceId)!;
    expect(saved.address).toBe('192.168.1.20');
    f.transport.call.mockImplementation(original); await f.coordinator.prepare(peer.deviceId); await f.coordinator.start();
    const probes = f.params.filter((_, index) => f.operations[index] === 'discover');
    expect(probes[probes.length - 1]).toEqual({ targets: ['192.168.1.20'], multicast: true });
  });

  it('reports the native transfer failure code instead of a generic failure', async () => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId); await f.coordinator.start();
    f.transport.call.mockImplementationOnce(async () => ({ phase: 'failed', error: 'connection_failed' }) as any);
    await expect(f.coordinator.poll()).rejects.toThrow('connection-failed');
  });

  it('keeps native-host installation and engine codes for the manager', async () => {
    const { Mdbx2NativeHostError } = await import('../providers/mdbx2/native-contract');
    const f = await fixture();
    f.transport.call.mockRejectedValueOnce(new Mdbx2NativeHostError('native-host-not-installed', 'secret path C:\\Users', false));
    await expect(f.coordinator.pair()).rejects.toThrow('native-host-not-installed');
    const g = await fixture();
    g.transport.call.mockImplementation(async operation => {
      if (operation === 'snapshot_pairing') return { handle, revision: 'pairing-only-v1' } as any;
      throw new Mdbx2NativeHostError('nearby-engine-error', 'Nearby: listen_failed.', false);
    });
    await expect(g.coordinator.pair()).rejects.toThrow('listen-failed');
  });

  it('accepts a pasted invitation with surrounding whitespace and explains unusable invitations', async () => {
    const f = await fixture();
    await f.coordinator.pair(`  monica-lan:2:192.168.1.20:5555:${peer.trustedKey}\n`);
    expect(f.params[f.operations.indexOf('connect')].invitation).toBe(`monica-lan:2:192.168.1.20:5555:${peer.trustedKey}`);
    f.coordinator.close();
    await expect((await fixture()).coordinator.pair(`monica-lan:1:192.168.1.20:5555:${peer.trustedKey}`)).rejects.toThrow('unsupported-protocol');
    const g = await fixture(); g.transport.call.mockImplementation(async operation => operation === 'start'
      ? { handle, code: 'x', invitations: [] } as any : { handle, revision: 'pairing-only-v1' } as any);
    await expect(g.coordinator.pair()).rejects.toThrow('no-local-network');
  });
});

describe('nearby pagination and complete dependency grouping', () => {
  async function records(count: number): Promise<NearbyIncomingRecord[]> {
    const data = await nearbyLocalItemToWire(createLoginItem({ title: 'Synthetic' }), {});
    return Array.from({ length: count }, (_, index) => ({ id: `record-${String(index).padStart(4, '0')}`, deleted: false, clockJson: '{"peer":1}', dataJson: JSON.stringify(data) }));
  }
  const nativeRow = (row: NearbyIncomingRecord) => ({ record: { id: row.id, deleted: row.deleted, clock: JSON.parse(row.clockJson), data: JSON.parse(row.dataJson) }, local_id: null, scope: null, expected_guard: null });
  it('collects all pages before grouping dependencies that cross page boundaries', async () => {
    const rows = await records(301), data = JSON.parse(rows[0].dataJson); data.extensions.bound_note_entry_id = rows[300].id; rows[0].dataJson = JSON.stringify(data);
    const call = vi.fn(async (_operation: string, params: any) => params.after === undefined
      ? { total: 301, items: rows.slice(0, 256).map(nativeRow), next_cursor: rows[255].id }
      : { total: 301, items: rows.slice(256).map(nativeRow), next_cursor: null });
    const collected = await collectNearbyPending({ call } as any, handle); expect(collected).toEqual(rows);
    const groups = groupNearbyPending(collected); expect(groups.flat()).toHaveLength(301);
    expect(groups.every(group => group.length <= 200)).toBe(true);
    expect(groups.find(group => group.some(row => row.id === rows[0].id))!.some(row => row.id === rows[300].id)).toBe(true);
    expect(call.mock.calls[1][1].after).toBe(rows[255].id);
  });
  it('rejects oversized connected projects before any partial adoption', async () => {
    const rows = await records(201);
    for (const row of rows) { const data = JSON.parse(row.dataJson); data.extensions.password_group_id = 'same-project'; row.dataJson = JSON.stringify(data); }
    expect(() => groupNearbyPending(rows)).toThrow('project-batch-limit');
  });
  it('groups authenticated canonical aliases with dependencies before splitting batches', async () => {
    const rows = await records(201), data = JSON.parse(rows[0].dataJson);
    data.extensions.bound_note_entry_id = 'original-note-alias'; rows[0].dataJson = JSON.stringify(data);
    const groups = groupNearbyPending(rows, new Map([['original-note-alias', rows[200].id]]));
    expect(groups[0].some(row => row.id === rows[200].id)).toBe(true);
    expect(groups.flat()).toHaveLength(201);
  });
  it.each(['cursor', 'total', 'duplicate'] as const)('rejects inconsistent native %s pages', async fault => {
    const rows = await records(2);
    const call = vi.fn().mockResolvedValueOnce({ total: 2, items: [nativeRow(rows[0])], next_cursor: fault === 'cursor' ? 'missing' : rows[0].id })
      .mockResolvedValueOnce({ total: fault === 'total' ? 3 : 2, items: [nativeRow(fault === 'duplicate' ? rows[0] : rows[1])], next_cursor: null });
    await expect(collectNearbyPending({ call } as any, handle)).rejects.toThrow();
  });
});


describe('authenticated discovery hints', () => {
  it('cancels discovery before any connection and never releases an active listener', async () => {
    const f = await fixture(); await f.coordinator.prepare(peer.deviceId);
    const start = f.coordinator.start();
    const rejected = expect(start).rejects.toMatchObject({ code: 'session-closed' });
    await vi.waitFor(() => expect(f.operations).toContain('discover'));
    f.coordinator.close(); await rejected;
    expect(f.operations).not.toContain('start'); expect(f.operations).not.toContain('connect');
    expect(f.operations).not.toContain('release'); expect(f.transport.close).toHaveBeenCalled();
  });
  it('uses saved names and matching device/pair identities; never exposes trust keys', async () => {
    const f=await fixture(); const original=f.transport.call.getMockImplementation()!;
    f.transport.call.mockImplementation(async op => op==='discover' ? {handle} : op==='discovery_result' ? ({ready:true,result:{devices:[
      {protocol:'monica-lan',version:2,trusted:true,device_id:peer.deviceId,session:'wrong-pair',address:'10.0.0.2',port:90},
      {protocol:'monica-lan',version:2,trusted:true,device_id:peer.deviceId,session:peer.pairId,address:'8.8.8.8',port:90},
      {protocol:'monica-lan',version:2,trusted:true,device_id:peer.deviceId,session:peer.pairId,name:'untrusted name',address:'192.168.1.10',port:9000},
      {protocol:'monica-lan',version:2,trusted:true,device_id:'unknown',session:peer.pairId,address:'192.168.1.11',port:9000}
    ]}} as any) : original(op));
    expect(await f.coordinator.discover()).toEqual({searching:true,devices:[]});
    const result=await f.coordinator.discoveryProgress();
    expect(result).toEqual({searching:false,devices:[{deviceId:peer.deviceId,name:peer.name,endpoint:{addresses:['192.168.1.10'],port:9000}}]});
    expect(JSON.stringify(result)).not.toContain(peer.trustedKey);
    expect(f.operations).not.toContain('replica_export');f.coordinator.close();
  });
  it('rejects WAN probes before native networking',async()=>{
    const f=await fixture();await expect(f.coordinator.discover('1.1.1.1')).rejects.toThrow('local-network-only');
    expect(f.transport.call).not.toHaveBeenCalled();
  });
  it('does not replace a prepared snapshot with a discovery session',async()=>{
    const f=await fixture();await f.coordinator.prepare(peer.deviceId);await expect(f.coordinator.discover()).rejects.toThrow('busy');
    expect(f.operations).not.toContain('discover');
  });
});
