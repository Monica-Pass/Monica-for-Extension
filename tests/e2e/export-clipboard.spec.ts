import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { readFile, writeFile, cp, mkdir, rm } from 'node:fs/promises';
import { launchEdgeContext } from './fixtures/edge';

async function send(page: Page, input: object) {
  return page.evaluate(request => chrome.runtime.sendMessage(request), input);
}
test('fresh export authentication and optional clipboard expiry use production Edge paths', async (_, info) => {
  test.setTimeout(120000);
  // Explicit permission-granted test fixture; production JavaScript is unchanged.
  // The real optional permission bubble remains a manual acceptance item.
  const extension = info.outputPath('permission-granted-extension');
  await mkdir(extension,{recursive:true}); await cp(path.resolve('dist'),extension,{recursive:true});
  const manifestPath=path.join(extension,'manifest.json'); const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  manifest.permissions.push(...manifest.optional_permissions); delete manifest.optional_permissions;
  await writeFile(manifestPath,JSON.stringify(manifest));
  const options = { locale: 'zh-CN', viewport: {width: 1100, height: 900}, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] };
  const context = await launchEdgeContext(info.outputPath('profile'), options);
  let originalClipboard: string | undefined;
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    const page = await context.newPage(); await page.goto(`${origin}/index.html`);
    expect((await send(page, {type: 'VAULT_SETUP', masterPassword: '1234'})).ok).toBe(true);
    const now = new Date().toISOString();
    expect((await send(page, {type: 'VAULT_UPSERT_ITEM', item: {id:'synthetic-export-item',kind:'login',title:'Synthetic export account',username:'synthetic',password:'Synthetic clipboard value',uris:[],customFields:[],notes:'',favorite:false,providerRefs:[],createdAt:now,updatedAt:now}})).ok).toBe(true);
    await page.reload();
    await page.getByRole('button', {name:'设置与备份',exact:true}).click();
    await page.locator('[data-settings-entry="transfer"]').click();
    await page.locator('[data-transfer-export-format]').selectOption('json');
    await page.getByRole('button',{name:'验证身份并导出',exact:true}).click();
    const dialog = page.getByRole('dialog',{name:'验证身份并导出',exact:true});
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('当前主密码',{exact:true}).fill('wrong password');
    await dialog.getByRole('button',{name:'验证并导出',exact:true}).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel('当前主密码',{exact:true})).toHaveValue('');
    await dialog.getByLabel('当前主密码',{exact:true}).fill('1234');
    const downloading = page.waitForEvent('download');
    await dialog.getByRole('button',{name:'验证并导出',exact:true}).click();
    const download = await downloading;
    expect(JSON.parse(await readFile((await download.path())!, 'utf8')).items).toMatchObject([{id:'synthetic-export-item',password:'Synthetic clipboard value'}]);
    expect((await send(page,{type:'VAULT_EXPORT_ENCRYPTED',backupPassword:'5678'})).ok).toBe(false);
    const popup = await context.newPage(); await popup.goto(`${origin}/popup.html`);
    expect((await send(popup,{type:'VAULT_AUTHENTICATED_EXPORT',input:{format:'plaintext',masterPassword:'1234',confirmed:true}})).ok).toBe(false);
    await popup.close();
    expect(await page.evaluate(()=>chrome.permissions.contains({permissions:['clipboardRead','clipboardWrite']}))).toBe(true);
    await page.locator('[data-settings-back]').click();
    await page.locator('[data-settings-entry="protection"]').click();
    await expect(page.getByRole('switch',{name:'自动清理复制的内容',exact:true})).not.toBeChecked();
    await page.getByRole('switch',{name:'自动清理复制的内容',exact:true}).click();
    await expect(page.getByRole('switch',{name:'自动清理复制的内容',exact:true})).toBeChecked();
    await page.bringToFront();
    originalClipboard = await page.evaluate(() => navigator.clipboard.readText());
    // Exercise the actual production detail copy button and shared copy helper.
    await page.locator('.sidebar .nav-item').filter({hasText:'登录项'}).click();
    await page.getByText('Synthetic export account',{exact:true}).click();
    await page.getByRole('button',{name:'复制密码',exact:true}).first().click();
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe('Synthetic clipboard value');
    await expect.poll(()=>worker.evaluate(async()=>(await chrome.storage.session.get('monica.clipboard.pending.v1'))['monica.clipboard.pending.v1'])).toBeTruthy();
    const metadata = await worker.evaluate(() => chrome.storage.session.get('monica.clipboard.pending.v1'));
    expect(JSON.stringify(metadata)).not.toContain('Synthetic clipboard value');
    const probe = await context.newPage(); await probe.goto(`${origin}/index.html`);
    // Closing the copying UI must not cancel the persisted deadline.
    await page.close();
    await worker.evaluate(async () => {
      const key='monica.clipboard.pending.v1';const row=(await chrome.storage.session.get(key))[key];row.expiresAt=Date.now()-1;
      await chrome.storage.session.set({[key]:row});await chrome.alarms.create('monica.clipboard.expiry',{when:Date.now()+100});
    });
    await expect.poll(() => probe.evaluate(() => navigator.clipboard.readText()), {timeout:45000}).toBe('');
    await probe.evaluate(async () => {
      const value='Synthetic old copy';await navigator.clipboard.writeText(value);
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
      await chrome.runtime.sendMessage({type:'CLIPBOARD_ARM',digest});await navigator.clipboard.writeText('Synthetic newer copy');
      const key='monica.clipboard.pending.v1';const row=(await chrome.storage.session.get(key))[key];row.expiresAt=Date.now()-1;await chrome.storage.session.set({[key]:row});await chrome.alarms.create('monica.clipboard.expiry',{when:Date.now()+100});
    });
    await expect.poll(() => worker.evaluate(async () => (await chrome.storage.session.get('monica.clipboard.pending.v1'))['monica.clipboard.pending.v1'])).toBeUndefined();
    expect(await probe.evaluate(() => navigator.clipboard.readText())).toBe('Synthetic newer copy');
    await probe.evaluate(value => navigator.clipboard.writeText(value), originalClipboard); originalClipboard=undefined;
    await probe.screenshot({path:info.outputPath('final-manager.png')});
  } finally {
    if (originalClipboard !== undefined) {
      const page = context.pages().find(page=>page.url().startsWith('chrome-extension://'));
      if (page) await page.evaluate(async original => { const current=await navigator.clipboard.readText();if(current===''||current.startsWith('Synthetic '))await navigator.clipboard.writeText(original); },originalClipboard).catch(()=>undefined);
    }
    await context.close();
    await rm(extension,{recursive:true,force:true});
  }
});

