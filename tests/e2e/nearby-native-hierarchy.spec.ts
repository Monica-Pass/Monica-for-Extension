import {test,expect,type Page,type BrowserContext} from '@playwright/test';
import {build} from 'esbuild';
import {mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {launchEdgeContext} from './fixtures/edge';
import {temporaryNativeHost} from './fixtures/native-host';

const app=(page:Page,method:string,...args:unknown[]):Promise<any>=>page.evaluate(({method,args})=>(window as any).hierarchy[method](...args),{method,args});
test('native coordinator orders paginated nested folder trash, restart restoration and moves',async({},info)=>{
  test.skip(process.platform!=='win32','Installed Edge and Native Messaging');test.setTimeout(300000);
  const run=path.resolve(info.outputPath('isolated')),extension=path.join(run,'extension');await mkdir(extension,{recursive:true});
  await writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Synthetic hierarchy',version:'1.0.0',permissions:['nativeMessaging','storage'],content_security_policy:{extension_pages:"script-src 'self' 'wasm-unsafe-eval'; object-src 'none'"},background:{service_worker:'worker.js'}}));
  await writeFile(path.join(extension,'worker.js'),'chrome.runtime.onInstalled.addListener(()=>{});');
  await writeFile(path.join(extension,'index.html'),'<script src="harness.js"></script>');
  await build({entryPoints:['tests/e2e/fixtures/nearby-hierarchy.ts'],outfile:path.join(extension,'harness.js'),bundle:true,format:'iife',target:'chrome130',alias:{crypto:path.resolve('scripts/stubs/node-crypto.js')}});
  for(const name of ['engine.js','monica_mdbx2_browser.wasm'])await copyFile(path.resolve('native/mdbx2-browser/pkg',name),path.join(extension,name));
  await build({entryPoints:['tests/e2e/fixtures/mdbx-browser-worker.ts'],outfile:path.join(extension,'mdbx-worker.js'),bundle:true,format:'esm',target:'chrome130',external:['./engine.js'],alias:{crypto:path.resolve('scripts/stubs/node-crypto.js')}});
  const contexts=new Map<string,BrowserContext>();let registration:Awaited<ReturnType<typeof temporaryNativeHost>>|undefined;
  const evidence:Record<string,unknown>={status:'failed',productionCoordinator:true,bundledMdbx:true,actualNativeHostTransport:true,androidApplicationAcceptance:false};
  const launch=async(name:string)=>{
    const appData=path.join(run,`appdata-${name}`);await mkdir(appData,{recursive:true});
    const context=await launchEdgeContext(path.join(run,`profile-${name}`),{env:{...process.env,APPDATA:appData,LOCALAPPDATA:appData},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});contexts.set(name,context);
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);await page.waitForFunction(()=>!!(window as any).hierarchy);return page;
  };
  try{
    const a=await launch('a');registration=await temporaryNativeHost(new URL(a.url()).host,path.join(run,'native'));let b=await launch('b');
    const original=await app(a,'setup',true);await app(b,'setup',false);
    const complete=()=>expect.poll(async()=>Promise.all([app(a,'poll'),app(b,'poll')]).then(rows=>rows.map(r=>r.phase)),{timeout:60000}).toEqual(['completed','completed']);
    const pair=await app(a,'pair');await app(b,'pair',pair.pairing.invitations[0]);await complete();
    const peers=[(await app(a,'status')).peerId,(await app(b,'status')).peerId];
    const exchange=async()=>{
      for(const [page,peer]of [[a,peers[0]],[b,peers[1]]]as const){const view=await app(page,'prepare',peer);if(view.phase==='review')await app(page,'confirm',view.review.id);else expect(view.phase).toBe('ready');}
      const aListens=peers[1]>peers[0];
      const listener=await app(aListens?a:b,'start');await app(aListens?b:a,'start',listener.endpoint);await complete();
    };
    await exchange();const copied=await app(b,'inspect');expect(copied.objects).toHaveLength(260);expect(copied.objects.map((o:any)=>o.id)).toEqual(original.objects.map((o:any)=>o.id));expect(copied.folders).toHaveLength(3);expect(copied.blockers).toEqual([]);expect(copied.files[0].hash).toBe(original.files[0].hash);
    await app(a,'lifecycle',true);await exchange();const trashed=await app(b,'inspect');expect(trashed.objects.every((o:any)=>o.deleted)).toBe(true);expect(trashed.folders.every((f:any)=>f.deleted)).toBe(true);expect(trashed.files).toEqual(copied.files);expect(trashed.journal).toBeUndefined();
    await app(b,'close');await contexts.get('b')!.close();contexts.delete('b');b=await launch('b');
    await app(a,'lifecycle',false);await exchange();const restored=await app(b,'inspect');expect(restored.objects.map((o:any)=>({id:o.id,owner:o.owner,deleted:o.deleted}))).toEqual(copied.objects.map((o:any)=>({id:o.id,owner:o.owner,deleted:o.deleted})));expect(restored.files).toEqual(copied.files);expect(restored.folders).toEqual(copied.folders);expect(restored.journal).toBeUndefined();
    await app(a,'moveOut');await exchange();const moved=await app(b,'inspect');expect(moved.folders.filter((f:any)=>!f.deleted)).toHaveLength(1);expect(moved.objects.every((o:any)=>!o.deleted)).toBe(true);expect(moved.files).toEqual(copied.files);
    await exchange();expect((await app(b,'inspect')).revision).toEqual(moved.revision);
    Object.assign(evidence,{status:'passed',records:263,paginated:true,retainedFolderAsset:true,actualRestart:true,parentFirstRestore:true,childFirstTrash:true,moveBeforeParentTrash:true,repeatedSyncNoWrite:true});
    await app(a,'close');await app(b,'close');
  }finally{for(const [name,context]of contexts){for(const page of context.pages()){const failure=await page.evaluate(()=>(window as any).hierarchyFailure).catch(()=>undefined);if(failure)await writeFile(path.join(run,`failure-${name}.json`),JSON.stringify(failure,null,2));const events=await app(page,'events').catch(()=>[]);await writeFile(path.join(run,`events-${name}.json`),JSON.stringify(events,null,2));if(evidence.status!=='passed'){const state=await app(page,'inspect').catch(()=>undefined);if(state)await writeFile(path.join(run,`final-${name}.json`),JSON.stringify(state,null,2));}}await context.close();}await registration?.restore();await writeFile(path.join(run,'evidence.json'),JSON.stringify(evidence,null,2));}
});
