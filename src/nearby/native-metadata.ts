import { cloneLosslessJson, parseLosslessJson } from '../core/lossless-json';
import type { Mdbx2ContentLabel } from '../providers/mdbx2/content-metadata';
import type { Mdbx2ContentCommand } from '../providers/mdbx2/content-write';
import { mdbx2TransferOperationScope as hash, mdbx2TransferUuid } from '../providers/mdbx2/mdbx2-transfer-identity';
import { nativeId, type NearbyNativeSource } from './native-source';
import { projectNearbyCollectionArchive } from './native-profiles';
import { invalidNearby, validateNearbyWireData, wireInteger, wireObject, wireText, type NearbyWireData } from './wire-shape';

export const NATIVE_ROOT_TAGS = 'monica-device-root-tags-v2';
export const NATIVE_FOLDER_TITLE = 'monica-device-folder-title-v2';
export const NATIVE_PROJECT_TAG = 'monica-project-tag';
export const NATIVE_FOLDER_DATA = 'monica-device-folder-data-v1';
/** Validate before an encrypted write intent is staged. Opaque JSON values are
 * allowed, but malformed JSON and internal ownership-marker injection are not. */
export function validateNearbyNativeLabelPayload(text: string): void {
  let value: unknown;
  try { value = parseLosslessJson(text); } catch { invalidNearby('native-label-json'); }
  if (value && typeof value === 'object' && !Array.isArray(value)
    && [NATIVE_PROJECT_TAG, NATIVE_ROOT_TAGS, NATIVE_FOLDER_TITLE, NATIVE_FOLDER_DATA].includes((value as Record<string, unknown>).kind as string)) invalidNearby('native-reserved-label-kind');
}
export function nearbyNativePayloadVersion(value: unknown): number {
  const version = Number(wireInteger(value, 0xffff_ffffn));
  if (version === 0) invalidNearby('native-payload-version');
  return version;
}
export interface NearbyNativeMetadataRecord {
  kind: 'folder' | 'root'; id: string; localId: string; scope: string; guard: string; deleted: boolean;
  data: NearbyWireData | Record<string, never>;
}
interface Node { id: string; title: string; parent: string | null }
interface Marker { label: Mdbx2ContentLabel; payload: Record<string, unknown>; owner: string; tagIds: string[] }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const parsedLabels = new WeakMap<Mdbx2ContentLabel, { text: string | null; deleted: boolean; value?: Record<string, unknown> }>();
function payload(label: Mdbx2ContentLabel): Record<string, unknown> | undefined {
  const cached = parsedLabels.get(label);
  if (cached && cached.text === label.payloadJson && cached.deleted === label.deleted) return cached.value;
  let value: Record<string, unknown> | undefined;
  if (!label.deleted && label.payloadJson !== null) try { value = wireObject(parseLosslessJson(label.payloadJson)); } catch { /* Keep opaque payload in the source. */ }
  parsedLabels.set(label, { text: label.payloadJson, deleted: label.deleted, value }); return value;
}
function kind(label: Mdbx2ContentLabel): unknown { return payload(label)?.kind; }
function labelIndex(source: NearbyNativeSource): Map<string, Mdbx2ContentLabel[]> {
  const index = new Map<string, Mdbx2ContentLabel[]>();
  for (const label of source.metadata.labels) { const rows = index.get(label.collectionId) ?? []; rows.push(label); index.set(label.collectionId, rows); }
  return index;
}
function logicalTitle(labels: Mdbx2ContentLabel[], title: string): string {
  const titles = labels.filter(label => kind(label) === NATIVE_FOLDER_TITLE)
    .map(label => payload(label)!).filter(value => value.local_title === title).map(value => wireText(value.logical_title));
  if (new Set(titles).size > 1 || titles.some(t => t.length > 4096)) invalidNearby('native-folder-title');
  return titles[0] ?? title;
}
export function nearbyNativeFolderPaths(source: NearbyNativeSource): Map<string, Node[]> {
  const projects = new Map(source.collections.map(row => [row.collectionId, row]));
  const labels = labelIndex(source), titles = new Map(source.collections.map(row => [row.collectionId, logicalTitle(labels.get(row.collectionId) ?? [], row.title)]));
  const result = new Map<string, Node[]>();
  for (const project of source.collections) {
    const path: Node[] = [], seen = new Set<string>(); let current = project;
    while (current.collectionId !== source.rootId) {
      const id = nativeId(current.collectionId), parent = current.groupId;
      if (seen.has(id) || path.length >= 128) invalidNearby('native-folder-cycle'); seen.add(id);
      path.push({ id, title: titles.get(id)!, parent: parent && parent !== source.rootId ? parent : null });
      if (!parent || parent === source.rootId) break;
      const next = projects.get(parent); if (!next) invalidNearby('native-folder-parent-missing'); current = next;
    }
    result.set(project.collectionId, path.reverse());
  }
  return result;
}
function markers(source: NearbyNativeSource): Marker[] {
  const result: Marker[] = [], owners = new Set<string>(), assigned = new Map<string, string>();
  for (const label of source.metadata.labels.filter(row => row.collectionId === source.rootId && kind(row) === NATIVE_ROOT_TAGS)) {
    const value = payload(label)!, owner = wireText(value.owner);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(owner) || owners.has(owner) || typeof value.deleted !== 'boolean' || !Array.isArray(value.tag_ids) || value.tag_ids.length > 8192) invalidNearby('native-root-marker');
    const data = wireObject(value.data);
    if ((!value.deleted || Object.keys(data).length) && (data.entry_type !== 'vault-metadata' || !data.payload)) invalidNearby('native-root-marker-type');
    const tagIds = value.tag_ids.map(nativeId); if (new Set(tagIds).size !== tagIds.length) invalidNearby('native-root-marker');
    // Android gives every non-root marker exactly its IDs; root gets the rest.
    // Reject conflicting owners instead of silently duplicating a tag.
    if (owner !== source.rootId) for (const id of tagIds) { if (assigned.has(id) && assigned.get(id) !== owner) invalidNearby('native-root-ownership'); assigned.set(id, owner); }
    owners.add(owner); result.push({ label, payload: value, owner, tagIds });
  }
  return result;
}
function tagGroups(source: NearbyNativeSource, values: Marker[]): Map<string, Mdbx2ContentLabel[]> {
  const owners = new Map<string, string>(), groups = new Map<string, Mdbx2ContentLabel[]>();
  for (const marker of values) if (marker.owner !== source.rootId) for (const id of marker.tagIds) owners.set(id, marker.owner);
  for (const label of source.metadata.labels) if (label.collectionId === source.rootId && kind(label) === NATIVE_PROJECT_TAG) {
    const owner = owners.get(label.labelId) ?? source.rootId, tags = groups.get(owner) ?? []; tags.push(label); groups.set(owner, tags);
  }
  return groups;
}
const tags = (values: Mdbx2ContentLabel[]) => [...values].sort((a, b) => compare(a.name, b.name) || compare(a.labelId, b.labelId))
  .map(label => ({ name: label.name, payload: label.payloadJson!, version: label.payloadSchemaVersion }));

