import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { saveStandaloneMdbxDownload } from './interop-mdbx-download.mjs';
import { chooseOption, loginEditor, save, readItem } from './interop-315-edge-features.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const endpoint=item=>item.customFields.find(field=>field.name==='monica_api_key_url')?.value||'';
// The same snapshot is persisted as JSON for the Android return leg. Omit only
// undefined properties; explicit empty text and null remain distinct values.
const snapshot=item=>Object.fromEntries(Object.entries({title:item.title,username:item.username,password:item.password,loginType:item.loginType,notes:item.notes,uris:item.uris,
  appName:item.appName,appPackageName:item.appPackageName,email:item.email,customFields:item.customFields}).filter(([,value])=>value!==undefined));

export async function runApiAddressUi({page,evidence,screenshot,output,returned=false}) {
  assert.ok(process.env.MONICA_315_APP_FIXTURE,'An explicit Android API address fixture is required');
  const root=resolve(process.env.MONICA_315_APP_FIXTURE);
  const stage=returned?'api-address-import':'api-address-export';
  const app=JSON.parse(await readFile(join(root,`${stage}-evidence.json`),'utf8'));
  assert.equal(app.status,'passed');
  const build=JSON.parse(await readFile(join(root,'build-evidence.json'),'utf8'));
  assert.equal(build.status,'passed');
  assert.equal(app.installedTestApkSha256,build.builtTestApkSha256);
  assert.equal(app.installedApkSha256,build.installedApkSha256);
  assert.deepEqual(app.testSourceHashes,build.testSourceHashes);
  assert.equal(app.testSet,'api-address');
  assert.equal(build.testSet,'api-address');
  assert.deepEqual(app.targetedAndroidTestSources,build.targetedAndroidTestSources);
  assert.deepEqual(app.baseline,build.after,'Android sources must match the accepted test build');
  for(const report of [build,app]) for(const invariant of ['androidSourcesUnchanged','testSourcesUnchanged','installedApplicationUnchanged','installedTestApkUnchanged','deviceBootUnchanged']) assert.equal(report[invariant],true,`${report.stage}: ${invariant}`);
  const filename=returned?'android-api-address-return.mdbx':'android-api-address.mdbx';
  const input=join(root,filename);
  assert.equal(hash(await readFile(input)),app.outputs.find(file=>file.name===filename).sha256);
  const name=returned?'Android API 返回验证':'Android API 地址验证';
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  await page.locator('m3e-list-action').filter({hasText:'连接 MDBX2 保险库'}).click();
  const source=page.getByRole('dialog',{name:/MDBX2/});
  await source.getByLabel('显示名称',{exact:true}).fill(name);
  await source.getByLabel('MDBX2 可移植备份',{exact:true}).setInputFiles(input);
  await source.getByLabel('保险库密码（可留空）',{exact:true}).fill('Synthetic transfer fixture password');
  await source.getByRole('button',{name:'验证、解锁并导入',exact:true}).click();
  await source.waitFor({state:'hidden',timeout:60000});
  const card=page.locator('[data-home-provider-id]').filter({has:page.getByRole('heading',{name,exact:true})});
  const providerId=await card.getAttribute('data-home-provider-id');assert.ok(providerId);
  const flush=async()=>{
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    await card.getByRole('button',{name:/^(立即同步|重试同步|写入本机副本)$/}).click();
    await expect(card.getByRole('button',{name:'取消同步',exact:true})).toHaveCount(0,{timeout:60000});
    await expect(card.locator('.form-error')).toHaveCount(0);
    await page.getByRole('button',{name:/^全部项目/}).click();
  };
  const items=async()=>{
    const reply=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(reply.ok,true);
    return Promise.all(reply.data.filter(item=>item.providerRefs.some(ref=>ref.providerId===providerId)).map(item=>readItem(page,item.id)));
  };
  const edit=async title=>{
    await page.getByLabel('搜索密码库',{exact:true}).click();
    await page.getByLabel('搜索密码库',{exact:true}).fill(title);
    await expect(page.getByLabel('搜索密码库',{exact:true})).toHaveValue(title);
    await page.getByLabel(`查看${title}详情`,{exact:true}).click();
    const detail=page.locator('[role="dialog"][data-item-kind="login"]');
    await expect(detail.locator('a[href^="javascript:"]')).toHaveCount(0);
    await detail.getByRole('button',{name:'编辑',exact:true}).click();
    return loginEditor(page);
  };
  await flush();
  const before=await items();
  if(returned){
    const prepared=JSON.parse(await readFile(join(root,'edge-api-address-expected.json'),'utf8'));
    assert.equal(before.length,prepared.length);
    for(const expected of prepared){
      const actual=before.find(item=>item.title===expected.title);assert.ok(actual,expected.title);
      if(expected.title==='API address service'){
        assert.equal(endpoint(actual),'staging service: returned');
        for(const key of ['username','password','loginType','notes','appName','appPackageName','email']) assert.equal(actual[key],expected[key]);
        assert.deepEqual(actual.uris,expected.uris);
        for(const field of expected.customFields.filter(field=>!field.name.startsWith('monica_api_key_'))) assert.ok(actual.customFields.some(value=>value.name===field.name&&value.value===field.value&&value.protected===field.protected));
      }else assert.deepEqual(snapshot(actual),expected);
    }
    let editor=await edit('API address service');
    await page.setViewportSize({width:320,height:900});
    await editor.getByLabel('API 地址',{exact:true}).scrollIntoViewIfNeeded();
    await expect(editor.getByLabel('API 地址',{exact:true})).toHaveValue('staging service: returned');
    await screenshot(page,'api-address-android-return-320.png');
    await editor.getByRole('button',{name:'取消',exact:true}).click();
    await editor.waitFor({state:'hidden'});
    await page.setViewportSize({width:1280,height:900});
    evidence.apiAddress={status:'passed',returned:true,fixture:root,inputSha256:hash(await readFile(input)),snapshots:before.map(item=>({id:item.id,...snapshot(item)}))};
    return;
  }
  const seeds=JSON.parse(await readFile(join(root,'android-api-address.json'),'utf8')).samples;
  assert.equal(before.length,seeds.length);
  for(const seed of seeds){
    const item=before.find(item=>item.title===seed.title);assert.ok(item);assert.equal(endpoint(item),seed.endpoint);
    const editor=await edit(seed.title);
    await page.setViewportSize({width:420,height:900});
    await expect(editor.getByLabel('API 地址',{exact:true})).toHaveValue(seed.endpoint);
    if(seed.name==='relative') await editor.getByLabel('名称 *',{exact:true}).fill(seed.title+' renamed');
    if(seed.name==='service') await editor.getByLabel('API 地址',{exact:true}).fill('/v2/services: 中文');
    if(seed.name==='user-info') await editor.getByLabel('API 地址',{exact:true}).fill('');
    if(seed.name==='empty') await editor.getByLabel('API 地址',{exact:true}).fill('/new');
    if(seed.name==='protocol'){
      await editor.getByLabel('API 地址',{exact:true}).fill('cancelled draft');
      await editor.getByRole('button',{name:'取消',exact:true}).click();
      await editor.waitFor({state:'hidden'});
    }else await save(editor);
    await flush();
    const current=await readItem(page,item.id);
    const expectedEndpoint=({service:'/v2/services: 中文','user-info':'',empty:'/new'})[seed.name]??seed.endpoint;
    assert.equal(endpoint(current),expectedEndpoint);
    assert.equal(current.password,item.password);assert.equal(current.appName,item.appName);assert.equal(current.email,item.email);
    const expectedFields=item.customFields.map(field=>field.name==='monica_api_key_url'?{...field,value:expectedEndpoint}:field);
    if(seed.name==='empty') expectedFields.push({name:'monica_api_key_url',value:'/new',protected:false});
    assert.deepEqual(current.customFields,expectedFields);
    const response=await page.evaluate(request=>chrome.runtime.sendMessage(request),{type:'MDBX2_OBJECT_REVEAL',providerId,objectId:current.providerRefs.find(ref=>ref.providerId===providerId).remoteId});
    assert.equal(response.ok,true);
    const payload=JSON.parse(response.data.payloadJson);
    assert.equal(payload.password_plain,item.password);
    assert.equal(payload.custom_fields.find(field=>field.title==='monica_api_key_url')?.value||'',expectedEndpoint);
    if(seed.name==='service'||seed.name==='user-info') assert.equal(payload.custom_fields.find(field=>field.title==='monica_api_key_url').is_protected,true);
  }
  await page.getByRole('button',{name:'选择新建类型',exact:true}).click();
  await page.locator('m3e-menu-item[data-create-type="API_KEY"]').click();
  const editor=loginEditor(page);
  await editor.getByLabel('名称 *',{exact:true}).fill('API address edge');
  await chooseOption(editor.getByLabel('保存到',{exact:true}),{label:name});
  await editor.getByLabel('API Key',{exact:true}).fill('synthetic-edge-api');
  await editor.getByLabel('API 地址',{exact:true}).fill('localhost:9080/api');
  await page.setViewportSize({width:320,height:900});
  await editor.getByLabel('API 地址',{exact:true}).scrollIntoViewIfNeeded();
  await screenshot(page,'api-address-create-320.png');
  await save(editor);await flush();
  const final=await items();assert.equal(final.length,seeds.length+1);
  await writeFile(join(root,'edge-api-address-expected.json'),JSON.stringify(final.map(snapshot),null,2));
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  const download=page.waitForEvent('download',{timeout:60000});
  await card.getByRole('button',{name:'导出 MDBX2 完整备份',exact:true}).click();
  const exported=join(output,'edge-api-address.mdbx');await saveStandaloneMdbxDownload(await download,exported);
  await writeFile(join(root,'edge-api-address.mdbx'),await readFile(exported));
  evidence.apiAddress={status:'passed',fixture:root,inputSha256:hash(await readFile(input)),exportSha256:hash(await readFile(exported)),snapshots:final.map(item=>({id:item.id,...snapshot(item)})),checks:['Android seven actual draft/native samples','arbitrary-address unrelated save','relative rename','edit service address','clear user-info address','cancel protocol edit','create localhost address','actual Native protection readback','UI export']};
}

export async function verifyApiAddressPersistence(page,evidence){
  for(const {id,...expected} of evidence.apiAddress.snapshots) assert.deepEqual(snapshot(await readItem(page,id)),expected);
  evidence.apiAddress.restartVerified=true;
}
