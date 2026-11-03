import { localNearbySource, type NearbySourceAdapter, type NearbySourceSnapshot } from './source-adapter';
import type { NearbyAcknowledgement } from './native-journal';
import { NEARBY_ENTRY_TYPES, remapNearbyReferences, type NearbyEntryType, type NearbyWireData } from './wire-shape';
import { parseLosslessJson } from '../core/lossless-json';
import { bytesToBase64 } from '../security/encoding';
import type { SecureVaultService } from '../security/secure-vault-service';
import { NearbyNativeTransport, NearbyTransportError, nearbySha256, appendNearbyAsset, readNearbyAsset, type NearbyAsset, type NearbyOperation } from './native-transport';
import { NearbyPasskeyConsent, type NearbyPasskeyReview } from './passkey-consent';
import { nearbyDeviceHello, nearbySettingsCounter, type NearbyPreferences, type NearbySavedPeer } from './preferences';
import { collectNearbyPending, groupNearbyPending, nearbyApplicationReferences } from './pending';
import { nearbyHierarchyReferences, scheduleNearbyNativeGroups } from './native-schedule';
import { adoptNearbyNativeGroups } from './native-batches';
import type { NearbyIncomingRecord } from './local-adoption';
import { NearbyDataError, wireInteger, wireObject, wireText } from './wire-shape';
import { nearbyEngineCode, nearbyErrorCode } from './errors';
import { parseNearbyHotspotInvitation } from './hotspot-invitation';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';

type Store = Pick<SecureVaultService, 'passkeySessionId' | 'nearbySessionPreferences' | 'assertNearbySession' | 'updateNearbyPreferences'
  | 'captureNearbyLocalRecords' | 'nearbyLocalSnapshotHash' | 'nearbySavedAcknowledgements' | 'nearbyPendingPasswordGroups' | 'adoptNearbyLocalTransaction'>;
export interface NearbyEndpoint { addresses: string[]; port: number }
export interface NearbyDiscoveredPeer { deviceId: string; name: string; endpoint: NearbyEndpoint }
export interface NearbyDiscoveryView { searching: boolean; devices: NearbyDiscoveredPeer[] }
export interface NearbySyncResult {
  sent: boolean; received: boolean; processed: number; deleted: number;
  /** Explicit per-transfer exception to incremental-only sending. */
  includedDeletions?: number;
  items: { title: string; type: NearbyEntryType | 'unknown'; deleted: boolean }[];
}
/** Android: the greater device ID listens, the smaller one discovers and dials. */
export type NearbyConnectionRole = 'listening' | 'dialing';
export interface NearbyCoordinatorView {
  phase: 'idle' | 'pairing' | 'preparing' | 'review' | 'ready' | 'transferring' | 'saving' | 'confirming' | 'completed' | 'failed' | 'cancelled';
  kind?: 'pairing' | 'sync'; result?: NearbySyncResult;
  operationId?: string; peerId?: string; peerName?: string; recoveryOnly?: boolean;
  pairing?: { code: string; invitations: string[] }; endpoint?: NearbyEndpoint; role?: NearbyConnectionRole;
  /** Native transfer stage and byte counters, for progress display only. */
  transport?: { stage: string; transferred: number; total: number };
  review?: NearbyPasskeyReview; applied?: number; error?: string;
  deletionReview?: { id: string; count: number; incoming?: boolean };
}
export class NearbyCoordinatorError extends Error {
  constructor(readonly code: string) { super(`Nearby: ${code}.`); this.name = 'NearbyCoordinatorError'; }
}
function failure(code: string): never { throw new NearbyCoordinatorError(code); }
const identity = /^[A-Za-z0-9_-]{1,64}$/;
const token = (value: unknown) => { const text = wireText(value); if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(text)) failure('invalid-handle'); return text; };
const string = (value: unknown, length = 128) => { const text = wireText(value); if (text.length > length || /[\u0000-\u001f\u007f-\u009f]/.test(text)) failure('invalid-peer'); return text; };
const validId = (value: unknown) => { const text = wireText(value); if (!identity.test(text)) failure('invalid-peer'); return text; };