test('encrypted checkpoints survive reopening, require authentication, and diagnostics stay redacted', async (_, info) => {
  const extension=path.resolve('dist');
  const context=await launchEdgeContext(info.outputPath('profile'),{locale:'zh-CN',viewport:{width:1100,height:900},args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try {
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const origin=`chrome-extension://${new URL(worker.url()).host}`;
    const page=await context.newPage();await page.goto(`${origin}/index.html`);
    expect((await send(page,{type:'VAULT_SETUP',masterPassword:'1234'})).ok).toBe(true);
    const now=new Date().toISOString();
    expect((await send(page,{type:'VAULT_UPSERT_ITEM',item:{id:'recovery-synthetic',kind:'login',title:'Private synthetic title',username:'synthetic-private',password:'Never in diagnostics',uris:['https://private.example.test'],customFields:[],notes:'',favorite:false,providerRefs:[],createdAt:now,updatedAt:now}})).ok).toBe(true);
    const before=(await send(page,{type:'VAULT_STORAGE_OVERVIEW'})).data;
    expect(before.copies).toHaveLength(1);
    expect(before.bytes).toBeGreaterThan(0);
    // Read actual IndexedDB records to prove checkpoints contain ciphertext only.
    expect(await page.evaluate(async()=>{
      const database=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('monica-extension-secure-vault',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
      try {return await new Promise<boolean>((resolve,reject)=>{const request=database.transaction('vault').objectStore('vault').get('recovery');request.onsuccess=()=>{const json=JSON.stringify(request.result);resolve(Array.isArray(request.result)&&request.result.length===1&&!json.includes('synthetic-private')&&!json.includes('Never in diagnostics')&&typeof request.result[0].envelope.ciphertext==='string');};request.onerror=()=>reject(request.error);});}
      finally {database.close();}
    })).toBe(true);
    await send(page,{type:'VAULT_LOCK'});await page.reload();
    expect((await send(page,{type:'VAULT_STORAGE_OVERVIEW'})).ok).toBe(false);
    await send(page,{type:'VAULT_UNLOCK',masterPassword:'1234'});
    expect((await send(page,{type:'VAULT_STORAGE_OVERVIEW'})).data.copies[0].id).toBe(before.copies[0].id);
    expect((await send(page,{type:'VAULT_AUTHENTICATED_EXPORT',input:{format:'encrypted',masterPassword:'wrong',backupPassword:'5678',recoveryId:before.copies[0].id,confirmed:true}})).ok).toBe(false);
    expect((await send(page,{type:'VAULT_RECOVERY_CLEAR',confirmed:false})).ok).toBe(false);
    await page.reload();await page.getByRole('button',{name:'设置与备份',exact:true}).click();
    await page.locator('[data-settings-entry="diagnostics"]').click();
    await page.getByRole('button',{name:'检查运行状态',exact:true}).click();
    await expect(page.getByText('页面与后台构建一致。',{exact:true})).toBeVisible();
    const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'下载脱敏诊断',exact:true}).click();
    const diagnostics=await readFile((await (await downloading).path())!,'utf8');
    expect(diagnostics).not.toMatch(/synthetic-private|Never in diagnostics|private\.example|bindingId|localAppData|password/);
    expect(JSON.parse(diagnostics).background.compatible).toBe(true);
    await page.setViewportSize({width:360,height:850});
    const closeNavigation=page.getByRole('button',{name:'关闭导航',exact:true});
    if (await closeNavigation.isVisible()) await closeNavigation.click();
    await expect(page.locator('.navigation-scrim')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath('diagnostics-mobile.png'),fullPage:true,animations:'disabled'});
    await page.locator('[data-settings-back]').click();await page.locator('[data-settings-entry="backup"]').click();
    await expect(page.getByText('容量与本机恢复副本',{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('recovery-mobile.png'),fullPage:true,animations:'disabled'});
    expect((await send(page,{type:'VAULT_RECOVERY_CLEAR',confirmed:true})).ok).toBe(true);
    expect((await send(page,{type:'VAULT_STORAGE_OVERVIEW'})).data.copies).toHaveLength(0);
    // Changing protection invalidates history rather than retaining old-key copies.
    await send(page,{type:'VAULT_UPSERT_ITEM',item:{id:'second',kind:'note',title:'Synthetic',content:'fixture',notes:'',favorite:false,providerRefs:[],customFields:[],createdAt:now,updatedAt:now}});
    expect((await send(page,{type:'VAULT_CHANGE_MASTER_PASSWORD',currentPassword:'1234',newPassword:'5678'})).ok).toBe(true);
    expect((await send(page,{type:'VAULT_STORAGE_OVERVIEW'})).data.copies).toHaveLength(0);
  } finally {await context.close();}
});
