import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createLoginItem} from '../../src/core/model';
import {Mdbx2NativeClient} from '../../src/providers/mdbx2/native-client';
import {decodeMdbx2Object,encodeMdbx2Object} from '../../src/providers/mdbx2/mdbx2-item-codec';
import {ProcessNativeRuntime} from './mdbx2-interop-support';
const source=process.env.MONICA_315_SSO_SOURCE,output=process.env.MONICA_315_SSO_OUTPUT;
it.skipIf(!source||!output)('persists SSO metadata and explicit unlink through real Native restart',async()=>{
  if(!source||!output)throw new Error('Explicit synthetic fixture required');
  await mkdir(output,{recursive:true});
  const host=await mkdtemp(join(output,'host-'));
  const connect=()=>new Mdbx2NativeClient(new ProcessNativeRuntime(resolve('native/mdbx2-host/target/debug/monica-mdbx2-host.exe'),host));
  let client=connect();
  try {
    const bytes=await readFile(source),sha256=createHash('sha256').update(bytes).digest('hex');
    const transfer=await client.beginInboundTransfer(bytes.length,sha256);
    for(let offset=0;offset<bytes.length;)offset=(await client.sendInboundChunk(transfer.transferId,offset,bytes.subarray(offset,offset+transfer.maxChunkBytes))).nextOffset;
    const credential={method:'password' as const,password:'Synthetic transfer fixture password'};
    const opened=await client.openVault({kind:'file',handle:(await client.finishInboundTransfer(transfer.transferId)).fileHandle},credential);
    const item={...createLoginItem({title:'Synthetic SSO metadata'}),loginType:'SSO' as const,ssoProvider:'GOOGLE',ssoRefEntryId:42,ssoRefLogicalId:'password:synthetic-account'};
    const written=await client.upsertObject(opened.vaultHandle,randomUUID(),encodeMdbx2Object(item)!);
    await client.lockVault(opened.vaultHandle);client.close();client=connect();
    await client.openVault({kind:'vault',handle:opened.vaultHandle},credential);
    const record=await client.revealObject(opened.vaultHandle,written.objectId);
    const payload=JSON.parse(record.payloadJson);
    expect(payload).toMatchObject({sso_provider:'GOOGLE',sso_ref_entry_id:42});
    const original=decodeMdbx2Object(record,{headCommitId:written.commitId,updatedAt:item.updatedAt},'synthetic').item;
    if(original?.kind!=='login')throw new Error('Expected login');
    expect(original).toMatchObject({ssoProvider:'GOOGLE',ssoRefEntryId:42,ssoRefLogicalId:'password:synthetic-account'});
    await client.upsertObject(opened.vaultHandle,randomUUID(),encodeMdbx2Object({...original,ssoProvider:'GITHUB',ssoRefEntryId:undefined},payload,original)!);
    await client.lockVault(opened.vaultHandle);client.close();client=connect();
    await client.openVault({kind:'vault',handle:opened.vaultHandle},credential);
    expect(JSON.parse((await client.revealObject(opened.vaultHandle,written.objectId)).payloadJson)).toMatchObject({sso_provider:'GITHUB',sso_ref_entry_id:null});
    await client.lockVault(opened.vaultHandle);
    await writeFile(join(output,'evidence.json'),JSON.stringify({status:'passed',inputSha256:sha256,objectId:written.objectId,restarts:2,providerAndReferencePersisted:true,explicitUnlinkPersisted:true,limitation:'Metadata persistence only; numeric reference is synthetic and does not prove Android relation reconstruction.'},null,2));
  }finally{client.close();}
});
