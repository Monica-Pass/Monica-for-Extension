import type { ProviderSourceRecord, VaultItem, VaultState } from '../core/model';
import { parseLosslessJson } from '../core/lossless-json';
import { isLocalTransferItem, validateLocalAttachments, type LocalItemAttachment } from '../core/local-transfer';
import { pendingRemovalTouches, readPasswordProjectRemovalJournal } from '../core/password-project-removal-journal';
import { mdbx2TransferOperationScope as hash } from '../providers/mdbx2/mdbx2-transfer-identity';
import { normalizeCredentialId } from '../passkey/source-policy';
import { nearbyLocalItemToWire, nearbyWireToLocalItem } from './application-codec';
import { mergeNearbyOrigins, nearbyLocalOriginIndex, readNearbyOrigins, withNearbyOrigins } from './local-origins';
import { captureNearbyMetadata, isNearbyMetadata, isNearbyTombstone, nearbyCategoryKey, nextNearbyCategoryId, readNearbyLocalMetadata, stageNearbyMetadata } from './local-metadata';
import { invalidNearby, validateNearbyWireData, wireInteger, wireObject, wireText, type NearbyWireData } from './wire-shape';

export interface NearbyIncomingRecord {
  id: string; clockJson: string; dataJson: string; deleted: boolean;
  /** Authenticated native replica binding. Never infer an existing item from a title. */
  localId?: string; scope?: string; expectedGuard?: string;
}
export interface NearbyLocalAcknowledgement {
  recordId: string; clockJson: string; localId: string; scope: 'local'; guard: string; dataJson: string;
}
export interface NearbyLocalReceipt {
  version: 1; providerId: string; recordId: string; itemId: string; fingerprint: string;
  dataJson: string; baseline: VaultItem; acknowledgement: NearbyLocalAcknowledgement;
  /** Portable restore keeps content identity but starts a different native replica history. */
  replayInvalidated?: boolean;
}
export const NEARBY_RETAINED_LOCAL_LIMIT = 20_000;
const retainedLocalId = /^local:[A-Za-z0-9_-]{1,64}$/;
/** Local ids whose native record is kept live even though the item is gone locally. */
export function readNearbyRetainedLocals(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > NEARBY_RETAINED_LOCAL_LIMIT) invalidNearby('retained-list');
  const ids = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || !retainedLocalId.test(raw) || ids.has(raw)) invalidNearby('retained-invalid');
    ids.add(raw);
  }
  return [...ids];
}
export interface NearbyLocalBatch {
  providerId: string;
  sourceHash: string;
  records: NearbyIncomingRecord[];
  references?: Array<{ id: string; localId: string }>;
  /** Already authenticated by the transport; verified again before storage. */
  assets: Array<{ id: string; dataBase64: string }>;
}

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const digestPattern = /^[a-f0-9]{64}$/;
function clock(value: string): Map<string, bigint> {
  if (typeof value !== 'string' || value.length > 64 * 1024) invalidNearby('clock-size');
  const object = wireObject(parseLosslessJson(value)), result = new Map<string, bigint>();
  if (!Object.keys(object).length || Object.keys(object).length > 1024) invalidNearby('clock-count');
  for (const [key, value] of Object.entries(object)) {
    if (!idPattern.test(key)) invalidNearby('clock-device');
    result.set(key, wireInteger(value, (1n << 64n) - 1n));
  }
  return result;
}

export function readNearbyLocalReceipts(value: unknown): NearbyLocalReceipt[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20_000) invalidNearby('receipt-list');
  const ids = new Set<string>();
  for (const raw of value) {
    const row = wireObject(raw), ack = wireObject(row.acknowledgement), baseline = wireObject(row.baseline);
    if (row.version !== 1 || typeof row.providerId !== 'string' || !row.providerId || typeof row.recordId !== 'string' || !idPattern.test(row.recordId)
      || typeof row.itemId !== 'string' || baseline.id !== row.itemId || typeof row.fingerprint !== 'string' || !digestPattern.test(row.fingerprint)
      || ack.recordId !== row.recordId || ack.localId !== `local:${row.itemId}` || ack.scope !== 'local' || typeof ack.guard !== 'string' || !digestPattern.test(ack.guard)
      || typeof row.dataJson !== 'string' || row.dataJson.length > 1024 * 1024 || typeof ack.dataJson !== 'string' || ack.dataJson.length > 1024 * 1024) invalidNearby('receipt-invalid');
    if (row.replayInvalidated !== undefined && typeof row.replayInvalidated !== 'boolean') invalidNearby('receipt-invalid');
    if (ids.has(row.recordId)) invalidNearby('receipt-duplicate'); ids.add(row.recordId);
    clock(wireText(ack.clockJson));
    for (const json of [row.dataJson, ack.dataJson]) {
      const data = parseLosslessJson(json); validateNearbyWireData(data); readNearbyOrigins(data);
    }
  }
  return structuredClone(value) as NearbyLocalReceipt[];
}

