import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseLosslessJson } from '../core/lossless-json';
import type { Mdbx2ContentLabel } from '../providers/mdbx2/content-metadata';
import type { Mdbx2CollectionSummary } from '../providers/mdbx2/native-contract';
import { NATIVE_FOLDER_DATA, NATIVE_FOLDER_TITLE, NATIVE_PROJECT_TAG, NATIVE_ROOT_TAGS, nearbyNativeFolderPaths, planNearbyNativeMetadata, projectNearbyNativeMetadata, type NearbyNativeMetadataChange } from './native-metadata';
import type { NearbyNativeSource } from './native-source';

function project(id = randomUUID(), title = 'Folder', parent?: string): Mdbx2CollectionSummary {
  return { collectionId: id, title, groupId: parent, headCommitId: randomUUID(), deleted: false, updatedAt: '2026-10-14', favorite: false, archived: false, attachmentCount: 0 };
}
function fixture() {
  const root = randomUUID(), providerId = randomUUID(), folder = project(randomUUID(), 'Work', root), other = project(randomUUID(), 'Other', root);
  const writeRevision = { vaultId: randomUUID(), revisionSha256: 'a'.repeat(64) };
  const source: NearbyNativeSource = { providerId, vaultHandle: randomUUID(), rootId: root, writeRevision, sourceHash: 'b'.repeat(64),
    collections: [project(root, '.monica-root'), folder, other], objects: [], metadata: { writeRevision, labels: [], assignments: [], relations: [] }, attachments: [] };
  const label = (owner: string, name: string, data: unknown, version = 1) => {
    const result: Mdbx2ContentLabel = { labelId: randomUUID(), collectionId: owner, name, payloadJson: typeof data === 'string' ? data : JSON.stringify(data), payloadSchemaVersion: version, deleted: false, headCommitId: randomUUID(), updatedAt: '2026-10-14' };
    source.metadata.labels.push(result); return result;
  };
  const tag = (owner: string, name: string) => label(owner, name, { kind: NATIVE_PROJECT_TAG, color: 'purple' });
  const folderData = (id: string, title: string) => ({ title, folder: '', entry_type: 'folder' as const, payload: { path: [{ id, title, parent: null }], tags: [] } });
  const change = async (id: string, data: NearbyNativeMetadataChange['data'], kind: 'root' | 'folder' = 'folder', deleted = false): Promise<NearbyNativeMetadataChange> => ({ id, kind, data, deleted, expectedGuard: (await projectNearbyNativeMetadata(source)).find(row => row.id === id)?.guard ?? null });
  return { root, providerId, folder, other, source, label, tag, folderData, change };
}

