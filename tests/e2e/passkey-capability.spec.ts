import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { launchEdgeContext } from './fixtures/edge';
import type { PasskeyItem } from '../../src/core/model';

async function send(page: Page, request: object): Promise<any> {
  const result=await page.evaluate(input=>chrome.runtime.sendMessage(input),request);
  expect(result.ok,result.error).toBe(true);return result.data;
}

test('Passkey list and details distinguish unavailable, original-device and transferable keys without repeated inspection',async ({},info)=>{
  const extension=path.resolve('dist');
  const context=await launchEdgeContext(info.outputPath('profile'),{locale:'zh-CN',colorScheme:'dark',reducedMotion:'reduce',viewport:{width:1180,height:1000},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try {
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      const original=crypto.subtle.importKey.bind(crypto.subtle);
      (window as any).__passkeyImports=0;
      crypto.subtle.importKey=((...args:any[])=>{if(args[0]==='pkcs8')(window as any).__passkeyImports++;return (original as any)(...args);}) as typeof crypto.subtle.importKey;
    });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page,{type:'VAULT_SETUP',masterPassword:''});
    const privateKeyPkcs8=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
    const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
    const base:PasskeyItem={id:'portable',title:'Portable synthetic',kind:'passkey',favorite:false,notes:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),providerRefs:[],credentialId:'AQID',rpId:'example.com',rpName:'Example',userHandle:'dXNlcg',userName:'Synthetic',userDisplayName:'Synthetic',algorithm:-7,publicKey:'',privateKeyPkcs8,signCount:0,discoverable:true,sourceMode:'browser-local'};
    const rows:PasskeyItem[]=[base,
      {...base,id:'device',title:'Device synthetic',credentialId:'BAUG',privateKeyPkcs8:undefined,keyMaterialHint:'device-reference',sourceMode:'android-metadata-only'},
      {...base,id:'missing',title:'Missing synthetic',credentialId:'BwgJ',privateKeyPkcs8:undefined,sourceMode:'android-metadata-only'},
      {...base,id:'broken',title:'Broken synthetic',credentialId:'CgsM',privateKeyPkcs8:'synthetic-invalid-private-key'},
      {...base,id:'limited',title:'Limited synthetic',credentialId:'DQ4P',backupEligible:false,backupState:false,signCount:5},
      {...base,id:'rsa',title:'RSA synthetic',credentialId:'EBES',algorithm:-257,privateKeyPkcs8:rsa},
      {...base,id:'flags',title:'Flags synthetic',credentialId:'ExQV',backupEligible:false,backupState:true}];
    await send(page,{type:'VAULT_IMPORT_ITEMS',items:rows});await page.reload();
    await page.locator('.nav-item').filter({hasText:'Passkey'}).click();
    const row=(name:string)=>page.locator('.item-card').filter({has:page.getByRole('button',{name:`查看${name}详情`,exact:true})});
    for(const [name,label] of [['Portable synthetic','可跨端保存'],['Device synthetic','浏览器不可用'],['Missing synthetic','浏览器不可用'],['Broken synthetic','浏览器不可用'],['Limited synthetic','跨端受限'],['RSA synthetic','跨端受限'],['Flags synthetic','浏览器不可用']]){
      await expect(row(name).locator('.passkey-status-badge').first()).toContainText(label);
    }
    await expect(row('Device synthetic').getByText('仅原设备',{exact:true})).toBeVisible();
    const imports=await page.evaluate(()=>(window as any).__passkeyImports);
    await page.screenshot({path:info.outputPath('passkey-list-dark.png')});
    const detail=page.locator('.passkey-capability-detail');
    for(const [name,reason] of [['Portable synthetic','可经 MDBX、KDBX 或 Bitwarden'],['Device synthetic','从原设备导出包含私钥的加密备份'],['Broken synthetic','私钥损坏'],['Limited synthetic','Android 使用零计数'],['RSA synthetic','仅支持 ES256'],['Flags synthetic','备份标志互相冲突']]){
      await page.getByRole('button',{name:`查看${name}详情`,exact:true}).click();
      await expect(detail).toContainText(reason);
      if(name==='Limited synthetic') {
        await expect(detail).toContainText('注册时标记为不可备份');
        await page.screenshot({path:info.outputPath('passkey-detail-dark.png')});
        await page.emulateMedia({colorScheme:'light'});await page.setViewportSize({width:320,height:850});
        await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
        expect(await detail.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
        await page.screenshot({path:info.outputPath('passkey-detail-320-large-light.png')});
        await page.evaluate(()=>{document.documentElement.style.fontSize='';});await page.setViewportSize({width:1180,height:1000});
      }
      const dom=await page.locator('body').innerHTML();expect(dom).not.toContain(privateKeyPkcs8);expect(dom).not.toContain(rsa);expect(dom).not.toContain('synthetic-invalid-private-key');
      await page.getByRole('button',{name:'关闭详情',exact:true}).click();
    }
    expect(await page.evaluate(()=>(window as any).__passkeyImports)).toBe(imports);
    // Record the actual DOM frames while components remount; import-count alone
    // misses a badge briefly being replaced by a checking label.
    await page.evaluate(()=>{
      (window as any).__checkingFrames=[];
      new MutationObserver(()=>{if([...document.querySelectorAll('.passkey-status-badge')].some(node=>node.textContent?.includes('正在检查')))(window as any).__checkingFrames.push(true);}).observe(document.body,{subtree:true,childList:true,characterData:true});
    });
    // Repeated filtering/remounting and theme updates must reuse the cached key result.
    const search=page.getByRole('searchbox');
    await search.fill('Portable synthetic');await expect(page.locator('.passkey-status-badge')).toHaveCount(1);
    await search.fill('');await expect(page.locator('.passkey-status-badges')).toHaveCount(7);
    expect(await page.evaluate(()=>(window as any).__passkeyImports)).toBe(imports);
    expect(await page.evaluate(()=>(window as any).__checkingFrames)).toEqual([]);
    const saved=await send(page,{type:'VAULT_LIST_ITEMS'}) as PasskeyItem[];
    expect(saved.find(item=>item.title==='Limited synthetic')).toMatchObject({signCount:5,backupEligible:false,backupState:false,privateKeyPkcs8});
    expect(errors).toEqual([]);
  } finally {await context.close();}
});
