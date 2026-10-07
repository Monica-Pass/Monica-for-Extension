import { expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type ProviderAccount } from '../core/model';
import { Mdbx2RestoreBatchCoordinator } from '../providers/mdbx2/mdbx2-restore-batch';
import { mdbx2ItemFingerprint } from '../providers/mdbx2/mdbx2-provider';
import type { Mdbx2NativeClient } from '../providers/mdbx2/native-client';
import { projectRestoreRequest } from '../manager/project-restore';
import { readMdbx2DeletionCancellations } from '../core/mdbx2-deletion-cancellation';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';
import type { VaultEnvelope } from './vault-crypto';

class FailableStorage extends MemoryVaultStorage {
  failNext=false;
  override async write(envelope:VaultEnvelope){if(this.failNext){this.failNext=false;throw new Error('Synthetic persistence failure');}return super.write(envelope);}
}
const password='Synthetic cancellation envelope password';
async function fixture(mode:'existing'|'new'|'mixed'='existing') {
  const storage=new FailableStorage(),service=new SecureVaultService(storage,new MemoryVaultSessionStore());
  const provider:ProviderAccount={id:'native',kind:'mdbx2',name:'Native',enabled:true,isDefaultSaveTarget:false,config:{vaultHandle:'handle',nativeVaultId:'vault'}};
  const rows:LoginItem[]=[0,1,2].map(index=>{
    const row:LoginItem={...createLoginItem({title:'Rich project',username:'account',password:`private-${index}`}),passwordGroupId:'project',
      customFields:[{name:'Exact',value:' 000123\r\n9007199254740993 ',protected:true}],
      providerRefs:[mode==='new'||mode==='mixed'&&index===2?{providerId:'native'}:{providerId:'native',remoteId:`object-${index}`,remoteFolderId:'folder',revision:'head'}]};
    if(row.providerRefs[0].remoteId)row.providerRefs[0].etag=mdbx2ItemFingerprint(row);
    return row;
  });
  await service.setup(password,rows);await service.upsertProvider(provider);
  await service.deletePasswordGroup(rows[0].id,Object.fromEntries(rows.map(row=>[row.id,row.updatedAt])));
  const deleted=await service.listDeletedItems() as LoginItem[];
  const request=projectRestoreRequest(deleted,rows[0].id);
  return {service,storage,provider,rows,deleted,request};
}

it('saves all restored snapshots and terminal receipt atomically across failed persistence and restart',async()=>{
  const f=await fixture(),verify=vi.fn(async()=>undefined),before=await f.service.readState();
  f.storage.failNext=true;
  await expect(f.service.cancelPendingMdbx2ProjectDeletion(f.request,f.deleted,f.provider,verify)).rejects.toThrow('persistence');
  expect(await f.service.readState()).toEqual(before);
  const restarted=new SecureVaultService(f.storage,new MemoryVaultSessionStore());await restarted.unlock(password);
  const restored=await restarted.cancelPendingMdbx2ProjectDeletion(f.request,f.deleted,f.provider,verify);
  expect(restored).toHaveLength(3);
  for(const row of restored){const old=f.rows.find(old=>old.id===row.id)!;expect({...row,updatedAt:old.updatedAt}).toEqual(old);}
  expect((await restarted.readState()).mutationQueue).toEqual([]);
  expect((await restarted.readMdbx2DeletionCancellations())[0].request).toEqual(f.request);
  expect(JSON.stringify(f.storage.envelope)).not.toContain('private-');
  await restarted.deleteItem(restored[0].id);const after=await restarted.readState();
  const replay=await restarted.cancelPendingMdbx2ProjectDeletion(f.request,f.deleted,f.provider,verify);
  expect(replay.find(row=>row.id===restored[0].id)?.deletedAt).toBeDefined();
  expect(await restarted.readState()).toEqual(after);expect(verify).toHaveBeenCalledTimes(2);
  await expect(restarted.replayMdbx2DeletionCancellation(f.request.operationId,{...f.request,deletedAt:'2026-01-01T00:00:00Z'})).rejects.toThrow('原请求');
});

it.each(['new','mixed'] as const)('requeues only unpublished members and preserves originals: %s',async mode=>{
  const f=await fixture(mode);
  const restored=await f.service.cancelPendingMdbx2ProjectDeletion(f.request,f.deleted,f.provider,async()=>undefined);
  const mutations=(await f.service.readState()).mutationQueue;
  expect(mutations).toHaveLength(mode==='new'?3:1);
  expect(mutations.every(row=>row.operation==='create')).toBe(true);
  expect(restored.every(row=>!row.deletedAt)).toBe(true);
  expect(restored.map(row=>row.kind==='login'?row.customFields:undefined)).toEqual(f.deleted.map(row=>row.customFields));
});