describe('Android native metadata mapping', () => {
  it('keeps root tags owned separately and retains saved opaque root data', async () => {
    const f = fixture(), a = f.tag(f.root, 'First'), b = f.tag(f.root, 'Second'), owner = randomUUID();
    const data = { title: 'Original metadata', folder: '', entry_type: 'vault-metadata', payload: { tags: [], opaque: '{"big":9007199254740993}' }, future: { retained: true } };
    f.label(f.root, NATIVE_ROOT_TAGS, { kind: NATIVE_ROOT_TAGS, owner, deleted: false, data, tag_ids: [b.labelId] });
    const result = await projectNearbyNativeMetadata(f.source);
    expect(result.find(row => row.id === f.root)?.data).toMatchObject({ payload: { tags: [{ name: a.name }] } });
    expect(result.find(row => row.id === owner)?.data).toMatchObject({ ...data, payload: { ...data.payload, tags: [{ name: b.name }] } });
    expect(result.find(row => row.id === owner)?.localId).toBe(`mdbx:${f.providerId}:metadata:${owner}`);
  });
  it('preserves deleted metadata owners without exporting a live empty record', async () => {
    const f = fixture(), owner = randomUUID(); f.label(f.root, NATIVE_ROOT_TAGS, { kind: NATIVE_ROOT_TAGS, owner, deleted: true, data: {}, tag_ids: [] });
    expect((await projectNearbyNativeMetadata(f.source)).find(row => row.id === owner)).toMatchObject({ deleted: true, data: {} });
  });
  it('uses logical folder titles only while the marker matches the stored name', async () => {
    const f = fixture(); f.folder.title = 'Work [1234]'; f.label(f.folder.collectionId, NATIVE_FOLDER_TITLE, { kind: NATIVE_FOLDER_TITLE, local_title: 'Work [1234]', logical_title: 'Work' });
    expect(nearbyNativeFolderPaths(f.source).get(f.folder.collectionId)?.[0].title).toBe('Work');
    f.folder.title = 'Manual rename'; expect(nearbyNativeFolderPaths(f.source).get(f.folder.collectionId)?.[0].title).toBe('Manual rename');
  });
  it('does not hide a same-title ordinary folder and retains folder deletion', async () => {
    const f = fixture(); f.folder.title = '.monica-root'; f.folder.deleted = true;
    const row = (await projectNearbyNativeMetadata(f.source)).find(row => row.id === f.folder.collectionId)!;
    expect(row).toMatchObject({ deleted: true, data: { title: '.monica-root', trashed: true } });
  });
  it('includes unassigned metadata and folder assets in source guards', async () => {
    const f = fixture(), first = await projectNearbyNativeMetadata(f.source);
    f.label(f.folder.collectionId, 'Unassigned future label', '{"opaque":9007199254740993}');
    const second = await projectNearbyNativeMetadata(f.source);
    expect(first.find(row => row.id === f.folder.collectionId)?.guard).not.toBe(second.find(row => row.id === f.folder.collectionId)?.guard);
    expect(first.find(row => row.id === f.other.collectionId)?.guard).toBe(second.find(row => row.id === f.other.collectionId)?.guard);
  });
  it.each(['cycle', 'missing-parent', 'root-owner-collision', 'duplicate-marker', 'logical-title-conflict'])('rejects ambiguous %s metadata', async problem => {
    const f = fixture();
    if (problem === 'cycle') { f.folder.groupId = f.other.collectionId; f.other.groupId = f.folder.collectionId; }
    if (problem === 'missing-parent') f.folder.groupId = randomUUID();
    if (problem === 'root-owner-collision') {
      const tag = f.tag(f.root, 'Shared'); for (let n = 0; n < 2; n++) f.label(f.root, NATIVE_ROOT_TAGS, { kind: NATIVE_ROOT_TAGS, owner: randomUUID(), deleted: false, data: {}, tag_ids: [tag.labelId] });
    }
    if (problem === 'duplicate-marker') for (let n = 0; n < 2; n++) f.label(f.root, NATIVE_ROOT_TAGS, { kind: NATIVE_ROOT_TAGS, owner: 'same-owner', deleted: false, data: {}, tag_ids: [] });
    if (problem === 'logical-title-conflict') for (let n = 0; n < 2; n++) f.label(f.folder.collectionId, NATIVE_FOLDER_TITLE, { kind: NATIVE_FOLDER_TITLE, local_title: f.folder.title, logical_title: `Logical${n}` });
    await expect(projectNearbyNativeMetadata(f.source)).rejects.toThrow();
  });
});

