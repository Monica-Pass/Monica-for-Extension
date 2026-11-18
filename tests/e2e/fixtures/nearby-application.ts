import { Mdbx2NativeClient, createChromeMdbx2NativeRuntime } from '../../../src/providers/mdbx2/native-client';
import { NearbyNativeTransport, appendNearbyAsset, readNearbyAsset, nearbySha256 } from '../../../src/nearby/native-transport';
import { SecureVaultService } from '../../../src/security/secure-vault-service';
import { IndexedDbVaultStorage } from '../../../src/security/vault-storage';
import { ChromeVaultSessionStore } from '../../../src/security/vault-session';
import { ChromeVaultDeviceKeyStore } from '../../../src/security/vault-device-key';
import { bytesToBase64, base64ToBytes } from '../../../src/security/encoding';
import { parseLosslessJson } from '../../../src/core/lossless-json';
import { createLoginItem, type PasskeyItem, type VaultItem } from '../../../src/core/model';
import { resolveBoundNote } from '../../../src/core/bound-notes';
import { resolveSsoAccount } from '../../../src/core/sso-links';
import { inspectNearbyPasskeyIssues } from '../../../src/nearby/passkey-consent';
import { nearbyDeviceHello, nearbyPreferencesView, nearbySettingsCounter } from '../../../src/nearby/preferences';
import { NearbyLocalCoordinator, type NearbyEndpoint } from '../../../src/nearby/local-coordinator';

const master = 'Synthetic nearby application password';
const storage = new IndexedDbVaultStorage();
const service = new SecureVaultService(storage, new ChromeVaultSessionStore(), Date.now, new ChromeVaultDeviceKeyStore());
const transport = new NearbyNativeTransport(new Mdbx2NativeClient(createChromeMdbx2NativeRuntime()));
const ready = async () => { if (await service.status() === 'locked') await service.unlock(master); };
const owned = new Map<string, { epoch: string; peerId?: string }>();
const preferences = async () => { await ready(); return service.nearbySessionPreferences((await service.passkeySessionId())!); };
const coordinator = new NearbyLocalCoordinator(service, () => new NearbyNativeTransport(new Mdbx2NativeClient(createChromeMdbx2NativeRuntime())), '127.0.0.1');