export interface NearbyNativeMetadataContents {
  marker?: Mdbx2ContentLabel;
  saved: Record<string, unknown>;
  labels: Mdbx2ContentLabel[];
  assets: NearbyNativeSource['attachments'];
}
/** Root records share a native collection. Saved local IDs partition their
 * labels/files; unclaimed native content belongs to the vault's own root. */
export function nearbyNativeMetadataContents(source: NearbyNativeSource): Map<string, NearbyNativeMetadataContents> {
  const values=markers(source), result=new Map<string,NearbyNativeMetadataContents>();
  const labelOwners=new Map<string,string>(),assetOwners=new Map<string,string>();
  const assigned=new Set(source.metadata.assignments.filter(row=>!row.deleted).map(row=>row.labelId));
  for(const value of values){
    const labelIds=value.payload.label_ids ?? [],assets=value.payload.device_sync_assets ?? [];
    if(!Array.isArray(labelIds)||labelIds.length>8192||!Array.isArray(assets)||assets.length>64)invalidNearby('native-root-ownership');
    for(const [ids,owners] of [[labelIds,labelOwners],[assets.map(a=>wireObject(a).local_id),assetOwners]] as const){
      const seen=new Set<string>();
      for(const raw of ids){const id=nativeId(raw);if(seen.has(id))invalidNearby('native-root-ownership');seen.add(id);
        if(value.owner!==source.rootId){if(owners.has(id)&&owners.get(id)!==value.owner)invalidNearby('native-root-ownership');owners.set(id,value.owner);}}
    }
    result.set(`root:${value.owner}`,{marker:value.label,saved:value.payload,labels:[],assets:[]});
  }
  if(source.collections.some(row=>row.collectionId===source.rootId)&&!result.has(`root:${source.rootId}`))result.set(`root:${source.rootId}`,{saved:{},labels:[],assets:[]});
  for(const collection of source.collections.filter(row=>row.collectionId!==source.rootId)){
    const found=source.metadata.labels.filter(label=>label.collectionId===collection.collectionId && kind(label)===NATIVE_FOLDER_DATA);
    if(found.length>1)invalidNearby('native-folder-data-marker');
    if(found.some(label=>label.payloadSchemaVersion!==1 || payload(label)?.data===undefined))invalidNearby('native-folder-data-marker');
    for (const label of found) {
      const marker = payload(label)!, data = wireObject(marker.data);
      if (marker.purged === true) {
        if (Object.keys(data).length) invalidNearby('native-folder-data-marker');
      } else {
        validateNearbyWireData(data);
        if (data.entry_type !== 'folder' || data.folder !== '') invalidNearby('native-folder-data-marker');
      }
    }
    result.set(`folder:${collection.collectionId}`,{marker:found[0],saved:found[0]?payload(found[0])!:{},labels:[],assets:[]});
  }
  for(const label of source.metadata.labels){
    if(label.deleted||assigned.has(label.labelId))continue;
    const type=kind(label);
    if([NATIVE_PROJECT_TAG,NATIVE_FOLDER_TITLE,NATIVE_FOLDER_DATA].includes(type as string)||type===NATIVE_ROOT_TAGS&&label.collectionId===source.rootId)continue;
    const key=label.collectionId===source.rootId?`root:${labelOwners.get(label.labelId)??source.rootId}`:`folder:${label.collectionId}`;
    const contents=result.get(key);if(!contents)invalidNearby('native-metadata-owner-missing');contents.labels.push(label);
  }
  for(const asset of source.attachments){
    if(asset.objectId!==null)continue;
    const key=asset.collectionId===source.rootId?`root:${assetOwners.get(asset.attachmentId)??source.rootId}`:`folder:${asset.collectionId}`;
    const contents=result.get(key);if(!contents)invalidNearby('native-metadata-owner-missing');contents.assets.push(asset);
  }
  return result;
}