function endpoint(value: unknown): NearbyEndpoint {
  const item = wireObject(value);
  // The native engine accepts at most eight invitation addresses.
  if (!Array.isArray(item.addresses) || !item.addresses.length || item.addresses.length > 8 || typeof item.port !== 'number'
    || !Number.isInteger(item.port) || item.port < 1 || item.port > 65535) failure('invalid-endpoint');
  const addresses = item.addresses.map(raw => {
    const address = string(raw, 15), parts = address.split('.');
    if (parts.length !== 4 || parts.some(p => !/^(?:0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255)) failure('invalid-endpoint');
    const [a, b] = parts.map(Number);
    if (!(a === 127 || a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254)) failure('local-network-only');
    return address;
  });
  if (new Set(addresses).size !== addresses.length) failure('invalid-endpoint');
  return { addresses, port: item.port };
}
function localAddress(value: string): boolean {
  try { endpoint({ addresses: [value], port: 1 }); return true; } catch { return false; }
}
function invitation(value: unknown): { address: NearbyEndpoint; key: string; text: string } {
  // Copied invitations commonly carry surrounding whitespace or a trailing newline.
  if (typeof value === 'string' && value.trim().startsWith('monica-hotspot:')) {
    const hotspot = parseNearbyHotspotInvitation(value);
    if (!hotspot) failure('invalid-invitation');
    value = hotspot.pairing;
  }
  const text = string(typeof value === 'string' ? value.trim() : value, 512), parts = text.split(':');
  if (parts.length === 5 && parts[0] === 'monica-lan' && parts[1] === '1') failure('unsupported-protocol');
  if (parts.length !== 5 || parts[0] !== 'monica-lan' || parts[1] !== '2' || !/^[A-Za-z0-9_-]{43}$/.test(parts[4]) || !/^[1-9]\d{0,4}$/.test(parts[3])) failure('invalid-invitation');
  return { address: endpoint({ addresses: parts[2].split(','), port: Number(parts[3]) }), key: parts[4], text };
}
function chunks<T>(items: readonly T[], maximum = 256): T[][] {
  const result: T[][] = []; let batch: T[] = [], bytes = 0;
  for (const item of items) {
    const size = new TextEncoder().encode(JSON.stringify(item)).length;
    if (size > 6 * 1024 * 1024) failure('record-limit');
    if (batch.length && (batch.length >= maximum || bytes + size > 6 * 1024 * 1024)) { result.push(batch); batch = []; bytes = 0; }
    batch.push(item); bytes += size;
  }
  if (batch.length) result.push(batch); return result;
}

/** One background-owned coordinator and dedicated native port. There is no raw
 * RPC/runtime exposure. Call close synchronously on lock, settings change or
 * manager disposal; every awaited boundary also checks the session/epoch. */
export class NearbyLocalCoordinator {
  private transport?: NearbyNativeTransport;
  private abort = new AbortController();
  private preferences?: NearbyPreferences;
  private sessionId?: string;
  private replica?: string;
  private snapshot?: string;
  private transfer?: string;
  private incomingReview?: { remote: Record<string, unknown>; revision: string };
  private sourceHash?: string;
  private revision = '';
  private peer?: NearbySavedPeer;
  private enrolling = false;
  private remoteAddress?: string;
  private acknowledged = false;
  private pendingRemote?: Record<string, unknown>;
  private result: NearbySyncResult = { sent: false, received: false, processed: 0, deleted: 0, items: [] };
  private reported = new Set<string>();
  private consent = new NearbyPasskeyConsent();
  private view: NearbyCoordinatorView = { phase: 'idle' };
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private discovery?: string;
  private source?: NearbySourceAdapter;
  private connectionDeadline = 0;

  constructor(private readonly store: Store, private readonly factory: () => NearbyNativeTransport, private readonly listenAddress?: string,
    private readonly assertOwner?: () => void,
    private readonly sourceFactory?: (preferences: NearbyPreferences, sessionId: string, signal: AbortSignal, active: () => void, epoch: () => string) => Promise<NearbySourceAdapter>) {}
  status(): NearbyCoordinatorView { return structuredClone(this.view); }
  close(): void {
    this.incomingReview = undefined;
    this.generation++;
    this.abort.abort(); this.transport?.close(); this.transport = undefined;
    this.consent.reset(); this.preferences = undefined; this.peer = undefined; this.sessionId = undefined;
    this.replica = this.snapshot = this.transfer = this.sourceHash = this.remoteAddress = undefined;
    this.discovery = undefined; this.source = undefined; this.connectionDeadline = 0;
    this.pendingRemote = undefined; this.result = { sent: false, received: false, processed: 0, deleted: 0, items: [] }; this.reported.clear();
    this.view = { phase: 'cancelled' };
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const generation = this.generation;
    const result = this.tail.then(async () => {
      try {
        this.assertOwner?.();
        if (generation !== this.generation) failure('session-closed');
        const result = await action();
        if (generation !== this.generation) failure('session-closed');
        return result;
      }
      catch (error) {
        const code = error instanceof NearbyCoordinatorError || error instanceof NearbyDataError ? error.code : nearbyErrorCode(error);
        this.close(); this.view = { phase: 'failed', error: code }; throw new NearbyCoordinatorError(code);
      }
    });
    this.tail = result.catch(() => {}); return result;
  }
  private async guard(source = false): Promise<void> {
    this.assertOwner?.();
    if (this.abort.signal.aborted || !this.preferences || !this.sessionId) failure('session-closed');
    await this.store.assertNearbySession(this.preferences.epoch, this.sessionId);
    if (this.abort.signal.aborted) failure('session-closed');
    if (source && this.sourceHash !== await this.source!.snapshotHash()) failure('source-changed');
    this.assertOwner?.();
    if (this.abort.signal.aborted) failure('session-closed');
  }
  /** Retain the exact operation generation across an encrypted store transaction. */
  private transactionGuard(): () => void {
    const generation = this.generation;
    return () => { this.assertOwner?.(); if (generation !== this.generation) failure('session-closed'); };
  }
  private async call(operation: NearbyOperation, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.guard();
    const result = wireObject(await this.transport!.call(operation, input, this.abort.signal));
    await this.guard(); return result;
  }
  private async initialize(): Promise<void> {
    if (!['idle', 'completed', 'failed', 'cancelled'].includes(this.view.phase)) failure('busy');
    const generation = this.generation;
    const previousSession = this.sessionId, previousStorage = this.preferences?.replicaStorageId;
    this.sessionId = await this.store.passkeySessionId() ?? failure('vault-locked');
    if (generation !== this.generation) failure('session-closed');
    this.preferences = await this.store.nearbySessionPreferences(this.sessionId, this.transactionGuard());
    if (generation !== this.generation) failure('session-closed');
    if (this.transport && (previousSession !== this.sessionId || previousStorage !== this.preferences.replicaStorageId)) {
      this.abort.abort(); this.transport.close(); this.transport = undefined;
      this.replica = this.snapshot = this.transfer = undefined;
    }
    if (!this.transport) { this.abort = new AbortController(); this.transport = this.factory(); }
    this.peer = undefined; this.sourceHash = this.remoteAddress = undefined; this.enrolling = false; this.acknowledged = false; this.consent.reset();
    this.pendingRemote = undefined; this.result = { sent: false, received: false, processed: 0, deleted: 0, items: [] }; this.reported.clear();
    this.source = this.sourceFactory ? await this.sourceFactory(this.preferences, this.sessionId, this.abort.signal, this.transactionGuard(), () => this.preferences!.epoch) : localNearbySource(this.store, this.sessionId, this.transactionGuard());
    await this.guard();
    this.view = { phase: 'preparing', kind: 'sync', operationId: crypto.randomUUID(), applied: 0 };
  }
  /** Discovery is only an address hint. Pair identity and the Noise handshake
   * authenticate the target; no advertised name or revision grants trust. */
  async discover(target?: string): Promise<NearbyDiscoveryView> {
    return this.run(async () => {
      if (this.discovery) failure('busy');
      await this.initialize();
      const targets = target ? endpoint({ addresses: [target], port: 1 }).addresses : undefined;
      this.discovery = token((await this.call('discover', targets ? { targets, multicast: false } : {})).handle);
      this.view = { phase: 'idle' };
      return { searching: true, devices: [] };
    });
  }
  async discoveryProgress(): Promise<NearbyDiscoveryView> {
    return this.run(async () => {
      if (!this.discovery) return { searching: false, devices: [] };
      const response = await this.call('discovery_result', { handle: this.discovery });
      if (response.ready === false) return { searching: true, devices: [] };
      this.discovery = undefined;
      const result = wireObject(response.result);
      if (response.ready !== true || !Array.isArray(result.devices) || result.devices.length > 256) failure('invalid-discovery');
      const devices: NearbyDiscoveredPeer[] = [], seen = new Set<string>();
      for (const value of result.devices) {
        try {
          const row = wireObject(value);
          if (row.protocol !== 'monica-lan' || row.version !== 2 || row.trusted !== true) continue;
          const peer = this.preferences!.peers.find(p => p.deviceId === row.device_id && p.pairId === row.session);
          if (!peer || seen.has(peer.deviceId)) continue;
          const address = endpoint({ addresses: row.address ? [row.address] : row.addresses, port: row.port });
          devices.push({ deviceId: peer.deviceId, name: peer.name, endpoint: address }); seen.add(peer.deviceId);
        } catch { /* Ignore malformed unauthenticated UDP announcements. */ }
      }
      return { searching: false, devices };
    });
  }
  async pair(link?: string): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      await this.initialize(); this.enrolling = true; this.view.kind = 'pairing';
      if (this.preferences!.peers.length >= 8) failure('peer-limit');
      const snapshot = await this.call('snapshot_pairing', { device_id: this.preferences!.deviceId });
      this.snapshot = token(snapshot.handle); this.revision = string(snapshot.revision);
      if (this.revision !== 'pairing-only-v1') failure('invalid-pairing-snapshot');
      const device = { ...nearbyDeviceHello(this.preferences!), sync_mode: 'bidirectional' };
      const started = await this.call(link ? 'connect' : 'start', { snapshot: this.snapshot, device,
        ...(link ? { invitation: invitation(link).text } : this.listenAddress ? { listen_address: this.listenAddress } : {}) });
      this.transfer = token(started.handle);
      const invitations = link ? [] : (Array.isArray(started.invitations) ? started.invitations.map(value => invitation(value).text) : failure('invalid-invitation'));
      // Without a private IPv4 interface the listener is unreachable; say so instead of showing an empty code.
      if (!link && !invitations.length) failure('no-local-network');
      this.view = { ...this.view, phase: 'pairing', role: link ? 'dialing' : 'listening',
        pairing: { code: started.code === undefined ? '' : string(started.code, 64), invitations } };
      return this.status();
    });
  }
  /** Finish only the already encrypted receive intent. No peer, discovery,
   * replica acknowledgement or outgoing transfer is needed. The next normal
   * synchronization acknowledges the durable receipts through saved(). */
  async recover(operationId: string): Promise<{ applied: number }> {
    return this.run(async () => {
      token(operationId);
      await this.initialize();
      if (!this.source!.native) failure('native-source-unavailable');
      const receipts = await this.source!.recover(operationId); await this.guard();
      this.view = { phase: 'idle' };
      return { applied: receipts.length };
    });
  }
  async reviewRecovery(operationId: string) {
    return this.run(async () => {
      token(operationId); await this.initialize();
      if (!this.source?.native || !this.source.reviewRecovery) failure('native-source-unavailable');
      const review = await this.source.reviewRecovery(operationId); await this.guard();
      this.view = { phase: 'idle' }; return review;
    });
  }
  async confirmRecovery(reviewId: string): Promise<{ applied: number }> {
    return this.run(async () => {
      token(reviewId); await this.guard();
      if (!this.source?.native || !this.source.confirmRecovery) failure('native-recovery-changed');
      const receipts = await this.source.confirmRecovery(reviewId); await this.guard();
      this.view = { phase: 'idle' }; return { applied: receipts.length };
    });
  }
  async prepare(peerId: string): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      await this.initialize(); this.peer = this.preferences!.peers.find(peer => peer.deviceId === peerId) ?? failure('peer-forgotten');
      this.view.peerId = this.peer.deviceId; this.view.peerName = this.peer.name;
      if (!this.replica) this.replica = token((await this.call('replica_open', {
        storage_id: this.preferences!.replicaStorageId, device_id: this.preferences!.deviceId, key: this.preferences!.replicaKey
      })).handle);
      const recovered = await this.source!.recover(); await this.guard();
      if (recovered.length) await this.applyAcknowledgements(recovered);
      let pending = await collectNearbyPending(this.transport!, this.replica, this.abort.signal, this.source!.scope);
      // Pending records may be left by an interrupted receive. A protected scan
      // must not shadow an actual deleted native item with that unapplied record.
      if (this.source!.native && !pending.length) {
        await this.refreshNativeBindings();
        pending = await collectNearbyPending(this.transport!, this.replica, this.abort.signal, this.source!.scope);
      }
      if (pending.length) {
        const saved = await this.source!.saved(pending);
        if (saved.length) { await this.applyAcknowledgements(saved); pending = await collectNearbyPending(this.transport!, this.replica, this.abort.signal, this.source!.scope); }
      }
      await this.guard();
      this.view.recoveryOnly = pending.length > 0;
      if (pending.length || this.preferences!.mode === 'receive_only') {
        this.sourceHash = await this.source!.snapshotHash();
        const empty = await this.call('snapshot_receive_only', { device_id: this.preferences!.deviceId });
        this.snapshot = token(empty.handle); this.revision = string(empty.revision); this.view.phase = 'ready';
      } else {
        const source = await this.source!.capture(); this.sourceHash = source.sourceHash;
        source.records = await this.prepareScanRecords(source);
        const review = await this.consent.review(source.records.map(row => ({ localId: row.local_id, deleted: row.deleted, data: row.data as NearbyWireData })),
          [peerId], `${this.sessionId}:${this.preferences!.epoch}:${source.sourceHash}:${this.view.operationId}`);
        await this.guard(true);
        await this.scan(source);
        this.view.phase = review || this.view.deletionReview ? 'review' : 'ready'; this.view.review = review;
      }
      return this.status();
    });
  }
  /** With incremental-only on, a scanned deletion is replaced by the replica's
   * exact current record: omitting it would synthesize a tombstone, while
   * resending stale data would bump its clock. Unbound ids are simply dropped. */
  private async prepareScanRecords(source: NearbySourceSnapshot): Promise<NearbySourceSnapshot['records']> {
    let records = source.records;
    if (this.source!.native) {
      const map = new Map<string, string>(), identified = new Set<string>();
      for (const part of chunks(records)) {
        const result = await this.call('replica_local', { handle: this.replica, local_ids: part.map(r => r.local_id) });
        if (!Array.isArray(result.items)) failure('invalid-binding');
        for (const raw of result.items) {
          const row = wireObject(raw), localId = string(row.local_id, 256), globalId = validId(row.global_id);
          const match = part.find(r => r.local_id === localId);
          if (!match || identified.has(match.global_id)) failure('invalid-binding');
          identified.add(match.global_id); map.set(match.global_id, globalId);
        }
      }
      records = records.map(r => ({ ...r, global_id: map.get(r.global_id) ?? r.global_id,
        data: Object.keys(r.data).length ? remapNearbyReferences(r.data as NearbyWireData, id => map.get(id) ?? id) : r.data }));
    }
    if (!this.preferences!.incrementalOnly) return records;
    const kept: NearbySourceSnapshot['records'] = [], shadowed = new Map<string, string>();
    for (const record of records) {
      if (record.deleted) shadowed.set(record.local_id, record.guard);
      else kept.push(record);
    }
    for (const id of source.retained ?? []) if (!shadowed.has(id) && !kept.some(row => row.local_id === id)) shadowed.set(id, '');
    if (!shadowed.size) return records;
    for (const part of chunks([...shadowed.keys()])) {
      const result = await this.call('replica_local', { handle: this.replica, local_ids: part, include_data: true });
      if (!Array.isArray(result.items)) failure('invalid-binding');
      const seen = new Set<string>();
      for (const raw of result.items) {
        const row = wireObject(raw), localId = string(row.local_id, 256);
        if (!shadowed.has(localId) || seen.has(localId) || typeof row.deleted !== 'boolean') failure('invalid-binding');
        const guard = shadowed.get(localId) || await hash(['nearby-retained', localId]);
        seen.add(localId);
        kept.push({ local_id: localId, global_id: validId(row.global_id), scope: this.source!.scope,
          guard, deleted: row.deleted, data: wireObject(row.data) as NearbyWireData });
      }
    }
    return kept;
  }
  private async applyScan(records: NearbySourceSnapshot['records']): Promise<void> {
    await this.call('replica_scan_begin', { handle: this.replica, scopes: [this.source!.scope] });
    for (const entries of chunks(records)) await this.call('replica_scan_batch', { handle: this.replica, entries });
    await this.guard(true); await this.call('replica_scan_end', { handle: this.replica });
  }
  private async refreshNativeBindings(): Promise<NearbySourceSnapshot> {
    const source = await this.source!.capture(); this.sourceHash = source.sourceHash;
    source.records = await this.prepareScanRecords(source);
    await this.applyScan(source.records);
    return source;
  }
  private async captureNativeBindings(): Promise<NearbySourceSnapshot> {
    await this.guard(true);
    const source = await this.source!.capture();
    if (source.sourceHash !== this.sourceHash) failure('source-changed');
    return source;
  }
  private async scan(source: NearbySourceSnapshot): Promise<void> {
    await this.applyScan(source.records);
    const count = await this.exportSource(source, this.preferences!.incrementalOnly ? 'omit' : undefined);
    if (count > 0 && this.preferences!.incrementalOnly) this.view.deletionReview = { id: crypto.randomUUID(), count };
  }
  private async exportSource(source: NearbySourceSnapshot, policy?: 'omit' | 'include'): Promise<number> {
    let exported: Record<string, unknown>;
    try { exported = await this.call('replica_export', { handle: this.replica, ...(policy ? { deletion_policy: policy } : {}) }); }
    catch (error) {
      if (policy && nearbyErrorCode(error) === 'nearby-invalid-request') failure('host-update-required');
      throw error;
    }
    // Older helpers must fail closed, even if they silently ignore the policy.
    if (policy && (exported.deletion_policy !== policy || typeof exported.deletion_count !== 'number'
      || !Number.isSafeInteger(exported.deletion_count) || exported.deletion_count < 0 || exported.deletion_count > 100_000)) failure('host-update-required');
    if (exported.pending !== false || !Array.isArray(exported.asset_ids)) failure('pending-adoption-required');
    this.snapshot = token(exported.handle); this.revision = string(exported.revision);
    const required = new Set(exported.asset_ids.map(value => string(value, 64)));
    for (const id of required) {
      const bytes = await source.readAsset(id);
      try { await this.guard(); await appendNearbyAsset(this.transport!, this.snapshot, { id, size: bytes.length }, bytes, this.abort.signal); }
      finally { bytes.fill(0); }
    }
    await this.guard(true);
    return policy ? exported.deletion_count as number : 0;
  }
  async confirm(reviewId: string): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      await this.guard(true);
      if (this.view.phase !== 'review' || !this.consent.confirm(reviewId)) failure('review-stale');
      delete this.view.review; this.view.phase = this.view.deletionReview ? 'review' : 'ready'; return this.status();
    });
  }
  async confirmDeletions(reviewId: string, choice: 'omit' | 'include'): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      await this.guard(true);
      const review = this.view.deletionReview;
      if (this.view.phase !== 'review' || !review || review.id !== reviewId || !['omit', 'include'].includes(choice)) failure('review-stale');
      if (this.incomingReview) {
        const incoming = this.incomingReview;
        await this.adopt(choice, incoming.revision);
        await this.finishReceive(incoming.remote);
        this.incomingReview = undefined;
        delete this.view.deletionReview;
        this.view.phase = 'confirming';
        return this.status();
      }
      if (choice === 'include') {
        const source = await this.source!.capture();
        await this.guard(true);
        const previous = this.snapshot;
        const count = await this.exportSource(source, 'include');
        if (count !== review.count) failure('review-stale');
        if (previous) await this.call('snapshot_release', { handle: previous });
        this.result.includedDeletions = count;
      }
      delete this.view.deletionReview;
      this.view.phase = this.view.review ? 'review' : 'ready';
      return this.status();
    });
  }
  async start(address?: NearbyEndpoint): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      if (this.view.phase !== 'ready' || !this.peer || !this.snapshot) failure('not-ready');
      this.connectionDeadline = Date.now() + 120_000;
      return this.connectPrepared(address);
    });
  }
  private async connectPrepared(address?: NearbyEndpoint): Promise<NearbyCoordinatorView> {
      if (!this.peer || !this.snapshot) failure('not-ready');
      await this.guard(true);
      const device = nearbyDeviceHello(this.preferences!, this.peer.deviceId);
      if (this.view.recoveryOnly) device.sync_mode = 'receive_only';
      // Android listens only when its ID is greater and otherwise dials the
      // advertised listener. Mirror that rule so both sides never wait at once.
      const target = address ? endpoint(address) : this.role() === 'dialing' ? await this.locate() : undefined;
      await this.guard(true);
      const started = await this.call(target ? 'connect' : 'start', { snapshot: this.snapshot, device, expected_device_id: this.peer.deviceId,
        ...(target ? { invitation: `monica-lan:2:${target.addresses.join(',')}:${target.port}:${this.peer.trustedKey}` }
          : { trusted_key: this.peer.trustedKey, ...(this.listenAddress ? { listen_address: this.listenAddress } : {}) }) });
      this.transfer = token(started.handle); this.view.phase = 'transferring'; this.view.role = target ? 'dialing' : 'listening';
      if (target) this.view.endpoint = target;
      else {
        if (!Array.isArray(started.invitations) || !started.invitations.length) failure('no-local-network');
        const link = invitation(started.invitations[0]); if (link.key !== this.peer.trustedKey) failure('peer-key-changed');
        this.view.endpoint = link.address;
      }
      return this.status();
  }
  private role(): NearbyConnectionRole {
    return this.preferences!.deviceId < this.peer!.deviceId ? 'dialing' : 'listening';
  }
  private pause(milliseconds: number): Promise<void> {
    const signal = this.abort.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new NearbyCoordinatorError('session-closed')); return; }
      const aborted = () => { clearTimeout(timer); reject(new NearbyCoordinatorError('session-closed')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, milliseconds);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
  /** Find the paired listener by its authenticated pair ID. Unicast probes to the
   * last known address still work where Wi-Fi access points filter multicast. */
  private async locate(): Promise<NearbyEndpoint> {
    const peer = this.peer!;
    // The phone may still be exporting its selected vault. Retain the explicit
    // request while it becomes ready, with the same bounded window as Android.
    for (let round = 0; round < 60 && Date.now() < this.connectionDeadline; round++) {
      await this.guard(true);
      if (round > 0) await this.pause(1_000);
      const begun = await this.call('discover', { targets: peer.address ? [peer.address] : [], multicast: true });
      const discovery = token(begun.handle);
      let result: Record<string, unknown> | undefined;
      for (let wait = 0; wait < 40 && !result; wait++) {
        await this.pause(200);
        const polled = await this.call('discovery_result', { handle: discovery });
        if (polled.ready === true) result = wireObject(polled.result);
      }
      if (!result || !Array.isArray(result.devices) || result.devices.length > 256) failure('discovery-unavailable');
      for (const raw of result.devices) {
        const found = wireObject(raw);
        if (found.protocol !== 'monica-lan' || found.version !== 2 || found.device_id !== peer.deviceId || found.session !== peer.pairId || found.trusted !== true) continue;
        const candidates = [found.address, ...(Array.isArray(found.addresses) ? found.addresses : [])].filter(value => typeof value === 'string');
        try { return endpoint({ addresses: [...new Set(candidates)].slice(0, 8), port: found.port }); } catch { /* Ignore an unusable advertisement. */ }
      }
    }
    failure('peer-not-found');
  }
  async poll(): Promise<NearbyCoordinatorView> {
    return this.run(async () => {
      if (!this.transfer) return this.status();
      if (this.incomingReview) { await this.guard(true); return this.status(); }
      await this.guard(!this.enrolling && !this.acknowledged);
      const progress = await this.call('progress', { handle: this.transfer });
      if (progress.phase === 'failed' || progress.phase === 'cancelled') {
        if (progress.phase === 'failed' && !this.enrolling && !this.acknowledged &&
          Date.now() < this.connectionDeadline && ['connecting', 'authenticating', 'transferring'].includes(String(progress.failed_at)) &&
          ['connection_failed', 'connection_closed', 'transfer_timeout'].includes(String(progress.error))) {
          // A paired listener can be replaced while the phone finishes preparing.
          // Before any application/receipt, reconnect with the same immutable
          // snapshot. The native engine negotiates a verified ciphertext prefix
          // inside a fresh Noise handshake. Save/authentication failures reject.
          await this.call('release', { handle: this.transfer }); this.transfer = undefined;
          await this.pause(1_000);
          return this.connectPrepared();
        }
        if (progress.error === 'peer_merge_failed') failure('peer-save-rejected');
        if (progress.error === 'merge_timeout') failure('peer-save-timeout');
        failure(nearbyEngineCode(progress.error) ?? 'transfer-failed');
      }
      if (progress.phase === 'confirming') this.view.phase = 'confirming';
      if (typeof progress.phase === 'string' && /^[a-z_]{1,32}$/.test(progress.phase)) {
        const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
        this.view.transport = { stage: progress.phase, transferred: count(progress.transferred) + count(progress.resumed), total: count(progress.total) };
      }
      if (typeof progress.remote_address === 'string') this.remoteAddress = progress.remote_address;
      if (progress.phase === 'received' && !this.acknowledged) {
        const remote = wireObject(progress.peer), id = validId(remote.device_id);
        if (id === this.preferences!.deviceId || this.peer && this.peer.deviceId !== id || remote.content_type !== 'vault' || remote.vault_content_version !== 2) failure('unexpected-peer');
        if (this.enrolling && remote.revision !== 'pairing-only-v1' || !this.enrolling && remote.revision === 'pairing-only-v1') failure('unexpected-pairing-mode');
        if (typeof remote.receive_content !== 'boolean') failure('invalid-peer');
        this.view.phase = 'saving'; delete this.view.pairing; delete this.view.endpoint;
        if (!this.enrolling && remote.receive_content) {
          let revision: string | undefined;
          if (this.transport?.supportsIncrementalSync) {
            const preview = await this.call('replica_merge_preview', { handle: this.replica, session: this.transfer });
            const count = Number(wireInteger(preview.deletions, 100_000n));
            revision = string(preview.review_revision, 64);
            if (!/^[a-f0-9]{64}$/.test(revision)) failure('invalid-response');
            if (count && this.preferences!.incrementalOnly) {
              this.incomingReview = { remote: structuredClone(remote), revision };
              this.view.phase = 'review'; this.view.deletionReview = { id: crypto.randomUUID(), count, incoming: true };
              return this.status();
            }
          }
          await this.adopt('include', revision);
        }
        await this.finishReceive(remote);
      }
      if (progress.phase === 'completed') {
        if (!this.acknowledged) failure('unexpected-completion');
        if (!this.enrolling) {
          if (!this.pendingRemote) failure('unexpected-completion');
          await this.remember(this.pendingRemote); this.pendingRemote = undefined;
          this.view.result = structuredClone(this.result);
        }
        await this.call('release', { handle: this.transfer }); this.transfer = undefined;
        if (this.snapshot) await this.call('snapshot_release', { handle: this.snapshot }); this.snapshot = undefined;
        this.consent.reset(); this.view.phase = 'completed';
      }
      return this.status();
    });
  }
  private async applyAcknowledgements(acks: NearbyAcknowledgement[]): Promise<void> {
    for (const part of chunks(acks.map(row => ({ record_id: row.recordId, clock: parseLosslessJson(row.clockJson), local_id: row.localId,
      scope: row.scope, guard: row.guard, data: parseLosslessJson(row.dataJson) })))) await this.call('replica_applied_batch', { handle: this.replica, items: part });
  }
  private async finishReceive(remote: Record<string, unknown>): Promise<void> {
    this.result.sent = remote.send_content === true; this.result.received = remote.receive_content === true;
    if (this.enrolling) await this.remember(remote);
    else this.pendingRemote = structuredClone(remote);
    await this.call('acknowledge', { handle: this.transfer, success: true }); this.acknowledged = true;
  }
  private async readIncomingAsset(asset: NearbyAsset, captured?: NearbySourceSnapshot): Promise<Uint8Array> {
    try { return await readNearbyAsset(this.transport!, this.transfer!, asset, this.abort.signal); }
    catch (error) {
      if (!this.transport?.supportsIncrementalSync || !(error instanceof NearbyTransportError) || error.code !== 'asset-missing') throw error;
      // A delta can omit bytes already verified by this receiver. Reuse only
      // an asset present in the current authorized source, never peer claims.
      await this.guard(true);
      const source = captured ?? await this.source!.capture();
      if (source.sourceHash !== this.sourceHash) failure('source-changed');
      const present = source.records.some(row => Array.isArray(row.data.assets) && row.data.assets.some(raw => {
        const entry = wireObject(raw);
        return entry.id === asset.id && Number(wireInteger(entry.size, 16n * 1024n * 1024n)) === asset.size;
      }));
      if (!present) throw error;
      const bytes = await source.readAsset(asset.id);
      try {
        if (bytes.length !== asset.size || await nearbySha256(bytes) !== asset.id) failure('asset-integrity');
        await this.guard(true); return bytes;
      } catch (failure) { bytes.fill(0); throw failure; }
    }
  }
  private async adopt(policy: 'omit' | 'include' = 'include', revision?: string): Promise<void> {
    await this.guard(true); await this.call('replica_merge', { handle: this.replica, session: this.transfer,
      ...(this.transport?.supportsIncrementalSync ? { deletion_policy: policy, ...(revision ? { review_revision: revision } : {}) } : {}) });
    let rounds = 0;
    do {
    if (++rounds > 20_000) failure('pending-adoption-limit');
    const nativeSnapshot = this.source!.native ? await this.captureNativeBindings() : undefined;
    const pending = await collectNearbyPending(this.transport!, this.replica!, this.abort.signal, this.source!.scope);
    if (nativeSnapshot) {
      // Native writes in an earlier batch can change guards for related rows.
      // Refresh the optimistic write guards from the verified source revision,
      // without scanning received replica content as if it were already saved.
      const byLocal = new Map(nativeSnapshot.records.map(row => [row.local_id, row]));
      for (const record of pending) if (record.localId) {
        const current = byLocal.get(record.localId);
        if (!current) failure('invalid-binding');
        record.expectedGuard = current.guard;
      }
    }
    if (!pending.length) break;
    const lookup = new Map(pending.map(row => [row.id, row]));
    const canonicalIds = new Map<string, string>();
    const references: Array<{ id: string; localId: string }> = [];
    const applicationIds = new Set(pending.flatMap(nearbyApplicationReferences));
    const allIds = new Set([...applicationIds, ...(nativeSnapshot ? pending.flatMap(nearbyHierarchyReferences) : [])]);
    for (const ids of chunks([...allIds])) {
      const resolved = await this.call('replica_resolve', { handle: this.replica, ids, scope: this.source!.scope });
      if (!Array.isArray(resolved.items) || resolved.items.length !== ids.length) failure('invalid-reference');
      for (const raw of resolved.items) {
        const entry = wireObject(raw), id = validId(entry.id), global = validId(entry.global_id);
        if (!ids.includes(id) || canonicalIds.has(id)) failure('invalid-reference');
        canonicalIds.set(id, global);
        const staged = lookup.get(global);
        const localId = entry.local_id == null ? staged && (staged.localId ?? (this.source!.native ? undefined : `local:nearby-${global}`)) : string(entry.local_id, 256);
        if (localId) references.push({ id, localId });
      }
    }
    // The revision-bound native scan already contains current project groups;
    // reuse it instead of reading every native payload a second time.
    const nativeByLocal = nativeSnapshot && new Map(nativeSnapshot.records.map(row => [row.local_id, row.data]));
    const localGroups = !pending.some(row => row.deleted) ? undefined : nativeByLocal ? new Map(pending.flatMap(row => {
      const data = row.localId ? nativeByLocal.get(row.localId) : undefined;
      const group = data?.extensions === undefined ? undefined : wireObject(data.extensions).password_group_id;
      return typeof group === 'string' && group ? [[row.id, group] as [string, string]] : [];
    })) : new Map(await this.source!.groups(pending));
    const nativeGroups = nativeSnapshot ? scheduleNearbyNativeGroups(groupNearbyPending(pending, canonicalIds, localGroups, 128, false), nativeSnapshot, canonicalIds) : undefined;
    for (const batch of nativeGroups ? [nativeGroups.flat()] : groupNearbyPending(pending, canonicalIds, localGroups)) {
      const adopt = async (records: NearbyIncomingRecord[]) => {
      const saved = new Set((await this.source!.saved(records)).map(row => row.recordId));
      const assets = new Map<string, { id: string; dataBase64: string }>(); let bytesTotal = 0;
      for (const record of records) if (!saved.has(record.id)) {
        const data = wireObject(parseLosslessJson(record.dataJson));
        for (const raw of (data.assets as unknown[] | undefined) ?? []) {
          const asset = wireObject(raw), id = string(asset.id, 64).toLowerCase(), size = Number(wireInteger(asset.size, 16n * 1024n * 1024n));
          if (assets.has(id)) continue;
          bytesTotal += size; if (bytesTotal > 32 * 1024 * 1024 || assets.size >= 512) failure('asset-batch-limit');
          await this.guard(); const bytes = await this.readIncomingAsset({ id, size }, nativeSnapshot);
          try { assets.set(id, { id, dataBase64: bytesToBase64(bytes) }); } finally { bytes.fill(0); }
        }
      }
      await this.guard(true);
      const result = await this.source!.adopt({ providerId: this.preferences!.localProviderId, sourceHash: this.sourceHash!, records, references, assets: [...assets.values()] });
      for (const record of records) if (!saved.has(record.id) && !this.reported.has(record.id)) {
        this.reported.add(record.id); this.result.processed++; if (record.deleted) this.result.deleted++;
        if (this.result.items.length < 100) {
          const data = wireObject(parseLosslessJson(record.dataJson));
          this.result.items.push({ title: typeof data.title === 'string' ? data.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 128) : '',
            type: NEARBY_ENTRY_TYPES.includes(data.entry_type as NearbyEntryType) ? data.entry_type as NearbyEntryType : 'unknown', deleted: record.deleted });
        }
      }
      this.sourceHash = result.sourceHash; await this.guard(true); await this.applyAcknowledgements(result.acknowledgements);
      this.view.applied = (this.view.applied ?? 0) + records.length;
      };
      if (nativeGroups) await adoptNearbyNativeGroups(nativeGroups, adopt);
      else await adopt(batch);
    }
    } while (this.source!.native);
    if ((await this.call('replica_revision', { handle: this.replica })).pending !== false) failure('pending-adoption-required');
  }
  private async remember(remote: Record<string, unknown>): Promise<void> {
    await this.guard(!this.enrolling);
    const p = this.preferences!, id = validId(remote.device_id), pairing = wireObject(remote.pairing);
    const peer: NearbySavedPeer = { deviceId: id, name: string(remote.name, 128), pairId: this.peer?.pairId ?? validId(pairing.pair_id),
      trustedKey: this.peer?.trustedKey ?? string(pairing.trusted_key, 43),
      lastSyncedAt: this.enrolling ? 0 : Math.max(Date.now(), this.peer?.lastSyncedAt ?? 0),
      sentRevision: this.enrolling ? '' : this.revision, receivedRevision: this.enrolling ? '' : string(remote.revision),
      receivedRequest: this.enrolling ? '0' : nearbySettingsCounter(remote.sync_request) };
    // Remember where the peer was reachable; later discovery probes it directly.
    const address = this.remoteAddress ?? this.peer?.address;
    if (address && localAddress(address)) peer.address = address;
    const view = await this.store.updateNearbyPreferences({ kind: 'remember', peer, enrollment: this.enrolling }, p.epoch, this.sessionId!, this.transactionGuard());
    this.preferences = { ...p, epoch: view.epoch, peers: [...p.peers.filter(entry => entry.deviceId !== id), peer] };
    await this.guard();
    const interval = await this.store.updateNearbyPreferences({ kind: 'remote-interval', peerId: id, pairId: peer.pairId,
      seconds: Number(wireInteger(remote.interval_seconds, 86400n)), version: nearbySettingsCounter(remote.settings_version), writer: string(remote.settings_writer, 64)
    }, this.preferences.epoch, this.sessionId!, this.transactionGuard());
    this.preferences.epoch = interval.epoch;
    await this.guard(); this.view.peerId = id; this.view.peerName = peer.name;
  }
}
