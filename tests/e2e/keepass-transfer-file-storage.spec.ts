import { expect, test, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

// Synthetic-origin harness for production file/persistence modules. Not a manager
// UI or cloud-transport acceptance, and never included in the extension bundle.
const harness = `
import { KeePassProvider } from './src/providers/keepass/keepass-provider';
import { KeePassLocalWorkingCopyService } from './src/providers/keepass/keepass-local-working-copy';
import { IndexedDbKeePassWorkingCopyStorage } from './src/providers/keepass/keepass-working-copy-store';
import { createKeePassCacheEncryptionKey } from './src/providers/keepass/keepass-receipt-crypto';
import { buildKeePassFixture } from './src/providers/keepass/keepass-fixture';
import { openKeePassVault } from './src/providers/keepass/keepass-vault';
const password = 'Synthetic KeePass batch persistence only';
const storage = new IndexedDbKeePassWorkingCopyStorage('synthetic-keepass-batch');
const provider = new KeePassProvider();
const service = new KeePassLocalWorkingCopyService(provider, storage);
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
async function account(id,bytes,databaseId) {
  return {id,kind:'keepass',name:id,enabled:true,isDefaultSaveTarget:false,config:{sourceMode:'local-file',databaseId,
    localFileSourceSha256:await digest(bytes),cacheEncryptionKey:createKeePassCacheEncryptionKey()}};
}
export async function first() {
  const projectId=crypto.randomUUID(),groupId=crypto.randomUUID();
  const sourceBytes=await buildKeePassFixture({password,kdf:'argon2id',entries:[0,1].map(n=>({title:'Source '+n,
    protectedFields:{Password:'synthetic source secret '+n,Unknown:'protected future',
      'monica.content.credential':JSON.stringify({version:1,projectId,groupId,passwordId:crypto.randomUUID(),label:'Main',primary:true,groupOrder:0,passwordOrder:n})},
    binaries:{'file.bin':Uint8Array.of(1,3,n,255)}}))});
  const targetBytes=await buildKeePassFixture({password,kdf:'argon2id',entries:[{title:'Existing',protectedFields:{Password:'synthetic target secret'}}]});
  const source=await account('source',sourceBytes,1),target=await account('target',targetBytes,2);
  await provider.unlock(source,sourceBytes,{password,sourceMode:'local-file'});
  await provider.unlock(target,targetBytes,{password,sourceMode:'local-file'});
  const originals=(await provider.sync(source,{now:new Date().toISOString(),localItems:[]})).items;
  await service.initialize(target,targetBytes);
  const request={expectedWorkingSha256:await digest(targetBytes),draft:{operationId:crypto.randomUUID(),createdAt:new Date().toISOString(),
    action:'copy',rows:originals.map(source=>({source}))}};
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){const result=put.apply(this,args);
    if(this.transaction.db.name==='synthetic-keepass-batch' && this.name==='working-copies')result.addEventListener('success',()=>this.transaction.abort(),{once:true});
    return result;};
  let aborted=false;
  try{await service.persistTransfer(target,request);}catch{aborted=true;}finally{IDBObjectStore.prototype.put=put;}
  const before=await storage.read(target.id);
  if(!aborted || before.revision!==1 || await digest(before.workingBytes)!==request.expectedWorkingSha256
    || await storage.readReceipt(target.id,request.draft.operationId))throw new Error('Partial file/receipt survived abort');
  const save=storage.save.bind(storage);
  storage.save=async(...args)=>{await save(...args);throw new Error('Synthetic lost commit response');};
  let lost=false;
  try{await service.persistTransfer(target,request);}catch{lost=true;}finally{storage.save=save;}
  const committed=await storage.read(target.id),receipt=await storage.readReceipt(target.id,request.draft.operationId);
  if(!lost || committed.revision!==2 || !receipt)throw new Error('Lost reply did not leave a complete checkpoint');
  if(JSON.stringify(receipt).includes('synthetic source secret'))throw new Error('Unencrypted receipt');
  if(provider.summarize(target.id).itemCount!==1)throw new Error('Preparation changed live destination');
  if(provider.summarize(source.id).itemCount!==2)throw new Error('Copy changed source');
  return {target,request,projectId,aborted,lost};
}
export async function restart(saved) {
  // No source session exists after this full browser restart.
  const receipt=await service.persistTransfer(saved.target,saved.request);
  if(receipt.result.type!=='batch-transfer' || receipt.result.entries.length!==2)throw new Error('Recovery mapping missing');
  await service.restore(saved.target,{password});
  const rows=(await provider.sync(saved.target,{now:new Date().toISOString(),localItems:[]})).items;
  const copies=rows.filter(row=>row.title.startsWith('Source'));
  if(copies.length!==2 || copies[0].passwordGroupId===saved.projectId || copies[0].passwordGroupId!==copies[1].passwordGroupId)throw new Error('Project rebase failed');
  const current=await storage.read(saved.target.id);
  const opened=await openKeePassVault(current.workingBytes,{password,databaseId:2,providerId:'target'});
  for(const copy of copies){const entry=opened.entriesByUuid.get(copy.keepassEntryUuid),file=entry.binaries.get('file.bin');
    const bytes=new Uint8Array(file.value || file);
    if(bytes.join(',')!=='1,3,'+copy.title.at(-1)+',255')throw new Error('Attachment changed');
    if(entry.fields.get('Unknown').getText()!=='protected future')throw new Error('Unknown protected field changed');}
  await provider.remove(saved.target,copies[0]); await service.persistWorkingCopy(saved.target);
  const later=await storage.read(saved.target.id);
  await service.persistTransfer(saved.target,saved.request);
  const retried=await storage.read(saved.target.id);
  if(retried.revision!==later.revision || retried.workingSha256!==later.workingSha256)throw new Error('Replay overwrote a later change');
  const final=await openKeePassVault(retried.workingBytes,{password,databaseId:2,providerId:'target'});
  return {aborted:saved.aborted,lost:saved.lost,sourceRequiredForRecovery:false,entries:receipt.result.entries.length,
    total:final.items.length,deletedCopies:final.items.filter(row=>row.deletedAt).length,receiptEncrypted:true,attachmentsExact:true,projectRebased:true};
}
`;

test('KeePass batch file and receipt survive actual IndexedDB abort, lost reply, full Edge restart and later deletion', async ({}, info) => {
  test.setTimeout(90_000);
  const bundle = await build({ stdin: { contents: harness, resolveDir: process.cwd(), loader: 'ts' }, bundle: true,
    platform: 'browser', format: 'iife', globalName: 'keePassBatchTest', write: false, logLevel: 'silent',
    alias: { crypto: resolve('scripts/stubs/node-crypto.js') } });
  let context: BrowserContext | undefined;
  const open = async () => {
    context = await launchEdgeContext(info.outputPath('profile'));
    await context.route('https://keepass-batch.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic KeePass persistence</title>' }));
    const page = await context.newPage(); await page.goto('https://keepass-batch.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text }); return page;
  };
  try {
    const page = await open();
    const saved = await page.evaluate(() => (window as any).keePassBatchTest.first());
    await context!.close(); context = undefined;
    const restarted = await open();
    const evidence = await restarted.evaluate(saved => (window as any).keePassBatchTest.restart(saved), saved);
    expect(evidence).toEqual({ aborted: true, lost: true, sourceRequiredForRecovery: false, entries: 2, total: 3,
      deletedCopies: 1, receiptEncrypted: true, attachmentsExact: true, projectRebased: true });
    await info.attach('keepass-file-layer-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } finally { await context?.close(); }
});