function originIndexForState(state: VaultState, receipts: NearbyLocalReceipt[]): Map<string, ProviderSourceRecord[]> {
  const index = nearbyLocalOriginIndex(state);
  // Older builds retained unknown labels only in the encrypted receipt. Include
  // those archives in both guards and adoption, even if a later peer omits them.
  for (const receipt of receipts) {
    const origins = readNearbyOrigins(parseLosslessJson(receipt.dataJson) as NearbyWireData);
    if (origins.length) index.set(receipt.itemId, mergeNearbyOrigins(index.get(receipt.itemId) ?? [], origins));
  }
  return index;
}

/** A portable restore never replays acknowledgements from another replica.
 * Baselines and portable IDs still carry every original field and key. */
export function invalidateNearbyReplayForRestore(state: VaultState): void {
  if (state.nearbyLocalReceipts) state.nearbyLocalReceipts = readNearbyLocalReceipts(state.nearbyLocalReceipts).map(row => ({ ...row, replayInvalidated: true }));
  if (state.nearbyLocalMetadata) state.nearbyLocalMetadata = readNearbyLocalMetadata(state.nearbyLocalMetadata).map(row => ({ ...row, replayInvalidated: true }));
}

/** Bind incoming adoption to the exact local snapshot, including attachments,
 * origin archives and pending cross-provider work. No secrets leave the caller. */
export async function nearbyLocalSourceHash(state: VaultState): Promise<string> {
  return hash({ items: state.items.filter(item => isLocalTransferItem(item, state.providers)),
    providers: state.providers.filter(provider => provider.kind === 'local'), nearbyEpoch: state.nearbyPreferences?.epoch ?? null, attachments: state.localItemAttachments ?? [],
    origins: state.localItemOrigins ?? [], folders: state.localTransferFolders ?? [], receipts: readNearbyLocalReceipts(state.nearbyLocalReceipts), metadata: readNearbyLocalMetadata(state.nearbyLocalMetadata),
    retained: readNearbyRetainedLocals(state.nearbyRetainedLocals),
    removals: readPasswordProjectRemovalJournal(state.passwordProjectRemovals), transfers: state.bitwardenBatchTransfers ?? [], queue: state.mutationQueue, conflicts: state.providerConflicts });
}

async function itemGuard(item: VaultItem, attachments: LocalItemAttachment[], origins: ProviderSourceRecord[]): Promise<string> {
  return hash({ item, attachments, ...(origins.length ? { origins } : {}) });
}

function bareLocalReferences(item: VaultItem, providerId: string): boolean {
  return item.mdbxDatabaseId == null && item.keepassDatabaseId == null
    && item.providerRefs.every(ref => Object.keys(ref).length === 1 && ref.providerId === providerId);
}

async function matchesItemGuard(item: VaultItem, attachments: LocalItemAttachment[], expected: string, providerId: string, origins: ProviderSourceRecord[]): Promise<boolean> {
  if (await itemGuard(item, attachments, origins) === expected) return true;
  // Earlier batches can normalize implicit local scope without changing content.
  // Accept exactly those two historical spellings; all other item fields and
  // attachment bytes must still match the authenticated native guard. The full
  // source hash independently rejects concurrent edits between transactions.
  if (item.providerRefs.length !== 1 || !bareLocalReferences(item, providerId)) return false;
  for (const providerRefs of [[], [{ providerId: 'local' }]]) {
    if (await itemGuard({ ...item, providerRefs }, attachments, origins) === expected) return true;
  }
  return false;
}

const recordFingerprint = (record: NearbyIncomingRecord) => hash({ id: record.id, clockJson: record.clockJson, dataJson: record.dataJson, deleted: record.deleted });
export async function nearbySavedAcknowledgements(state: VaultState, records: readonly NearbyIncomingRecord[]): Promise<NearbyLocalAcknowledgement[]> {
  const receipts = new Map(readNearbyLocalReceipts(state.nearbyLocalReceipts).map(row => [row.recordId, row]));
  const metadata = new Map(readNearbyLocalMetadata(state.nearbyLocalMetadata).map(row => [row.recordId, row]));
  const result: NearbyLocalAcknowledgement[] = [];
  for (const record of records) {
    if (receipts.has(record.id) && metadata.has(record.id)) invalidNearby('duplicate-record-target');
    const receipt = receipts.get(record.id) ?? metadata.get(record.id);
    if (receipt?.acknowledgement && !receipt.replayInvalidated && receipt.fingerprint === await recordFingerprint(record)) result.push(structuredClone(receipt.acknowledgement));
  }
  return result;
}

