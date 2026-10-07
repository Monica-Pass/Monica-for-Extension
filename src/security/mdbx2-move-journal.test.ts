import { expect, it } from "vitest";
import { createLoginItem, type ProviderAccount } from "../core/model";
import { readMdbx2MoveJournal, type Mdbx2MoveFinalizationRecord } from "../core/mdbx2-move-journal";
import { SecureVaultService } from "./secure-vault-service";
import { MemoryVaultStorage } from "./vault-storage";
import { MemoryVaultSessionStore } from "./vault-session";
import type { VaultEnvelope } from "./vault-crypto";

class FailableStorage extends MemoryVaultStorage {
  failNext = false;
  override async write(envelope: VaultEnvelope) {
    if (this.failNext) { this.failNext=false; throw new Error("Synthetic interrupted persistence"); }
    await super.write(envelope);
  }
}
const password='move journal synthetic password';
async function setup() {
  const storage=new FailableStorage(), service=new SecureVaultService(storage,new MemoryVaultSessionStore());
  await service.setup(password);
  const target:ProviderAccount={id:'target',kind:'mdbx2',name:'Target',enabled:true,isDefaultSaveTarget:false,config:{}};
  await service.upsertProvider(target);
  const expected=await service.upsertItem(createLoginItem({title:'Synthetic journal secret title',password:'Synthetic journal secret value'}));
  const record:Mdbx2MoveFinalizationRecord={version:1,id:'group',operationId:crypto.randomUUID(),requestHash:'ab'.repeat(32),sourceProviderId:'source',targetProviderId:target.id,
    sourceVaultId:'source-native-vault',targetVaultId:'target-native-vault',createdAt:'2026-10-01T00:00:00Z',status:'prepared',
    entries:[{expected,result:{...expected,providerRefs:[{providerId:target.id,remoteId:'target-object',revision:'target-commit'}]},action:'move'}]};
  return {storage,service,record};
}

it('persists encrypted recovery before deletion and completes after a new service unlocks', async()=>{
  const {storage,service,record}=await setup();
  await service.stageMdbx2MoveFinalization(record);
  expect(JSON.stringify(storage.envelope)).not.toContain(record.entries[0].expected.title);
  expect(JSON.stringify(storage.envelope)).not.toContain('Synthetic journal secret value');
  let deletionCommitted=false;
  storage.failNext=true;
  await expect(service.applyCompletedMdbx2Transfer(record.entries,record.targetProviderId,async()=>{deletionCommitted=true;},record.id)).rejects.toThrow('interrupted');
  expect(deletionCommitted).toBe(true);
  const restarted=new SecureVaultService(storage,new MemoryVaultSessionStore());
  await expect(restarted.readMdbx2MoveFinalizations()).rejects.toThrow();
  await restarted.unlock(password);
  const [pending]=await restarted.readMdbx2MoveFinalizations(record.operationId);
  expect(pending).toEqual(record);
  expect(await restarted.getItem(record.entries[0].expected.id)).toEqual(record.entries[0].expected);
  let recoveryCalls=0;
  const recover=async()=>{expect(deletionCommitted).toBe(true);recoveryCalls++;};
  await restarted.applyCompletedMdbx2Transfer(pending.entries,pending.targetProviderId,recover,pending.id);
  expect((await restarted.readMdbx2MoveFinalizations())[0].status).toBe('completed');
  expect(await restarted.getItem(record.entries[0].result.id)).toEqual(record.entries[0].result);
  await restarted.applyCompletedMdbx2Transfer(pending.entries,pending.targetProviderId,recover,pending.id);
  expect(recoveryCalls).toBe(1);
});

it('does not stage stale snapshots, overwrite an operation, or finalize different entries', async()=>{
  const {service,record}=await setup();
  await service.stageMdbx2MoveFinalization(record);
  await service.stageMdbx2MoveFinalization(record);
  await expect(service.stageMdbx2MoveFinalization({...record,id:'overlapping-group',operationId:crypto.randomUUID()})).rejects.toThrow('未完成');
  await expect(service.stageMdbx2MoveFinalization({...record,targetVaultId:'another-vault'})).rejects.toThrow('不一致');
  let removed=false;
  const altered=structuredClone(record.entries);altered[0].result.title='Rebound target';
  await expect(service.applyCompletedMdbx2Transfer(altered,record.targetProviderId,async()=>{removed=true;},record.id)).rejects.toThrow('不一致');
  expect(removed).toBe(false);
  await service.upsertItem({...record.entries[0].expected,notes:'Changed'});
  await expect(service.stageMdbx2MoveFinalization({...record,id:'another-group'})).rejects.toThrow('发生变化');
  expect(await service.readMdbx2MoveFinalizations()).toHaveLength(1);
});

it('does not acknowledge staging when durable storage fails', async()=>{
  const {storage,service,record}=await setup();storage.failNext=true;
  await expect(service.stageMdbx2MoveFinalization(record)).rejects.toThrow('interrupted');
  expect(await service.readMdbx2MoveFinalizations()).toEqual([]);
});

it('rejects damaged or future recovery data without discarding it',()=>{
  const future=[{version:2,status:'prepared'}];
  expect(()=>readMdbx2MoveJournal(future)).toThrow('恢复记录');
  expect(future).toEqual([{version:2,status:'prepared'}]);
  expect(readMdbx2MoveJournal(undefined)).toEqual([]);
});

