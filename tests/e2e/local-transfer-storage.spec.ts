import { test, expect, type BrowserContext } from '@playwright/test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

// Exercise the production vault service and IndexedDB transaction in an isolated
// synthetic origin. This harness is never copied to dist or exposed by runtime APIs.
const harness = `
import { SecureVaultService } from './src/security/secure-vault-service';
import { IndexedDbVaultStorage } from './src/security/vault-storage';
import { MemoryVaultSessionStore } from './src/security/vault-session';
import { createLoginItem } from './src/core/model';
const storage = new IndexedDbVaultStorage();
const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
const password = 'synthetic local transaction acceptance only';
export async function first() {
  const source = createLoginItem({title:'Synthetic source',password:'synthetic saved secret'});
  source.passwordGroupId = '81111111-1111-4111-8111-111111111111';
  source.passwordHistory = [{password:'synthetic prior secret',lastUsedAt:'2026-10-11T00:00:00.000Z'}];
  const sibling = {...source,id:crypto.randomUUID(),password:'synthetic sibling secret'};
  await service.setup(password,[source,sibling]);
  const state = await service.readState();
  const prepared = await service.prepareLocalTransfer({operationId:crypto.randomUUID(),createdAt:new Date().toISOString(),
    itemIds:[source.id],targetProviderId:state.providers[0].id,action:'copy',preserveCategories:false});
  const before = JSON.stringify(await storage.read());
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(...args) {
    const request = originalPut.apply(this,args);
    if(this.name==='vault') request.addEventListener('success',()=>this.transaction.abort(),{once:true});
    return request;
  };
  let aborted = false;
  try { await service.commitLocalTransfer(prepared); } catch { aborted = true; }
  finally { IDBObjectStore.prototype.put = originalPut; }
  if(!aborted || JSON.stringify(await storage.read())!==before) throw new Error('Aborted IndexedDB transaction changed the vault');
  const write = storage.write.bind(storage);
  storage.write = async envelope => { await write(envelope); throw new Error('Synthetic lost reply after commit'); };
  let lostReply = false;
  try { await service.commitLocalTransfer(prepared); } catch { lostReply = true; }
  storage.write = write;
  if(!lostReply) throw new Error('Lost response was not injected');
  const actual = await service.readState();
  if(actual.items.length!==4 || actual.localTransferReceipts.length!==1) throw new Error('Group commit was incomplete');
  const serialized = JSON.stringify(await storage.read());
  if(serialized.includes('synthetic saved secret') || serialized.includes('synthetic prior secret')) throw new Error('Plaintext in vault envelope');
  return {prepared,sourceId:source.id,sourcePassword:source.password};
}
export async function restart(saved) {
  await service.unlock(password);
  const before = await service.readState();
  const targetId = saved.prepared.batch.receipt.entries[0].targetItemId;
  const target = before.items.find(row=>row.id===targetId);
  await service.upsertItem({...target,notes:'edited after restart',deletedAt:new Date().toISOString()});
  const envelope = JSON.stringify(await storage.read());
  const result = await service.commitLocalTransfer(saved.prepared);
  const after = await service.readState();
  return {replayed:result.replayed,untouched:envelope===JSON.stringify(await storage.read()),
    items:after.items.length,receipts:after.localTransferReceipts.length,
    sourcePreserved:after.items.find(row=>row.id===saved.sourceId).password===saved.sourcePassword,
    targetStillDeleted:!!after.items.find(row=>row.id===targetId).deletedAt,
    historyPreserved:target.passwordHistory[0].password==='synthetic prior secret'};
}
`;

test('local transfer survives actual IndexedDB abort, lost reply and Edge restart', async ({}, info) => {
  test.setTimeout(90_000);
  const result = await build({ stdin: { contents: harness, resolveDir: process.cwd(), loader: 'ts' }, bundle: true,
    platform: 'browser', format: 'iife', globalName: 'localTransferTest', write: false, logLevel: 'silent',
    // Same Node-only fallback alias as the production worker build; browser crypto stays real.
    alias: { crypto: resolve('scripts/stubs/node-crypto.js') } });
  const script = result.outputFiles[0].text;
  const profile = info.outputPath('profile');
  let context: BrowserContext | undefined;
  async function open() {
    context = await launchEdgeContext(profile);
    await context.route('https://local-transfer.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Synthetic local storage test</title>' }));
    const page = await context.newPage();
    await page.goto('https://local-transfer.test/');
    await page.addScriptTag({ content: script });
    return page;
  }
  try {
    const page = await open();
    const saved = await page.evaluate(() => (window as any).localTransferTest.first());
    await context!.close(); context = undefined;
    const restarted = await open();
    const evidence = await restarted.evaluate(value => (window as any).localTransferTest.restart(value), saved);
    expect(evidence).toEqual({ replayed: true, untouched: true, items: 4, receipts: 1, sourcePreserved: true, targetStillDeleted: true, historyPreserved: true });
    await info.attach('local-transfer-indexeddb-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } finally { await context?.close(); }
});
