import { test,expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

test('real IndexedDB commits primary and recovery atomically and drops checkpoints on injected quota failure',async({},info)=>{
  const root=info.outputPath('storage-fixture');await mkdir(root,{recursive:true});
  await writeFile(path.join(root,'manifest.json'),JSON.stringify({manifest_version:3,name:'Synthetic storage acceptance',version:'1.0.0',background:{service_worker:'background.js'}}));
  await writeFile(path.join(root,'background.js'),'chrome.runtime.onMessage.addListener(()=>false);');
  await writeFile(path.join(root,'index.html'),'<!doctype html><title>Storage acceptance</title><script src="fixture.js"></script>');
  await build({stdin:{contents:`import {IndexedDbVaultStorage} from './src/security/vault-storage';globalThis.fixtureStorage=new IndexedDbVaultStorage();`,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'iife',platform:'browser',outfile:path.join(root,'fixture.js')});
  const context=await launchEdgeContext(info.outputPath('profile'),{args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`]});
  try {
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const page=await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    const result=await page.evaluate(async()=>{
      const storage=(globalThis as any).fixtureStorage;
      const envelope=(ciphertext:string)=>({version:1,kdf:{name:'DEVICE-KEY',keyId:'synthetic'},cipher:'AES-256-GCM',iv:'synthetic',ciphertext,updatedAt:new Date().toISOString()});
      await storage.write(envelope('AAAA'));await storage.write(envelope('BBBB'));
      const first=(await storage.recoveryCopies()).length;
      const original=IDBObjectStore.prototype.put;
      let inject='quota',attempts=0;
      IDBObjectStore.prototype.put=function(value:any,key?:IDBValidKey):IDBRequest {
        if(key==='primary'&&inject){attempts++;if(inject==='quota'){inject='';throw new DOMException('Synthetic quota failure','QuotaExceededError');}throw new Error('Synthetic primary failure');}
        return original.call(this,value,key!);
      };
      try {
        await storage.write(envelope('CCCC'));
        const afterQuota={primary:(await storage.read()).ciphertext,copies:(await storage.recoveryCopies()).length,attempts};
        inject='other';let rejected=false;
        try {await storage.write(envelope('DDDD'));}catch{rejected=true;}
        const afterFailure={primary:(await storage.read()).ciphertext,copies:(await storage.recoveryCopies()).length,rejected};
        await storage.clear();
        return {first,afterQuota,afterFailure,cleared:await storage.read(),remaining:await storage.recoveryCopies()};
      } finally {IDBObjectStore.prototype.put=original;}
    });
    expect(result).toEqual({first:1,afterQuota:{primary:'CCCC',copies:0,attempts:1},afterFailure:{primary:'CCCC',copies:0,rejected:true},cleared:null,remaining:[]});
  } finally {await context.close();}
});