it('preserves attachment proofs and rejects malformed or wrongly bound proofs', async()=>{
  const {record}=await setup();
  const proof={itemId:record.entries[0].result.id,attachmentId:'attachment',fileName:'synthetic.bin',sizeBytes:3,sha256:'ab'.repeat(32)};
  expect(readMdbx2MoveJournal([{...record,attachments:[proof]}])[0].attachments).toEqual([proof]);
  expect(readMdbx2MoveJournal([record])[0].attachments).toBeUndefined();
  for(const change of [{itemId:'other'},{sizeBytes:-1},{sha256:'invalid'}]) {
    expect(()=>readMdbx2MoveJournal([{...record,attachments:[{...proof,...change}]}])).toThrow('恢复记录');
  }
  expect(()=>readMdbx2MoveJournal([{...record,attachments:[proof,proof]}])).toThrow('恢复记录');
});

it('preserves the original request for restart UI and rejects malformed selections', async()=>{
  const {record}=await setup();
  const request={itemIds:['selected','independent'],action:'move' as const,preserveCategories:true};
  expect(readMdbx2MoveJournal([{...record,request}])[0].request).toEqual(request);
  for(const change of [{itemIds:[]},{itemIds:['duplicate','duplicate']},{preserveCategories:'yes'},{action:'delete'}]) {
    expect(()=>readMdbx2MoveJournal([{...record,request:{...request,...change}}])).toThrow('恢复记录');
  }
});

function writingRecord(record: Mdbx2MoveFinalizationRecord): Mdbx2MoveFinalizationRecord {
  const item = { ...record.entries[0].expected, providerRefs: [], mdbxFolderId: 'destination-folder' };
  return { ...record, status: 'writing', request: { itemIds: [item.id], action: 'move', preserveCategories: false },
    entries: [{ expected: record.entries[0].expected, result: item, action: 'move' }],
    writeIntent: { operationScope: 'cd'.repeat(32), entries: [{ item,
      originalPayloadJson: '{"unknown_integer":9223372036854775807,"unknown_decimal":1.000000000000000001}',
      payloadPatchJson: '{"bound_note_room_id":null}' }] } };
}

it('keeps exact pre-write payloads across restart and atomically promotes before adoption', async()=>{
  const { storage, service, record } = await setup();
  const writing = writingRecord(record);
  await service.stageMdbx2MoveFinalization(writing);
  await service.stageMdbx2MoveFinalization(writing);
  const resumed = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await resumed.unlock(password);
  expect(await resumed.readMdbx2MoveFinalizations()).toEqual([writing]);
  expect(JSON.stringify(storage.envelope)).not.toContain('unknown_integer');
  const prepared = { ...writing, status: 'prepared' as const, attachments: [], entries: record.entries };
  // Ordinary staging cannot accidentally skip the explicit phase transition.
  await expect(resumed.stageMdbx2MoveFinalization(prepared)).rejects.toThrow('不一致');
  let deletionCalls = 0;
  await expect(resumed.applyCompletedMdbx2Transfer(writing.entries, writing.targetProviderId,
    async()=>{ deletionCalls++; }, writing.id)).rejects.toThrow('不一致');
  expect(deletionCalls).toBe(0);
  storage.failNext = true;
  await expect(resumed.prepareMdbx2MoveFinalization(prepared)).rejects.toThrow('interrupted');
  expect(await resumed.readMdbx2MoveFinalizations()).toEqual([writing]);
  const restarted = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await restarted.unlock(password);
  expect(await restarted.readMdbx2MoveFinalizations()).toEqual([writing]);
  await restarted.prepareMdbx2MoveFinalization(prepared);
  await restarted.prepareMdbx2MoveFinalization(prepared);
  await restarted.applyCompletedMdbx2Transfer(prepared.entries, prepared.targetProviderId,
    async()=>{ deletionCalls++; }, prepared.id);
  expect(deletionCalls).toBe(1);
  await restarted.prepareMdbx2MoveFinalization(prepared);
  expect((await restarted.readMdbx2MoveFinalizations())[0].status).toBe('completed');
});

it('protects pending write intent against overlapping operations, changed intent and stale local edits', async()=>{
  const { service, record } = await setup();
  const writing = writingRecord(record);
  await service.stageMdbx2MoveFinalization(writing);
  await expect(service.stageMdbx2MoveFinalization({ ...record, id: 'other' })).rejects.toThrow('未完成');
  const prepared = { ...writing, status: 'prepared' as const, attachments: [], entries: record.entries };
  for (const change of [ { targetVaultId: 'replaced-vault' }, { requestHash: 'ef'.repeat(32) },
    { writeIntent: { ...writing.writeIntent!, operationScope: 'ab'.repeat(32) } },
    { entries: [{ ...record.entries[0], expected: { ...record.entries[0].expected, notes: 'changed source' } }] } ]) {
    await expect(service.prepareMdbx2MoveFinalization({ ...prepared, ...change })).rejects.toThrow('不一致');
  }
  await service.upsertItem({ ...record.entries[0].expected, notes: 'later local edit' });
  await expect(service.prepareMdbx2MoveFinalization(prepared)).rejects.toThrow('发生变化');
  expect(await service.readMdbx2MoveFinalizations()).toEqual([writing]);
});

it('rejects incomplete pre-write data without modifying the original record', async()=>{
  const { record } = await setup();
  const writing = writingRecord(record);
  for (const change of [{ writeIntent: undefined }, { request: undefined },
    { writeIntent: { ...writing.writeIntent!, entries: [] } },
    { writeIntent: { ...writing.writeIntent!, operationScope: 'wrong' } },
    { writeIntent: { ...writing.writeIntent!, entries: [{ item: writing.entries[0].result, originalPayloadJson: '[]' }] } },
    { writeIntent: { ...writing.writeIntent!, entries: [{ item: { ...writing.entries[0].result, title: 'changed target' } }] } }]) {
    expect(()=>readMdbx2MoveJournal([{ ...writing, ...change }])).toThrow('恢复记录');
  }
  expect(readMdbx2MoveJournal([writing])).toEqual([writing]);
});