export interface NearbyLocalSnapshot {
  sourceHash: string;
  records: Array<{ local_id: string; global_id: string; scope: 'local'; guard: string; deleted: boolean; data: NearbyWireData }>;
  assets: Array<{ id: string; dataBase64: string }>;
  /** Bindings kept live for permanently deleted items while incremental-only sync is on. */
  retained: string[];
}

function uuidFromDigest(digest: string): string { return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`; }

/** Capture all local items from one authenticated state. Provider-backed entries
 * retain their separate sync policy; a failed row rejects the entire scan. */
export async function captureNearbyLocalSnapshot(state: VaultState): Promise<NearbyLocalSnapshot> {
  const receipts = readNearbyLocalReceipts(state.nearbyLocalReceipts), locals = state.items.filter(item => isLocalTransferItem(item, state.providers));
  const metadata = await captureNearbyMetadata(state), originIndex = originIndexForState(state, receipts);
  const liveLocalIds = new Set(locals.map(item => `local:${item.id}`));
  const retained = readNearbyRetainedLocals(state.nearbyRetainedLocals).filter(id => !liveLocalIds.has(id));
  const identities = new Map<string, string>(), references = new Map<string, string>();
  for (const item of locals) {
    requireUncontended(state, item.id);
    const receipt = receipts.find(row => row.itemId === item.id);
    const id = receipt?.recordId ?? uuidFromDigest(await hash(['nearby-local', item.id]));
    identities.set(item.id, id);
    references.set(item.id, id); references.set(`password:${item.id}`, id); references.set(`note:${item.id}`, id);
    if (item.replicaGroupId) {
      if (references.has(item.replicaGroupId) && references.get(item.replicaGroupId) !== id) invalidNearby('ambiguous-local-reference');
      references.set(item.replicaGroupId, id);
    }
  }
  const records: NearbyLocalSnapshot['records'] = [], assets = new Map<string, string>();
  for (const item of locals) {
    const receipt = receipts.find(row => row.itemId === item.id), previous = receipt ? wireObject(parseLosslessJson(receipt.dataJson)) as NearbyWireData : undefined;
    const origins = originIndex.get(item.id) ?? [];
    const files = (state.localItemAttachments ?? []).filter(file => file.itemId === item.id);
    await validateLocalAttachments(files, item.id);
    const descriptors: Record<string, unknown>[] = files.map(file => {
      const originals = (previous?.assets as Record<string, unknown>[] | undefined) ?? [];
      const old = originals.find((asset, index) => file.attachmentId === `nearby-${asset.id}-${index}`);
      if (assets.has(file.sha256) && assets.get(file.sha256) !== file.dataBase64) invalidNearby('conflicting-asset-content');
      assets.set(file.sha256, file.dataBase64);
      return { ...old, id: file.sha256, size: file.sizeBytes, file_name: file.fileName, media_type: file.mediaType ?? 'application/octet-stream' };
    });
    let folderPath = previous?.folder_path as unknown[] | undefined;
    if (!receipt || receipt.baseline.categoryId !== item.categoryId || receipt.baseline.categoryName !== item.categoryName) {
      folderPath = item.categoryName ? [{ id: uuidFromDigest(await hash(['nearby-local-folder', item.categoryId ?? item.categoryName])), title: item.categoryName, parent: null }] : [];
    }
    const category = metadata.find(row => !row.value.deleted && row.value.categoryKey === nearbyCategoryKey(item) && row.value.categoryKey !== undefined);
    if (category) folderPath = wireObject(category.data.payload).path as unknown[];
    const data = withNearbyOrigins(await nearbyLocalItemToWire(item, { folder: item.categoryName ?? '', folder_path: folderPath ?? [], assets: descriptors,
      labels: previous?.labels as unknown[] | undefined, relations: previous?.relations as unknown[] | undefined },
    previous && receipt ? { data: previous, item: receipt.baseline } : undefined), origins);
    if (item.kind === 'login') {
      const ext = wireObject(data.extensions);
      for (const [value, field] of [[item.boundNoteEntryId, 'bound_note_entry_id'], [item.ssoRefLogicalId, 'sso_ref_entry_id']] as const) {
        if (!value) continue;
        const target = references.get(value); if (!target) invalidNearby('local-reference-missing'); ext[field] = target;
      }
      if (item.ssoRefLogicalId) delete ext.sso_ref_logical_id;
    }
    if (item.kind === 'totp') {
      const owners = locals.filter(row => row.kind === 'login' && row.boundTotpItemId === item.id);
      if (owners.length > 1) invalidNearby('ambiguous-otp-owner');
      if (owners.length) wireObject(data.payload).bound_password_entry_id = identities.get(owners[0].id);
    }
    validateNearbyWireData(data);
    records.push({ local_id: `local:${item.id}`, global_id: identities.get(item.id)!, scope: 'local', guard: await itemGuard(item, files, origins), deleted: Boolean(item.deletedAt), data });
  }
  for (const row of metadata) {
    if (records.some(record => record.global_id === row.value.recordId || record.local_id === row.value.localId)) invalidNearby('metadata-identity');
    for (const file of row.value.attachments) {
      if (assets.has(file.sha256) && assets.get(file.sha256) !== file.dataBase64) invalidNearby('conflicting-asset-content');
      assets.set(file.sha256, file.dataBase64);
    }
    records.push({ local_id: row.value.localId, global_id: row.value.recordId, scope: 'local', guard: row.guard, deleted: row.value.deleted, data: row.data });
  }
  // A permanently deleted item can still own the asset bytes referenced by its
  // live replica record; export fails unless those exact bytes stay available.
  for (const id of retained) {
    const files = (state.localItemAttachments ?? []).filter(file => file.itemId === id.slice('local:'.length));
    if (!files.length) continue;
    await validateLocalAttachments(files, id.slice('local:'.length));
    for (const file of files) {
      if (assets.has(file.sha256) && assets.get(file.sha256) !== file.dataBase64) invalidNearby('conflicting-asset-content');
      assets.set(file.sha256, file.dataBase64);
    }
  }
  return { sourceHash: await nearbyLocalSourceHash(state), records, assets: [...assets].map(([id, dataBase64]) => ({ id, dataBase64 })), retained };
}

function requireUncontended(state: VaultState, id: string): void {
  if (state.mutationQueue.some(row => row.itemId === id) || state.providerConflicts.some(row => row.itemId === id)
    || pendingRemovalTouches(readPasswordProjectRemovalJournal(state.passwordProjectRemovals), new Set([id]))
    || state.bitwardenBatchTransfers?.some(row => row.status === 'writing' && row.request.action === 'move' && row.request.itemIds.includes(id))) invalidNearby('local-operation-pending');
}

/** Returns an entirely new state. The service persists it once and only then
 * returns acknowledgements. A failed write cannot partially adopt a project. */
export async function applyNearbyLocalBatch(state: VaultState, input: NearbyLocalBatch, now: string): Promise<{ state: VaultState; acknowledgements: NearbyLocalAcknowledgement[]; changed: boolean }> {
  if (!Number.isFinite(Date.parse(now)) || !digestPattern.test(input.sourceHash) || !Array.isArray(input.records) || !input.records.length || input.records.length > 200
    || !Array.isArray(input.assets) || input.assets.length > 512) invalidNearby('adoption-batch');
  const provider = state.providers.find(row => row.id === input.providerId);
  if (!provider?.enabled || provider.kind !== 'local') invalidNearby('local-provider-required');
  const resolvedReferences = new Map<string, string>();
  if (input.references !== undefined && (!Array.isArray(input.references) || input.references.length > 20_000)) invalidNearby('adoption-reference-limit');
  for (const reference of input.references ?? []) {
    if (!idPattern.test(reference.id) || typeof reference.localId !== 'string' || !reference.localId.startsWith('local:')
      || resolvedReferences.has(reference.id)) invalidNearby('adoption-reference-binding');
    resolvedReferences.set(reference.id, reference.localId.slice('local:'.length));
  }
  const receipts = readNearbyLocalReceipts(state.nearbyLocalReceipts), byId = new Map(receipts.map(row => [row.recordId, row]));
  const metadata = readNearbyLocalMetadata(state.nearbyLocalMetadata), metadataById = new Map(metadata.map(row => [row.recordId, row]));
  const originalMetadata = await captureNearbyMetadata(state);
  const retainedLocals = new Set(readNearbyRetainedLocals(state.nearbyRetainedLocals));
  const ids = new Set<string>(), assets = new Map<string, string>();
  for (const asset of input.assets) {
    if (!digestPattern.test(asset.id) || assets.has(asset.id) || typeof asset.dataBase64 !== 'string' || asset.dataBase64.length > 24 * 1024 * 1024) invalidNearby('adoption-assets');
    assets.set(asset.id, asset.dataBase64);
  }
  const work = await Promise.all(input.records.map(async record => {
    if (!idPattern.test(record.id) || ids.has(record.id) || typeof record.deleted !== 'boolean' || typeof record.dataJson !== 'string' || record.dataJson.length > 1024 * 1024) invalidNearby('adoption-record');
    ids.add(record.id);
    const vector = clock(record.clockJson), fingerprint = await recordFingerprint(record);
    // A permanently deleted local item keeps its native record alive. Its old
    // binding must not block adoption until the peer sends live content again.
    const retired = record.localId !== undefined && retainedLocals.has(record.localId);
    if (retired && record.deleted) return { record, data: {} as NearbyWireData, fingerprint, old: byId.get(record.id),
      previous: byId.get(record.id) ?? metadataById.get(record.id), restoringTombstone: false, replay: false, retired, retiredDeletion: true };
    let data = wireObject(parseLosslessJson(record.dataJson)) as NearbyWireData;
    if (record.deleted && isNearbyTombstone(data)) {
      const known = byId.get(record.id)?.dataJson ?? metadataById.get(record.id)?.dataJson
        ?? originalMetadata.find(row => row.value.localId === record.localId)?.value.dataJson;
      if (known) data = parseLosslessJson(known) as NearbyWireData;
      else if (record.localId && !record.localId.startsWith('local:metadata-')) {
        const source = await captureNearbyLocalSnapshot(state);
        data = source.records.find(row => row.local_id === record.localId)?.data ?? invalidNearby('tombstone-binding-required');
      }
    }
    if (!(record.deleted && isNearbyTombstone(data))) validateNearbyWireData(data);
    const bound = record.localId !== undefined || record.scope !== undefined || record.expectedGuard !== undefined;
    if (bound && (typeof record.localId !== 'string' || !record.localId.startsWith('local:') || record.scope !== 'local'
      || typeof record.expectedGuard !== 'string' || !digestPattern.test(record.expectedGuard))) invalidNearby('adoption-binding');
    const old = byId.get(record.id);
    const oldMetadata = metadataById.get(record.id), previous = old ?? oldMetadata;
    const restoringTombstone = oldMetadata && isNearbyTombstone(wireObject(parseLosslessJson(oldMetadata.dataJson))) && !isNearbyMetadata(data);
    if (old && oldMetadata || old && isNearbyMetadata(data) || oldMetadata && !isNearbyMetadata(data) && !restoringTombstone) invalidNearby('metadata-type-changed');
    if (restoringTombstone && record.localId && !originalMetadata.some(row => row.value.localId === record.localId && row.value.recordId === record.id && row.guard === record.expectedGuard)) invalidNearby('metadata-binding-changed');
    if (previous && previous.providerId !== provider.id) invalidNearby('adoption-provider-changed');
    if (previous?.fingerprint !== fingerprint && previous?.acknowledgement && !previous.replayInvalidated) {
      const before = clock(previous.acknowledgement.clockJson);
      let newer = false;
      for (const [device, count] of before) if ((vector.get(device) ?? 0n) < count) invalidNearby('adoption-clock-regression');
      for (const [device, count] of vector) if (count > (before.get(device) ?? 0n)) newer = true;
      if (!newer) invalidNearby('adoption-clock-conflict');
    }
    return { record, data, fingerprint, old, previous, restoringTombstone, replay: previous?.fingerprint === fingerprint && !previous.replayInvalidated, retired, retiredDeletion: false };
  }));
  if (work.every(row => row.replay || row.retiredDeletion)) return { state, changed: false, acknowledgements: work.map(row => row.retiredDeletion
    ? { recordId: row.record.id, clockJson: row.record.clockJson, localId: row.record.localId!, scope: 'local', guard: '0'.repeat(64), dataJson: row.record.dataJson }
    : structuredClone(row.previous!.acknowledgement!)) };
  if (await nearbyLocalSourceHash(state) !== input.sourceHash) invalidNearby('local-source-changed');
  const originIndex = originIndexForState(state, receipts);
  const next = structuredClone(state), acknowledgements: NearbyLocalAcknowledgement[] = [], changedItems = new Set<string>();
  const metadataChanges: Array<Awaited<ReturnType<typeof stageNearbyMetadata>>> = [];
  // Prepare folder membership before projecting items. Do not mutate existing
  // item guards until every incoming item has passed its original binding check.
  for (const row of work.filter(row => !row.replay && !row.retiredDeletion && isNearbyMetadata(row.data))) {
    const files: LocalItemAttachment[] = [];
    const localId = originalMetadata.find(entry => entry.value.recordId === row.record.id || entry.value.localId === row.record.localId)?.value.localId ?? `local:metadata-${row.record.id}`;
    const retained = row.record.deleted && (row.data.assets === undefined || isNearbyTombstone(wireObject(parseLosslessJson(row.record.dataJson))))
      ? originalMetadata.find(entry => entry.value.recordId === row.record.id || entry.value.localId === row.record.localId)?.value.attachments : undefined;
    if (retained) files.push(...structuredClone(retained));
    for (const [index, raw] of (retained ? [] : (row.data.assets as unknown[] | undefined) ?? []).entries()) {
      const asset = wireObject(raw), id = wireText(asset.id).toLowerCase(), body = assets.get(id);
      if (body === undefined) invalidNearby('adoption-asset-missing');
      files.push({ itemId: localId, attachmentId: `nearby-${id}-${index}`, fileName: wireText(asset.file_name), mediaType: wireText(asset.media_type),
        sizeBytes: Number(wireInteger(asset.size, 16n * 1024n * 1024n)), sha256: id, dataBase64: body, protected: true });
    }
    await validateLocalAttachments(files, localId);
    const metadata = await stageNearbyMetadata(next, originalMetadata, provider.id, row.record, row.data, row.fingerprint, files);
    metadataChanges.push(metadata); acknowledgements.push(metadata.acknowledgement!);
  }
  for (const row of work) {
    if (row.replay) { acknowledgements.push(structuredClone(row.previous!.acknowledgement!)); continue; }
    if (row.retiredDeletion) {
      acknowledgements.push({ recordId: row.record.id, clockJson: row.record.clockJson, localId: row.record.localId!, scope: 'local',
        guard: '0'.repeat(64), dataJson: row.record.dataJson });
      continue;
    }
    if (isNearbyMetadata(row.data)) continue;
    const { record, old } = row;
    const retired = row.retired;
    let data = row.data;
    if (row.restoringTombstone) next.nearbyLocalMetadata = readNearbyLocalMetadata(next.nearbyLocalMetadata).filter(entry => entry.recordId !== record.id);
    let existing = old ? next.items.find(item => item.id === old.itemId) : undefined;
    if (old && !existing && !retired) invalidNearby('local-item-missing');
    if (record.localId && !row.restoringTombstone && !retired) {
      const boundId = record.localId.slice('local:'.length);
      const bound = next.items.find(item => item.id === boundId);
      if (!bound || old && old.itemId !== boundId || !isLocalTransferItem(bound, next.providers)) invalidNearby('local-binding-changed');
      if (!await matchesItemGuard(bound, (next.localItemAttachments ?? []).filter(file => file.itemId === boundId), record.expectedGuard!, provider.id, (originIndex.get(boundId) ?? []))) invalidNearby('local-binding-changed');
      existing = bound;
    }
    if (!existing && data.entry_type === 'passkey') {
      const payload = wireObject(data.payload);
      const matches = next.items.filter((item): item is Extract<VaultItem, { kind: 'passkey' }> => item.kind === 'passkey' && isLocalTransferItem(item, next.providers)
        && item.rpId.toLowerCase() === wireText(payload.rp_id).toLowerCase() && normalizeCredentialId(item.credentialId) === normalizeCredentialId(wireText(payload.credential_id)));
      if (matches.length > 1) invalidNearby('duplicate-local-passkey'); existing = matches[0];
    }
    if (existing && !isLocalTransferItem(existing, next.providers)) invalidNearby('local-item-source-changed');
    const itemId = existing?.id ?? `nearby-${record.id}`;
    if (retired) {
      // The peer revived a record whose local item was purged. The old binding
      // is retired: drop its shadow bookkeeping and orphaned attachment bytes.
      const oldItemId = record.localId!.slice('local:'.length);
      next.nearbyRetainedLocals = readNearbyRetainedLocals(next.nearbyRetainedLocals).filter(id => id !== record.localId);
      next.localItemAttachments = (next.localItemAttachments ?? []).filter(file => file.itemId !== oldItemId);
    }
    if (changedItems.has(itemId) || [...byId.values()].some(receipt => receipt.itemId === itemId && receipt.recordId !== record.id)) invalidNearby('duplicate-record-target');
    changedItems.add(itemId);
    if (!existing && next.items.some(item => item.id === itemId)) invalidNearby('local-item-collision');
    requireUncontended(next, itemId);
    const origins = mergeNearbyOrigins((originIndex.get(itemId) ?? []), readNearbyOrigins(data));
    data = withNearbyOrigins(data, origins);
    originIndex.set(itemId, origins);
    if (origins.length) next.localItemOrigins = [...(next.localItemOrigins ?? []).filter(row => row.itemId !== itemId), { itemId, records: origins }];
    const savedData = { ...data, trashed: record.deleted || data.trashed === true };
    const item = await nearbyWireToLocalItem(savedData, { id: itemId, providerId: provider.id, now, previous: existing });
    const files: LocalItemAttachment[] = [];
    const retained = record.deleted && existing && (data.assets === undefined || isNearbyTombstone(wireObject(parseLosslessJson(record.dataJson))))
      ? (next.localItemAttachments ?? []).filter(file => file.itemId === existing.id) : undefined;
    if (retained) files.push(...structuredClone(retained));
    for (const [index, raw] of (retained ? [] : (data.assets as unknown[] | undefined) ?? []).entries()) {
      const asset = wireObject(raw), id = wireText(asset.id).toLowerCase(), body = assets.get(id);
      if (body === undefined) invalidNearby('adoption-asset-missing');
      files.push({ itemId, attachmentId: `nearby-${id}-${index}`, fileName: wireText(asset.file_name), mediaType: wireText(asset.media_type),
        sizeBytes: Number(wireInteger(asset.size, 16n * 1024n * 1024n)), sha256: id, dataBase64: body, protected: true });
    }
    await validateLocalAttachments(files, itemId);
    if (data.folder) {
      const path = data.folder_path as Array<{ id: string; title: string }> | undefined;
      const identity = path?.length ? path[path.length - 1].id : `legacy:${data.folder}`;
      const origin = `nearby-folder:${identity}`;
      let category = next.localTransferFolders?.find(folder => folder.origin === origin);
      const known = originalMetadata.find(row => !row.value.deleted && row.data.entry_type === 'folder' && row.value.categoryKey !== undefined
        && (row.value.recordId === identity || (wireObject(row.data.payload).path as Array<{ id: string }>).slice(-1)[0]?.id === identity));
      if (!category && known) category = next.localTransferFolders?.find(folder => nearbyCategoryKey(folder) === known.value.categoryKey);
      if (!category && known?.value.categoryKey?.startsWith('name:')) {
        // A legacy name-only category has no numeric identity yet. Keep its
        // exact spelling until the final folder batch can normalize all members.
        item.categoryId = undefined; item.categoryName = known.data.title;
      } else {
        if (!category) {
          category = { origin, categoryId: known?.value.categoryKey?.startsWith('id:') ? Number(known.value.categoryKey.slice(3)) : nextNearbyCategoryId(next),
            categoryName: known?.data.title ?? data.folder };
          next.localTransferFolders = [...(next.localTransferFolders ?? []), category];
        }
        item.categoryId = category.categoryId; item.categoryName = category.categoryName;
      }
    }
    next.items = [...next.items.filter(candidate => candidate.id !== itemId), item];
    next.localItemAttachments = [...(next.localItemAttachments ?? []).filter(file => file.itemId !== itemId), ...files];
    const acknowledgement: NearbyLocalAcknowledgement = { recordId: record.id, clockJson: record.clockJson, localId: `local:${itemId}`, scope: 'local',
      guard: await itemGuard(item, files, origins), dataJson: origins.length ? JSON.stringify(data) : record.dataJson };
    const receipt: NearbyLocalReceipt = { version: 1, providerId: provider.id, recordId: record.id, itemId, fingerprint: row.fingerprint,
      dataJson: JSON.stringify(data), baseline: item, acknowledgement };
    if (record.deleted && isNearbyTombstone(wireObject(parseLosslessJson(record.dataJson)))) acknowledgement.dataJson = JSON.stringify(data);
    byId.set(record.id, receipt); acknowledgements.push(acknowledgement);
  }
  for (const metadata of metadataChanges.filter(row => row.categoryKey !== undefined)) {
    const previous = originalMetadata.find(row => row.value.localId === metadata.localId)?.value.categoryKey;
    const folder = next.localTransferFolders?.find(row => nearbyCategoryKey(row) === metadata.categoryKey);
    for (const item of next.items) if (isLocalTransferItem(item, next.providers)
      && (nearbyCategoryKey(item) === previous && previous !== undefined || nearbyCategoryKey(item) === metadata.categoryKey)) {
      requireUncontended(next, item.id);
      item.categoryId = metadata.deleted ? undefined : folder?.categoryId;
      item.categoryName = metadata.deleted ? undefined : folder?.categoryName;
    }
  }
  // Resolve complete project links after every item is staged, so input order
  // cannot disconnect a note, SSO account or bound authenticator.
  // Legacy local items had an implicit []/"local" source. Received entries use
  // the real local provider ID; normalize that equivalent scope together so
  // existing note/SSO links remain resolvable. Never rebind external sources.
  for (const item of next.items) if (bareLocalReferences(item, 'local')) {
    requireUncontended(next, item.id); item.providerRefs = [{ providerId: provider.id }];
  }
  for (const row of work.filter(row => !row.replay && row.data.entry_type === 'totp')) {
    const itemId = byId.get(row.record.id)!.itemId;
    for (const owner of next.items) if (owner.kind === 'login' && owner.boundTotpItemId === itemId) {
      requireUncontended(next, owner.id); owner.boundTotpItemId = undefined;
    }
  }
  const resolve = (id: unknown): VaultItem | undefined => {
    if (typeof id !== 'string' || !idPattern.test(id)) return undefined;
    const receipt = byId.get(id), localId = receipt?.itemId ?? resolvedReferences.get(id);
    if (receipt && resolvedReferences.has(id) && resolvedReferences.get(id) !== receipt.itemId) invalidNearby('reference-binding-conflict');
    const item = localId && next.items.find(item => item.id === localId);
    if (!item || !isLocalTransferItem(item, next.providers)) invalidNearby('reference-target-missing');
    return item;
  };
  for (const row of work.filter(row => !row.replay && !row.retiredDeletion && !isNearbyMetadata(row.data))) {
    const receipt = byId.get(row.record.id)!, item = next.items.find(item => item.id === receipt.itemId)!;
    const payload = wireObject(row.data.entry_type === 'login' || row.data.entry_type === 'ssh-key' ? row.data.extensions ?? {} : row.data.payload);
    if (item.kind === 'login') {
      const note = resolve(payload.bound_note_entry_id);
      if (note) { if (note.kind !== 'secure-note') invalidNearby('note-target-type'); item.boundNoteEntryId = `note:${note.id}`; }
      const account = resolve(payload.sso_ref_entry_id);
      if (account) { if (account.kind !== 'login' || account.id === item.id) invalidNearby('sso-target-type'); item.ssoRefLogicalId = `password:${account.id}`; item.ssoRefEntryId = undefined; }
    }
    if (item.kind === 'totp') {
      const owner = item.deletedAt ? undefined : resolve(payload.bound_password_entry_id);
      if (owner) {
        if (owner.kind !== 'login' || owner.boundTotpItemId && owner.boundTotpItemId !== item.id) invalidNearby('otp-owner-conflict');
        requireUncontended(next, owner.id); owner.boundTotpItemId = item.id;
      }
      item.boundPasswordId = undefined;
    }
  }
  for (const row of work.filter(row => !row.replay && !row.retiredDeletion && !isNearbyMetadata(row.data))) {
    const receipt = byId.get(row.record.id)!, item = next.items.find(item => item.id === receipt.itemId)!;
    receipt.baseline = structuredClone(item);
    receipt.acknowledgement.guard = await itemGuard(item, (next.localItemAttachments ?? []).filter(file => file.itemId === item.id), (originIndex.get(item.id) ?? []));
  }
  next.nearbyLocalReceipts = readNearbyLocalReceipts([...byId.values()]);
  if (metadataChanges.length) {
    const finalMetadata = await captureNearbyMetadata(next);
    const savedMetadata = readNearbyLocalMetadata(next.nearbyLocalMetadata);
    for (const changed of metadataChanges) {
      const current = finalMetadata.find(row => row.value.localId === changed.localId)!;
      changed.acknowledgement!.guard = current.guard;
      changed.acknowledgement!.dataJson = JSON.stringify(current.data);
      savedMetadata.find(row => row.localId === changed.localId)!.acknowledgement = structuredClone(changed.acknowledgement);
    }
    next.nearbyLocalMetadata = readNearbyLocalMetadata(savedMetadata);
  }
  next.updatedAt = now;
  const ackById = new Map(acknowledgements.map(row => [row.recordId, row]));
  return { state: next, acknowledgements: input.records.map(row => ackById.get(row.id)!), changed: true };
}