/** Android-compatible folder/root records. Full source inventory also retains
 * unrelated labels, assignments, profiles and folder assets for adoption. */
export async function projectNearbyNativeMetadata(input: NearbyNativeSource): Promise<NearbyNativeMetadataRecord[]> {
  const source = cloneLosslessJson(input), paths = nearbyNativeFolderPaths(source), values = markers(source);
  const rootTags = tagGroups(source, values), markerIndex = new Map(values.map(row => [row.owner, row])), labelsByOwner = labelIndex(source);
  const contents=nearbyNativeMetadataContents(source);
  const profiles=new Map(source.profiles?.map(row=>[row.collectionId,row])),rootProject=source.collections.find(row=>row.collectionId===source.rootId);
  const folderAssets = new Map<string, typeof source.attachments>();
  for (const asset of source.attachments) if (asset.objectId === null) { const rows = folderAssets.get(asset.collectionId) ?? []; rows.push(asset); folderAssets.set(asset.collectionId, rows); }
  const result: NearbyNativeMetadataRecord[] = [], scope = `mdbx:${source.providerId}`;
  if (source.collections.some(row => row.collectionId === source.rootId)) {
    for (const owner of [...new Set([source.rootId, ...values.map(marker => marker.owner)])].sort(compare)) {
      const marker = markerIndex.get(owner), owned = rootTags.get(owner) ?? [],extra=contents.get(`root:${owner}`)!;
      const retainedTrash = marker?.payload.deleted === true && wireObject(marker.payload.data ?? {}).trashed === true;
      const deleted = marker?.payload.deleted === true && (retainedTrash || owned.length === 0 && extra.labels.length===0 && !extra.assets.some(a=>!a.deleted));
      let data: Record<string, unknown> = deleted && !retainedTrash ? {} : marker?.payload.data && wireObject(marker.payload.data).payload
        ? cloneLosslessJson(wireObject(marker.payload.data)) : { title: 'Vault metadata', folder: '', entry_type: 'vault-metadata', payload: {} };
      if (!deleted || retainedTrash) { wireObject(data.payload).tags = tags(owned); if(extra.labels.length||data.labels!==undefined)data.labels=tags(extra.labels); validateNearbyWireData(data); if (data.entry_type !== 'vault-metadata') invalidNearby('native-root-marker-type'); }
      const project=owner===source.rootId?rootProject:undefined,profile=profiles.get(owner);
      if(owner===source.rootId && Object.keys(data).length && project)data=projectNearbyCollectionArchive(data as NearbyWireData,project,profile,extra.saved.device_sync_collection_applied===true);
      result.push({ kind: 'root', id: owner, localId: `${scope}:metadata:${owner}`, scope, deleted, data: data as NearbyWireData,
        guard: await hash({ marker: marker?.label ?? null, tags: [...owned].sort((a, b) => compare(a.labelId, b.labelId)), labels:extra.labels,attachments:extra.assets,
          ...(owner===source.rootId?{profile:profile?{...profile,payloadBase64:undefined}:null,presentation:project?{favorite:project.favorite,archived:project.archived,iconRef:project.iconRef??null}:null}:{}) }) });
    }
  }
  for (const project of source.collections) {
    const path = paths.get(project.collectionId)!; if (!path.length) continue;
    const labels = (labelsByOwner.get(project.collectionId) ?? []).filter(row => !row.deleted);
    const extra=contents.get(`folder:${project.collectionId}`)!,saved=extra.saved.data===undefined?{}:wireObject(extra.saved.data);
    if (project.deleted && extra.saved.purged === true) {
      result.push({kind:'folder',id:project.collectionId,localId:`${scope}:folder:${project.collectionId}`,scope,deleted:true,data:{},
        guard:await hash({project,labels,attachments:folderAssets.get(project.collectionId)??[]})});
      continue;
    }
    let data: NearbyWireData = { ...cloneLosslessJson(saved), title: path[path.length - 1].title, folder: '', entry_type: 'folder', trashed: project.deleted,
      payload: { ...(saved.payload===undefined?{}:wireObject(saved.payload)), path: path.map(node=>({...(Array.isArray(wireObject(saved.payload??{}).path)?(wireObject(saved.payload??{}).path as unknown[]).map(wireObject).find(old=>old.id===node.id):undefined),...node})), tags: tags(labels.filter(row => kind(row) === NATIVE_PROJECT_TAG)) } };
    if(extra.labels.length||data.labels!==undefined)data.labels=tags(extra.labels);
    data=projectNearbyCollectionArchive(data,project,profiles.get(project.collectionId),extra.saved.device_sync_collection_applied===true);
    validateNearbyWireData(data);
    result.push({ kind: 'folder', id: project.collectionId, localId: `${scope}:folder:${project.collectionId}`, scope, deleted: project.deleted, data,
      guard: await hash({ project, labels, attachments: folderAssets.get(project.collectionId) ?? [] }) });
  }
  if (new Set(result.map(row => row.id)).size !== result.length) invalidNearby('native-metadata-identity-collision');
  return result;
}

