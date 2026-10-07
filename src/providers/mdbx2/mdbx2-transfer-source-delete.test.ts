import { expect, it, vi } from "vitest";
import { createLoginItem, type ProviderAccount } from "../../core/model";
import { deleteMdbx2TransferSources } from "./mdbx2-transfer-source-delete";
import type { Mdbx2NativeClient } from "./native-client";

const source:ProviderAccount={id:'source',kind:'mdbx2',name:'Source',enabled:true,isDefaultSaveTarget:false,config:{vaultHandle:'source-handle'}};
const item={...createLoginItem({title:'Synthetic'}),providerRefs:[{providerId:source.id,remoteId:'object',revision:'revision'}]};
const operationId='11111111-1111-4111-8111-111111111111';
function client(){return {mutateObjects:vi.fn<Mdbx2NativeClient['mutateObjects']>(),resolveObjectOperation:vi.fn<Mdbx2NativeClient['resolveObjectOperation']>()};}

it('rejects same-vault deletion, mixed sources, duplicate native IDs and oversized groups before IO', async()=>{
  const native=client();
  await expect(deleteMdbx2TransferSources(native,source,[item],operationId,source.id)).rejects.toThrow();
  await expect(deleteMdbx2TransferSources(native,source,[{...item,providerRefs:[...item.providerRefs,{providerId:'other'}]}],operationId,'target')).rejects.toThrow();
  await expect(deleteMdbx2TransferSources(native,source,[item,{...item,id:'other-local-id'}],operationId,'target')).rejects.toThrow();
  await expect(deleteMdbx2TransferSources(native,source,Array(51).fill(item),operationId,'target')).rejects.toThrow();
  expect(native.mutateObjects).not.toHaveBeenCalled();
});

it('does not retry a conflict without a committed receipt', async()=>{
  const native=client();native.mutateObjects.mockRejectedValue(new Error('revision conflict'));
  native.resolveObjectOperation.mockResolvedValue({known:false,committed:false});
  await expect(deleteMdbx2TransferSources(native,source,[item],operationId,'target')).rejects.toThrow('revision conflict');
  expect(native.mutateObjects).toHaveBeenCalledTimes(1);
});

it('rejects a mismatched recovery receipt or a response for another object', async()=>{
  const native=client();native.mutateObjects.mockRejectedValueOnce(new Error('lost'));
  native.resolveObjectOperation.mockResolvedValue({known:true,committed:true,operationId,commitId:'expected-commit'});
  native.mutateObjects.mockResolvedValue({changed:true,operationId,commitId:'wrong-commit',items:[]});
  await expect(deleteMdbx2TransferSources(native,source,[item],operationId,'target')).rejects.toThrow('响应');
  native.mutateObjects.mockResolvedValue({changed:true,operationId,commitId:'commit',items:[{kind:'delete',changed:true,logicalObjectId:'native:object',objectId:'other'}]});
  await expect(deleteMdbx2TransferSources(native,source,[item],operationId,'target')).rejects.toThrow('响应');
});