it('retains unsynchronized edits by recreating update intent when cancelling deletion',async()=>{
  const f=await fixture();
  const edited=await f.service.upsertItem({...f.deleted[1],notes:'  dirty before delete\r\n0007 '});
  await f.service.deleteItem(edited.id);
  // Re-establish one explicit cohort after the synthetic edit.
  for(const row of await f.service.listDeletedItems())await f.service.upsertItem({...row,deletedAt:undefined});
  const active=await f.service.listItems();
  await f.service.deletePasswordGroup(active[0].id,Object.fromEntries(active.map(row=>[row.id,row.updatedAt])));
  const deleted=await f.service.listDeletedItems() as LoginItem[],request=projectRestoreRequest(deleted,deleted[0].id);
  await f.service.cancelPendingMdbx2ProjectDeletion(request,deleted,f.provider,async()=>undefined);
  const state=await f.service.readState();
  expect(state.mutationQueue).toMatchObject([{itemId:edited.id,operation:'update'}]);
  expect(state.items.find(row=>row.id===edited.id)?.notes).toBe('  dirty before delete\r\n0007 ');
});

it.each(['member','provider','extra-member','missing-member','remote-failure'] as const)('keeps every deletion when %s prevents complete cancellation',async mode=>{
  const f=await fixture();
  if(mode==='member')await f.service.deleteItem(f.deleted[2].id);
  if(mode==='provider')await f.service.upsertProvider({...f.provider,config:{vaultHandle:'other'}});
  if(mode==='extra-member')await f.service.upsertItem({...f.deleted[0],id:crypto.randomUUID(),deletedAt:undefined});
  if(mode==='missing-member')f.deleted.pop();
  const before=await f.service.readState(),verify=vi.fn(async()=>{if(mode==='remote-failure')throw new Error('Remote changed');});
  await expect(f.service.cancelPendingMdbx2ProjectDeletion(f.request,f.deleted,f.provider,verify)).rejects.toThrow();
  expect(await f.service.readState()).toEqual(before);
  if(mode!=='remote-failure')expect(verify).not.toHaveBeenCalled();
});

it('restores entirely unpublished groups offline and replays without any Native calls',async()=>{
  const f=await fixture('new');
  const coordinator=new Mdbx2RestoreBatchCoordinator({} as Mdbx2NativeClient,f.service);
  expect(await coordinator.restoreProject(f.request.anchorItemId,f.request)).toHaveLength(3);
  const before=await f.service.readState();
  expect(await coordinator.resume(f.request.operationId)).toHaveLength(3);
  expect(await f.service.readState()).toEqual(before);
});

it('retains the entire cohort when its original directory is no longer active',async()=>{
  const f=await fixture(),before=await f.service.readState();
  const client={vaultStatus:async()=>({vaultHandle:'handle',vaultId:'vault',open:true,available:true}),
    readWriteRevision:async()=>({vaultId:'vault',revisionSha256:'a'.repeat(64)}),
    listCollections:async()=>({items:[]}),listObjects:vi.fn(async()=>({items:[]})),restoreObjects:vi.fn()} as unknown as Mdbx2NativeClient;
  await expect(new Mdbx2RestoreBatchCoordinator(client,f.service).restoreProject(f.request.anchorItemId,f.request)).rejects.toThrow('原目录');
  expect(await f.service.readState()).toEqual(before);expect(client.restoreObjects).not.toHaveBeenCalled();
  expect(vi.mocked(client.listObjects).mock.calls.every(call=>call[2]?.deleted===true)).toBe(true);
});

it('rejects duplicate and malformed cancellation receipts without discarding input',()=>{
  const request={operationId:'undo',providerId:'native',anchorItemId:'a',deletedAt:'2026-10-05T00:00:00Z',expected:{a:'2026-10-05T00:00:00Z'}};
  const receipt={version:1,request,title:'Private project',completedAt:'2026-10-05T01:00:00Z'};
  expect(readMdbx2DeletionCancellations(undefined)).toEqual([]);
  expect(()=>readMdbx2DeletionCancellations([receipt,receipt])).toThrow();
  expect(()=>readMdbx2DeletionCancellations([{...receipt,version:2}])).toThrow();
  expect(()=>readMdbx2DeletionCancellations([{...receipt,request:{...request,expected:{}}}])).toThrow();
});