export interface NearbyNativeMetadataChange {
  kind: 'folder' | 'root'; id: string; expectedGuard: string | null; deleted: boolean; data: NearbyWireData | Record<string, never>;
}
/** Plan only. Caller commits with source.writeRevision through atomic content
 * write and must persist/recover the native receipt before acknowledging sync. */
export async function planNearbyNativeMetadata(input: NearbyNativeSource, operationId: string, incoming: readonly NearbyNativeMetadataChange[], adoptAssets = false): Promise<Mdbx2ContentCommand[]> {
  const source = cloneLosslessJson(input), changes = cloneLosslessJson(incoming), operation = nativeId(operationId);
  if (!Array.isArray(changes) || changes.length > 128) invalidNearby('native-metadata-batch-limit');
  const current = new Map((await projectNearbyNativeMetadata(source)).map(row => [row.id, row]));
  const changeIds = new Set<string>();
  for (const row of changes) {
    if (!['folder', 'root'].includes(row.kind) || !/^[A-Za-z0-9_-]{1,64}$/.test(row.id) || typeof row.deleted !== 'boolean' || changeIds.has(row.id)) invalidNearby('native-metadata-change');
    changeIds.add(row.id); const before = current.get(row.id);
    if ((before?.guard ?? null) !== row.expectedGuard || before && before.kind !== row.kind) invalidNearby('native-metadata-stale');
    const data = wireObject(row.data);
    if (!row.deleted || Object.keys(data).length) {
      validateNearbyWireData(data);
      if (data.entry_type !== (row.kind === 'root' ? 'vault-metadata' : 'folder')) invalidNearby('native-metadata-type');
      // Metadata assets need the shared asset adoption planner; never ignore them.
      if (!adoptAssets && Array.isArray(data.assets) && data.assets.length) invalidNearby('native-metadata-assets-required');
      if (row.kind === 'folder') {
        // Folder ancestry belongs to payload.path; the object-only folder field
        // must not silently redirect a metadata record.
        if (data.folder !== '') invalidNearby('native-folder-archive-required');
      }
    }
  }
  const commands: Mdbx2ContentCommand[] = [], projects = new Map(source.collections.map(row => [row.collectionId, { ...row }]));
  const labelIds = new Set(source.metadata.labels.map(row => row.labelId));
  const makeId = async (name: string) => { const id = await mdbx2TransferUuid(operation, name); if (labelIds.has(id)) invalidNearby('native-metadata-id-collision'); labelIds.add(id); return id; };
  const root = source.rootId;
  if (changes.length && !projects.has(root)) {
    commands.push({ kind: 'collection-create', collectionId: root, title: '.monica-root', parentId: null });
    projects.set(root, { collectionId: root, title: '.monica-root', favorite: false, archived: false, attachmentCount: 0, headCommitId: operation, deleted: false, updatedAt: '' });
  }
  const values = markers(source);
  const rootTags = tagGroups(source, values);
  const contents=nearbyNativeMetadataContents(source);
  const reconcile = async (collectionId: string, owner: string, existing: Mdbx2ContentLabel[], desired: unknown, onlyTags = true): Promise<string[]> => {
    if (!Array.isArray(desired) || desired.length > 8192) invalidNearby('native-tags');
    const kept = new Set<string>();
    for (let index = 0; index < desired.length; index++) {
      const tag = wireObject(desired[index]), name = wireText(tag.name), text = wireText(tag.payload), version = nearbyNativePayloadVersion(tag.version);
      if (Object.keys(tag).some(key => !['name', 'payload', 'version'].includes(key))) invalidNearby('native-tag-archive-required');
      if (onlyTags && wireObject(parseLosslessJson(text)).kind !== NATIVE_PROJECT_TAG) invalidNearby('native-tag-kind');
      if(!onlyTags)validateNearbyNativeLabelPayload(text);
      const old = existing.find(label => !kept.has(label.labelId) && label.name === name), id = old?.labelId ?? await makeId(`tag:${owner}:${index}`); kept.add(id);
      if (!old) commands.push({ kind: 'label-create', labelId: id, collectionId, name, payloadJson: text, payloadSchemaVersion: version });
      else if (old.payloadJson !== text || old.payloadSchemaVersion !== version) commands.push({ kind: 'label-update', labelId: id, name: old.name, payloadJson: text, payloadSchemaVersion: version });
    }
    existing.filter(label => !kept.has(label.labelId)).forEach(label => commands.push({ kind: 'label-delete', labelId: label.labelId }));
    return [...kept];
  };
  const desiredNodes = new Map<string, Node>(), targetNodes = new Set<string>();
  for (const row of changes.filter(row => row.kind === 'folder')) {
    nativeId(row.id); if (row.id === root) invalidNearby('native-root-folder');
    if (!Object.keys(row.data).length) { if (!projects.has(row.id)) invalidNearby('native-folder-tombstone-missing'); continue; }
    const data = row.data as NearbyWireData, path = cloneLosslessJson(wireObject(data.payload).path) as Node[];
    path[path.length - 1] = { ...path[path.length - 1], id: row.id, title: data.title }; targetNodes.add(row.id);
    let parent: string | null = null;
    for (const node of path) {
      nativeId(node.id); if (node.id === root || node.parent !== parent || node.title.length > 4096) invalidNearby('native-folder-path');
      const old = desiredNodes.get(node.id); if (old && (old.title !== node.title || old.parent !== node.parent)) invalidNearby('native-folder-path-conflict');
      desiredNodes.set(node.id, node); parent = node.id;
    }
  }
  // Plan parent-first, independent of incoming record order; validate cycles in
  // the final topology as well as in each individual path.
  const done = new Set<string>();
  const ensure = async (id: string, ancestors: Set<string>): Promise<void> => {
    if (done.has(id)) return; if (ancestors.has(id) || ancestors.size >= 128) invalidNearby('native-folder-cycle');
    const node = desiredNodes.get(id)!; const parent = node.parent ?? root;
    if (desiredNodes.has(parent)) await ensure(parent, new Set(ancestors).add(id));
    const old = projects.get(id);
    if (old && !targetNodes.has(id)) { done.add(id); return; }
    let title = node.title;
    const occupied = (name: string) => [...projects.values()].some(row => row.collectionId !== id && !row.deleted && (row.groupId ?? root) === parent && row.title.toLowerCase() === name.toLowerCase());
    if (occupied(title)) {
      title = `${node.title.slice(0, 4080)} [${id.slice(0, 8)}]`;
      if (occupied(title)) title = `${node.title.slice(0, 4050)} [${id}]`;
      if (occupied(title)) invalidNearby('native-folder-title-collision');
    }
    if (!old) commands.push({ kind: 'collection-create', collectionId: id, title, parentId: parent });
    else {
      if (old.deleted) commands.push({ kind: 'collection-restore', collectionId: id, parentId: parent });
      if (old.title !== title) commands.push({ kind: 'collection-rename', collectionId: id, title });
      if ((old.groupId ?? root) !== parent) commands.push({ kind: 'collection-move', collectionId: id, parentId: parent });
    }
    projects.set(id, { ...(old ?? { favorite: false, archived: false, attachmentCount: 0, headCommitId: operation, updatedAt: '' }), collectionId: id, title, groupId: parent, deleted: false });
    const existing = source.metadata.labels.filter(label => label.collectionId === id && kind(label) === NATIVE_FOLDER_TITLE);
    if (existing.length > 1) invalidNearby('native-folder-title');
    // The user can intentionally adopt the stored collision name. Refresh an
    // existing marker even without another collision, or recapture revives its
    // old logical title while local_title still matches the unchanged name.
    if (title !== node.title || existing.length) {
      const marker = existing[0], text = JSON.stringify({ ...(marker ? payload(marker) : {}), kind: NATIVE_FOLDER_TITLE, logical_title: node.title, local_title: title });
      if (!marker) commands.push({ kind: 'label-create', labelId: await makeId(`folder-title:${id}`), collectionId: id, name: NATIVE_FOLDER_TITLE, payloadJson: text, payloadSchemaVersion: 1 });
      else if (marker.payloadJson !== text) commands.push({ kind: 'label-update', labelId: marker.labelId, name: marker.name, payloadJson: text, payloadSchemaVersion: marker.payloadSchemaVersion });
    }
    done.add(id);
  };
  for (const id of desiredNodes.keys()) await ensure(id, new Set());
  for (const row of changes) {
    if (row.kind === 'folder') {
      const data = row.data as NearbyWireData;
      const purge = row.deleted && !Object.keys(data).length;
      const extra=contents.get(`folder:${row.id}`);
      // Native rejects label-create on a trashed collection but accepts
      // label-update/label-delete: only restore when the purged marker still
      // needs to be created, otherwise refresh the existing marker in place.
      if (purge && !extra?.marker && projects.get(row.id)?.deleted) {
        commands.push({kind:'collection-restore',collectionId:row.id,parentId:projects.get(row.id)!.groupId??root});
        projects.get(row.id)!.deleted=false;
      }
      if (purge || wireObject(data.payload).tags !== undefined) await reconcile(row.id, `folder:${row.id}`,
        source.metadata.labels.filter(label => label.collectionId === row.id && kind(label) === NATIVE_PROJECT_TAG), purge?[]:wireObject(data.payload).tags);
      if(purge || data.labels!==undefined)await reconcile(row.id,`folder-label:${row.id}`,extra?.labels??[],purge?[]:data.labels,false);
      {
        const text=JSON.stringify({...extra?.saved,kind:NATIVE_FOLDER_DATA,purged:purge,data,...(purge?{device_sync_assets:[],device_sync_images:{}}:{})});
        if(!extra?.marker)commands.push({kind:'label-create',labelId:await makeId(`folder-data:${row.id}`),collectionId:row.id,name:NATIVE_FOLDER_DATA,payloadJson:text,payloadSchemaVersion:1});
        else if(extra.marker.payloadJson!==text)commands.push({kind:'label-update',labelId:extra.marker.labelId,name:extra.marker.name,payloadJson:text,payloadSchemaVersion:extra.marker.payloadSchemaVersion});
      }
      if (row.deleted && projects.get(row.id)?.deleted === false) { commands.push({ kind: 'collection-trash', collectionId: row.id }); projects.get(row.id)!.deleted = true; }
    } else {
      const purge = row.deleted && !Object.keys(row.data).length;
      const before = values.find(value => value.owner === row.id), ids = await reconcile(root, `root:${row.id}`, rootTags.get(row.id) ?? [], purge ? [] : wireObject((row.data as NearbyWireData).payload).tags);
      const extra=contents.get(`root:${row.id}`),desired=purge?[]:row.data.labels;
      const labelIds=desired===undefined?extra?.labels.map(label=>label.labelId)??[]:await reconcile(root,`root-label:${row.id}`,extra?.labels??[],desired,false);
      const text = JSON.stringify({ ...before?.payload, kind: NATIVE_ROOT_TAGS, owner: row.id, deleted: row.deleted, data: row.data, tag_ids: ids, label_ids:labelIds });
      if (!before) commands.push({ kind: 'label-create', labelId: await makeId(`root-marker:${row.id}`), collectionId: root, name: NATIVE_ROOT_TAGS, payloadJson: text, payloadSchemaVersion: 1 });
      else if (before.label.payloadJson !== text) commands.push({ kind: 'label-update', labelId: before.label.labelId, name: before.label.name, payloadJson: text, payloadSchemaVersion: before.label.payloadSchemaVersion });
    }
  }
  // Existing ancestors may have changed through another target in this batch.
  nearbyNativeFolderPaths({ ...source, collections: [...projects.values()] });
  if (commands.length > 128 || new TextEncoder().encode(JSON.stringify(commands)).length > 8 * 1024 * 1024) invalidNearby('native-metadata-batch-limit');
  return commands;
}