const app = {
  async setIncremental(incrementalOnly: boolean) {
    const p = await preferences();
    return service.updateNearbyPreferences({ kind: 'preferences', incrementalOnly }, p.epoch, (await service.passkeySessionId())!);
  },
  async standaloneOtp(action: 'create' | 'purge' | 'inspect') {
    await ready();
    if (action === 'create') await service.importItems([{ ...createLoginItem({ title: 'Standalone correct OTP' }), kind: 'totp', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' }]);
    const item = (await service.readState()).items.find(row => row.title === 'Standalone correct OTP');
    if (action === 'purge' && item?.kind === 'totp') {
      await service.upsertItem({ ...item, secret: 'GEZDGNBVGY3TQOJQ' });
      await service.deleteItem(item.id); await service.emptyLocalTrash();
    }
    if (action === 'inspect') return item?.kind === 'totp' ? { secret: item.secret, deleted: Boolean(item.deletedAt) } : null;
  },
  async coordinatorPair(link?: string) { await ready(); return coordinator.pair(link); },
  async coordinatorPrepare(id: string) { await ready(); return coordinator.prepare(id); },
  coordinatorConfirm: (id: string) => coordinator.confirm(id),
  coordinatorConfirmDeletions: (id: string, choice: 'omit' | 'include') => coordinator.confirmDeletions(id, choice),
  coordinatorStart: (endpoint?: NearbyEndpoint) => coordinator.start(endpoint),
  coordinatorClose: () => coordinator.close(),
  coordinatorStatus: () => coordinator.status(),
  async coordinatorPoll(loseReply = false) {
    const original = storage.records.commit.bind(storage.records);
    if (loseReply) storage.records.commit = async (...args) => { await original(...args); throw Error('synthetic application reply lost'); };
    try { return await coordinator.poll(); } finally { storage.records.commit = original; }
  },
  async itemIds() { await ready(); return (await service.readState()).items.map(item => ({ id: item.id, title: item.title })); },
  async seedAdditional(count: number) {
    if (!Number.isInteger(count) || count < 0 || count > 500) throw Error('synthetic count limit');
    await ready(); await service.importItems(Array.from({ length: count }, (_, i) => createLoginItem({ title: `Synthetic page item ${i}`, password: `synthetic-${i}` })));
  },
  async editAdditional() {
    await ready(); const items = (await service.readState()).items.filter(item => item.title.startsWith('Synthetic page item '));
    await service.importItems(items.map(item => ({ ...item, notes: 'reciprocal multi-page edit' })));
  },
  async additionalEditCount() {
    await ready(); return (await service.readState()).items.filter(item => item.title.startsWith('Synthetic page item ') && item.notes === 'reciprocal multi-page edit').length;
  },
  call: (operation: Parameters<NearbyNativeTransport['call']>[0], params: Record<string, unknown> = {}) => transport.call(operation, params),
  async preferences() {
    const p = await preferences();
    return { view: nearbyPreferencesView(p), deviceId: p.deviceId,
      keyHash: await nearbySha256(new TextEncoder().encode(p.replicaKey)), storageHash: await nearbySha256(new TextEncoder().encode(p.replicaStorageId)) };
  },
  async openOwnedReplica() {
    const p = await preferences();
    return transport.call('replica_open', { storage_id: p.replicaStorageId, device_id: p.deviceId, key: p.replicaKey });
  },
  async beginOwned(snapshot: string, invitation?: string, peerId?: string) {
    const p = await preferences(), peer = p.peers.find(peer => peer.deviceId === peerId);
    if (peerId && !peer) throw Error('peer forgotten');
    const params: Record<string, unknown> = { snapshot, device: nearbyDeviceHello(p, peerId) };
    if (peerId) params.expected_device_id = peerId;
    if (invitation) params.invitation = invitation;
    else { params.listen_address = '127.0.0.1'; if (peer) params.trusted_key = peer.trustedKey; }
    const result = await transport.call(invitation ? 'connect' : 'start', params) as { handle: string };
    owned.set(result.handle, { epoch: p.epoch, peerId });
    return result;
  },
  async rememberOwned(handle: string, loseReply = false) {
    const binding = owned.get(handle); if (!binding) throw Error('unknown synthetic session');
    const status = await transport.call('progress', { handle }) as any;
    if (status.phase !== 'received') throw Error('not authenticated');
    const remote = status.peer, p = await preferences(), old = p.peers.find(peer => peer.deviceId === remote.device_id);
    if (binding.peerId && binding.peerId !== remote.device_id || remote.content_type !== 'vault' || remote.vault_content_version !== 2) throw Error('unexpected peer');
    const original = storage.records.commit.bind(storage.records);
    if (loseReply) storage.records.commit = async (...args) => { await original(...args); throw Error('synthetic trust response lost'); };
    try {
      return await service.updateNearbyPreferences({ kind: 'remember', enrollment: !binding.peerId, peer: {
        deviceId: remote.device_id, name: remote.name, pairId: old?.pairId ?? remote.pairing.pair_id,
        trustedKey: old?.trustedKey ?? remote.pairing.trusted_key, lastSyncedAt: Date.now(),
        sentRevision: '', receivedRevision: remote.revision, receivedRequest: nearbySettingsCounter(remote.sync_request)
      } }, binding.epoch, (await service.passkeySessionId())!);
    } finally { storage.records.commit = original; }
  },
  async forgetOwned(peerId: string) {
    const p = await preferences(); return service.updateNearbyPreferences({ kind: 'forget', deviceId: peerId }, p.epoch, (await service.passkeySessionId())!);
  },
  async seed(sender: boolean) {
    if (!sender) { await service.setup(master); return; }
    const one = createLoginItem({ title: 'Nearby project one', username: 'alice', password: 'synthetic-first-password' });
    const two = createLoginItem({ title: 'Nearby project two', username: 'bob', password: 'synthetic-second-password' });
    const group = crypto.randomUUID(); one.passwordGroupId = group; two.passwordGroupId = group;
    one.appPackageName = 'synthetic.application'; one.addressLine = 'Synthetic street'; one.email = 'alice@example.test';
    one.customFields = [{ name: 'duplicate', value: 'one', protected: true }, { name: 'duplicate', value: 'two', protected: false }];
    one.passwordHistory = [{ password: 'old synthetic password', lastUsedAt: new Date().toISOString() }];
    const note: VaultItem = { ...createLoginItem({ title: 'Bound note' }), kind: 'secure-note', content: 'Synthetic secret note' };
    const sso = createLoginItem({ title: 'SSO identity', password: 'synthetic-sso' });
    const otp: VaultItem = { ...createLoginItem({ title: 'Bound OTP' }), kind: 'totp', secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' };
    one.boundNoteEntryId = `note:${note.id}`; one.ssoRefLogicalId = `password:${sso.id}`; one.boundTotpItemId = otp.id;
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const key: PasskeyItem = { ...createLoginItem({ title: 'Original passkey' }), kind: 'passkey', credentialId: bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'),
      userHandle: 'dXNlcg', rpId: 'nearby.example.test', rpName: 'Nearby', userName: 'alice', userDisplayName: 'Alice', algorithm: -7, signCount: 0,
      sourceMode: 'browser-local', discoverable: true, privateKeyPkcs8: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
      publicKey: bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))) };
    const positive = { ...key, id: crypto.randomUUID(), credentialId: 'BQYHCA', signCount: 19, title: 'Positive history' };
    await service.setup(master, [one, two, note, sso, otp, key, positive]);
    const state = await service.readState(), bytes = new Uint8Array(600000).fill(131), sha256 = await nearbySha256(bytes);
    const attachmentId = crypto.randomUUID();
    await service.mutateLocalAttachment({ operationId: crypto.randomUUID(), providerId: state.providers[0].id, itemId: one.id,
      attachmentId, mode: 'create', attachment: { itemId: one.id, attachmentId, fileName: 'synthetic-file.bin',
        sizeBytes: bytes.length, sha256, dataBase64: bytesToBase64(bytes) } }, (await service.passkeySessionId())!);
    return { credentialId: key.credentialId, publicKey: key.publicKey, privateKeyHash: await nearbySha256(base64ToBytes(key.privateKeyPkcs8!)), sha256, group };
  },
  async snapshot(replica: string) {
    await ready(); const snapshot = await service.captureNearbyLocalRecords();
    const issues = await inspectNearbyPasskeyIssues(snapshot.records.map(row => ({ localId: row.local_id, deleted: row.deleted, data: row.data })));
    await transport.call('replica_scan_begin', { handle: replica, scopes: ['local'] });
    await transport.call('replica_scan_batch', { handle: replica, entries: snapshot.records });
    await transport.call('replica_scan_end', { handle: replica });
    const exported = await transport.call('replica_export', { handle: replica }) as { handle: string };
    for (const asset of snapshot.assets) {
      const bytes = base64ToBytes(asset.dataBase64);
      try { await appendNearbyAsset(transport, exported.handle, { id: asset.id, size: bytes.length }, bytes); } finally { bytes.fill(0); }
    }
    return { handle: exported.handle, recordCount: snapshot.records.length, issues };
  },
  async adopt(replica: string, session?: string, loseReply = false) {
    await ready();
    // The Host deliberately keeps cursor order stable. The application stages
    // all records in this batch before resolving their dependencies.
    const pending = await transport.call('replica_pending', { handle: replica }) as { items: any[] };
    const state = await service.readState(), assets = new Map<string, { id: string; dataBase64: string }>();
    if (session) for (const item of pending.items) for (const asset of item.record.data.assets ?? []) {
      if (assets.has(asset.id)) continue;
      const bytes = await readNearbyAsset(transport, session, { id: asset.id, size: asset.size });
      try { assets.set(asset.id, { id: asset.id, dataBase64: bytesToBase64(bytes) }); } finally { bytes.fill(0); }
    }
    const input = { providerId: state.providers[0].id, sourceHash: await service.nearbyLocalSnapshotHash(), assets: [...assets.values()],
      records: pending.items.map(item => ({ id: item.record.id, deleted: item.record.deleted, clockJson: JSON.stringify(item.record.clock), dataJson: JSON.stringify(item.record.data) })) };
    const original = storage.records.commit.bind(storage.records);
    if (loseReply) storage.records.commit = async (...args) => { await original(...args); throw new Error('synthetic stored response lost'); };
    try {
      const receipts = await service.adoptNearbyLocalRecords(input, (await service.passkeySessionId())!);
      await transport.call('replica_applied_batch', { handle: replica, items: receipts.map(row => ({ record_id: row.recordId, clock: parseLosslessJson(row.clockJson),
        local_id: row.localId, scope: row.scope, guard: row.guard, data: parseLosslessJson(row.dataJson) })) });
      return receipts.length;
    } finally { storage.records.commit = original; }
  },
  async inspect() {
    await ready(); const state = await service.readState(), one = state.items.find(item => item.title === 'Nearby project one');
    if (!one || one.kind !== 'login') throw new Error('Missing project');
    const key = state.items.find((item): item is PasskeyItem => item.kind === 'passkey' && item.signCount === 0)!;
    const secret = Uint8Array.from(base64ToBytes(key.privateKeyPkcs8!)), original = Uint8Array.from(base64ToBytes(key.publicKey)), challenge = crypto.getRandomValues(new Uint8Array(32));
    let signature: ArrayBuffer;
    try {
      const signing = await crypto.subtle.importKey('pkcs8', secret, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signing, challenge);
      const publicKey = await crypto.subtle.importKey('spki', original, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, challenge)) throw Error('Signature mismatch');
      const bytes = base64ToBytes(state.localItemAttachments![0].dataBase64);
      try { return { count: state.items.length, one, note: resolveBoundNote(one, state.items)?.title, sso: resolveSsoAccount(one, state.items)?.title,
        otp: state.items.find(item => item.id === one.boundTotpItemId)?.title, credentialId: key.credentialId, publicKey: key.publicKey,
        privateKeyHash: await nearbySha256(secret), countHistory: state.items.filter(item => item.kind === 'passkey').map(item => item.signCount),
        attachmentHash: await nearbySha256(bytes), attachmentBytes: bytes.length, signatureVerified: true, encrypted: await storage.read() }; }
      finally { bytes.fill(0); }
    } finally { secret.fill(0); original.fill(0); challenge.fill(0); }
  },
  async edit() { await ready(); const state = await service.readState(); const item = state.items.find(item => item.title === 'Nearby project one')!; await service.upsertItem({ ...item, notes: 'after-restart edit' }); },
  async captured() { await ready(); return JSON.stringify(await service.captureNearbyLocalRecords()); }
};
(window as unknown as { nearbyApp: typeof app }).nearbyApp = app;