describe('atomic native metadata adoption planning', () => {
  it('preserves labels and tags in retained root trash, distinct from a purge',async()=>{
    const f=fixture(),owner=randomUUID(),tag=f.tag(f.root,'Trash tag'),label=f.label(f.root,'Trash label','{"secret":"kept"}');
    const data={title:'Root trash',folder:'',entry_type:'vault-metadata' as const,trashed:true,payload:{tags:[{name:tag.name,payload:tag.payloadJson!,version:1}]},labels:[{name:label.name,payload:label.payloadJson!,version:1}]};
    f.label(f.root,NATIVE_ROOT_TAGS,{kind:NATIVE_ROOT_TAGS,owner,deleted:true,data,tag_ids:[tag.labelId],label_ids:[label.labelId]});
    const row=(await projectNearbyNativeMetadata(f.source)).find(row=>row.id===owner)!;
    expect(row).toMatchObject({deleted:true,data});
    const plan=await planNearbyNativeMetadata(f.source,randomUUID(),[{kind:'root',id:owner,expectedGuard:row.guard,deleted:true,data}]);
    expect(plan.some(c=>c.kind==='label-delete')).toBe(false);
  });
  it('refuses ambiguous and future folder markers instead of dropping saved fields',async()=>{
    for(const version of [1,2]){
      const f=fixture();f.label(f.folder.collectionId,NATIVE_FOLDER_DATA,{kind:NATIVE_FOLDER_DATA,...(version===2?{data:f.folderData(f.folder.collectionId,'Work')}:{})},version);
      await expect(projectNearbyNativeMetadata(f.source)).rejects.toMatchObject({code:'native-folder-data-marker'});
    }
  });
  it('retains unknown folder fields and path metadata while projecting current native names',async()=>{
    const f=fixture(),data:any=f.folderData(f.folder.collectionId,'Work');
    data.future=parseLosslessJson('{"n":9007199254740993}');data.payload.extra='kept';data.payload.path[0].future='path-extra';
    const commands=await planNearbyNativeMetadata(f.source,randomUUID(),[await f.change(f.folder.collectionId,data)]);
    const marker=commands.find(row=>row.kind==='label-create'&&row.name===NATIVE_FOLDER_DATA);if(marker?.kind!=='label-create')throw Error('No archive');
    f.label(f.folder.collectionId,marker.name,marker.payloadJson);
    f.folder.title='Native renamed';
    const result=(await projectNearbyNativeMetadata(f.source)).find(row=>row.id===f.folder.collectionId)!;
    expect(result.data).toMatchObject({title:'Native renamed',payload:{extra:'kept',path:[{title:'Native renamed',future:'path-extra'}]}});
    expect(JSON.stringify(result.data.future)).toBe('{"n":9007199254740993}');
  });
  it('partitions standalone root labels and refuses cross-owner claims',async()=>{
    const f=fixture(),owner=randomUUID(),a=f.label(f.root,'Own','{"a":1}'),b=f.label(f.root,'Peer','{"b":2}');
    f.label(f.root,NATIVE_ROOT_TAGS,{kind:NATIVE_ROOT_TAGS,owner,deleted:false,data:{title:'Peer',folder:'',entry_type:'vault-metadata',payload:{tags:[]}},tag_ids:[],label_ids:[b.labelId]});
    const records=await projectNearbyNativeMetadata(f.source);
    expect(records.find(row=>row.id===owner)?.data.labels).toEqual([{name:b.name,payload:b.payloadJson,version:1}]);
    expect(records.find(row=>row.id===f.root)?.data.labels).toEqual([{name:a.name,payload:a.payloadJson,version:1}]);
    f.label(f.root,NATIVE_ROOT_TAGS,{kind:NATIVE_ROOT_TAGS,owner:randomUUID(),deleted:false,data:{title:'Other root',folder:'',entry_type:'vault-metadata',payload:{tags:[]}},tag_ids:[],label_ids:[b.labelId]});
    await expect(projectNearbyNativeMetadata(f.source)).rejects.toThrow('native-root-ownership');
  });
  it('updates only the chosen root owner, retaining other owners and unrelated labels', async () => {
    const f = fixture(), a = f.tag(f.root, 'Local'), b = f.tag(f.root, 'Remote'), future = f.label(f.root, 'Unassigned', '{"future":true}'), owner = randomUUID();
    const marker = f.label(f.root, NATIVE_ROOT_TAGS, { kind: NATIVE_ROOT_TAGS, owner, deleted: false, data: { payload: { tags: [] }, title: 'Root', folder: '', entry_type: 'vault-metadata' }, tag_ids: [b.labelId], future_marker: true });
    const changed = await f.change(owner, {}, 'root', true), commands = await planNearbyNativeMetadata(f.source, randomUUID(), [changed]);
    expect(commands).toContainEqual({ kind: 'label-delete', labelId: b.labelId });
    expect(commands.some(row => 'labelId' in row && [a.labelId, future.labelId].includes(row.labelId))).toBe(false);
    const updated = commands.find(row => row.kind === 'label-update' && row.labelId === marker.labelId)!;
    expect(updated).toMatchObject({ payloadJson: JSON.stringify({ kind: NATIVE_ROOT_TAGS, owner, deleted: true, data: {}, tag_ids: [], future_marker: true, label_ids: [] }) });
  });
  it('preserves exact native numeric lexemes inside retained root data', async () => {
    const f = fixture(), owner = randomUUID(), data = parseLosslessJson('{"title":"Root","folder":"","entry_type":"vault-metadata","payload":{"tags":[],"big":9007199254740993,"decimal":1.00000000000000001}}') as NearbyNativeMetadataChange['data'];
    const commands = await planNearbyNativeMetadata(f.source, randomUUID(), [await f.change(owner, data, 'root')]);
    expect(JSON.stringify(commands)).toContain('9007199254740993'); expect(JSON.stringify(commands)).toContain('1.00000000000000001');
  });
  it('keeps logical names when siblings collide, with deterministic IDs for replay', async () => {
    const f = fixture(), id = randomUUID(), op = randomUUID(), change = await f.change(id, f.folderData(id, 'Work'));
    const commands = await planNearbyNativeMetadata(f.source, op, [change]);
    expect(commands).toContainEqual({ kind: 'collection-create', collectionId: id, title: `Work [${id.slice(0, 8)}]`, parentId: f.root });
    expect(commands).toContainEqual(expect.objectContaining({ kind: 'label-create', collectionId: id, payloadJson: JSON.stringify({ kind: NATIVE_FOLDER_TITLE, logical_title: 'Work', local_title: `Work [${id.slice(0, 8)}]` }) }));
    expect(await planNearbyNativeMetadata(f.source, op, [change])).toEqual(commands);
  });
  it('orders ancestor creation before nested folders and retains existing ancestors', async () => {
    const f = fixture(), parent = randomUUID(), child = randomUUID(), data = f.folderData(child, 'Child');
    data.payload.path = [{ id: parent, title: 'Parent', parent: null }, { id: child, title: 'Child', parent } as any];
    const commands = await planNearbyNativeMetadata(f.source, randomUUID(), [await f.change(child, data)]);
    expect(commands.filter(row => row.kind === 'collection-create').map(row => row.collectionId)).toEqual([parent, child]);
  });
  it('accepts the stored collision name as a new logical name without reviving an old marker', async () => {
    const f = fixture(); f.folder.title = 'Work [12345678]';
    const marker = f.label(f.folder.collectionId, NATIVE_FOLDER_TITLE, { kind: NATIVE_FOLDER_TITLE, local_title: f.folder.title, logical_title: 'Work', future: { retained: true } }, 3);
    const change = await f.change(f.folder.collectionId, f.folderData(f.folder.collectionId, f.folder.title));
    const commands = await planNearbyNativeMetadata(f.source, randomUUID(), [change]);
    const updated = commands.find(row => row.kind === 'label-update' && row.labelId === marker.labelId);
    expect(updated).toMatchObject({ kind: 'label-update', payloadSchemaVersion: 3 });
    if (updated?.kind !== 'label-update') throw new Error('Missing logical title update');
    marker.payloadJson = updated.payloadJson;
    expect(JSON.parse(marker.payloadJson)).toMatchObject({ future: { retained: true } });
    expect(nearbyNativeFolderPaths(f.source).get(f.folder.collectionId)?.[0].title).toBe('Work [12345678]');
  });
  it('restores a deleted folder before applying edits and preserves unrelated metadata', async () => {
    const f = fixture(); f.folder.deleted = true; const future = f.label(f.folder.collectionId, 'Future unassigned', '{}');
    const commands = await planNearbyNativeMetadata(f.source, randomUUID(), [await f.change(f.folder.collectionId, f.folderData(f.folder.collectionId, 'Renamed'))]);
    expect(commands[0]).toEqual({ kind: 'collection-restore', collectionId: f.folder.collectionId, parentId: f.root });
    expect(commands.some(row => 'labelId' in row && row.labelId === future.labelId)).toBe(false);
  });
  it('purges a trashed folder holding a marker through label-update without a restore round trip',async()=>{
    const f=fixture();f.folder.deleted=true;
    f.label(f.folder.collectionId,NATIVE_FOLDER_DATA,{kind:NATIVE_FOLDER_DATA,data:f.folderData(f.folder.collectionId,f.folder.title)});
    const commands=await planNearbyNativeMetadata(f.source,randomUUID(),[await f.change(f.folder.collectionId,{},'folder',true)]);
    expect(commands.some(row=>row.kind==='collection-restore'||row.kind==='collection-trash')).toBe(false);
    const updated=commands.find(row=>row.kind==='label-update');
    expect(updated).toMatchObject({kind:'label-update',name:NATIVE_FOLDER_DATA});
    if(updated?.kind!=='label-update')throw new Error('Missing marker update');
    expect(JSON.parse(updated.payloadJson)).toMatchObject({purged:true});
  });
  it('still restores a markerless trashed folder so the purged marker can be created',async()=>{
    const f=fixture();f.folder.deleted=true;
    const commands=await planNearbyNativeMetadata(f.source,randomUUID(),[await f.change(f.folder.collectionId,{},'folder',true)]);
    expect(commands[0]).toEqual({ kind: 'collection-restore', collectionId: f.folder.collectionId, parentId: f.root });
    expect(commands[commands.length-1]).toEqual({ kind: 'collection-trash', collectionId: f.folder.collectionId });
    expect(commands.some(row=>row.kind==='label-create'&&row.name===NATIVE_FOLDER_DATA)).toBe(true);
  });
  it('refuses a stale local metadata guard before planning writes', async () => {
    const f = fixture(), change = await f.change(f.folder.collectionId, f.folderData(f.folder.collectionId, 'Rename'));
    f.label(f.folder.collectionId, 'Changed after capture', '{}'); await expect(planNearbyNativeMetadata(f.source, randomUUID(), [change])).rejects.toMatchObject({ code: 'native-metadata-stale' });
  });
  it('rejects a move creating a cycle through an existing untouched ancestor', async () => {
    const f = fixture(); f.other.groupId = f.folder.collectionId;
    const data = f.folderData(f.folder.collectionId, 'Work'); data.payload.path = [{ id: f.other.collectionId, title: 'Other', parent: null }, { id: f.folder.collectionId, title: 'Work', parent: f.other.collectionId } as any];
    await expect(planNearbyNativeMetadata(f.source, randomUUID(), [await f.change(f.folder.collectionId, data)])).rejects.toMatchObject({ code: 'native-folder-cycle' });
  });
  it.each(['assets', 'wrong-tag-kind', 'duplicate-record'])('rejects unsupported %s without losing it through an incomplete plan', async problem => {
    const f = fixture(), data: any = f.folderData(f.folder.collectionId, 'Work');
    if (problem === 'assets') data.assets = [{ id: 'a'.repeat(64), file_name: 'x', media_type: 'x', size: 1 }];

    if (problem === 'wrong-tag-kind') data.payload.tags = [{ name: 'x', payload: '{"kind":"future"}', version: 1 }];
    const change = await f.change(f.folder.collectionId, data);
    await expect(planNearbyNativeMetadata(f.source, randomUUID(), problem === 'duplicate-record' ? [change, change] : [change])).rejects.toThrow();
  });
});
