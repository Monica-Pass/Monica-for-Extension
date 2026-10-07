import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { chooseOption, loginEditor, save, fill, readItem } from './interop-315-edge-features.mjs';
const contentSnapshot=({bitwardenCipherId,bitwardenCustomFieldsVersion,...item})=>item;

export async function runBitwardenProjectUi({page,evidence,screenshot,output}) {
  const fixture=JSON.parse(await readFile(process.env.MONICA_BW_PROJECT_FIXTURE,'utf8'));
  assert.equal(fixture.synthetic,true);assert.equal(new URL(fixture.baseUrl).hostname,'127.0.0.1');
  await page.setViewportSize({width:1280,height:950});
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  await page.locator('m3e-list-action').filter({hasText:'连接 Bitwarden'}).click();
  const dialog=page.getByRole('dialog',{name:'连接 Bitwarden',exact:true});
  await fill(dialog,{'显示名称':fixture.name,'服务器地址 *':fixture.baseUrl,'邮箱 *':fixture.email,'主密码 *':fixture.password});
  await dialog.getByRole('button',{name:'登录并连接',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});
  const sourceCard=page.locator('[data-home-provider-id]').filter({has:page.getByRole('heading',{name:fixture.name,exact:true})});
  const providerId=await sourceCard.getAttribute('data-home-provider-id');assert.ok(providerId);
  const flush=async()=>{
    await page.setViewportSize({width:1280,height:950});
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    const before=await page.evaluate(async id=>{const result=await chrome.runtime.sendMessage({type:'PROVIDER_LIST'});if(!result.ok)throw new Error(result.error);return result.data.find(item=>item.id===id).lastSyncAt;},providerId);
    const sync=sourceCard.locator('.source-actions-primary').getByRole('button',{name:/^(立即同步|重试同步)$/});await sync.click();
    await expect.poll(()=>page.evaluate(async({id,before})=>{const result=await chrome.runtime.sendMessage({type:'PROVIDER_LIST'});if(!result.ok)throw new Error(result.error);const provider=result.data.find(item=>item.id===id);return !!provider.lastSyncAt&&provider.lastSyncAt!==before&&!provider.lastError;},{id:providerId,before}),{timeout:60000}).toBe(true);
    await expect.poll(()=>page.evaluate(async id=>{const result=await chrome.runtime.sendMessage({type:'PROVIDER_QUEUE_STATUS'});if(!result.ok)throw new Error(result.error);return result.data.find(item=>item.providerId===id)?.pending??0;},providerId),{timeout:60000}).toBe(0);
    await expect(sourceCard.getByRole('button',{name:'取消同步',exact:true})).toHaveCount(0,{timeout:60000});
    await expect(sync).toBeVisible({timeout:60000});await expect(sourceCard.locator('[role="alert"]')).toHaveCount(0);
    await page.getByRole('button',{name:/^全部项目/}).click();
  };
  const list=async()=>{const response=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(response.ok,true);return Promise.all(response.data.filter(item=>item.providerRefs.some(ref=>ref.providerId===providerId)).map(item=>readItem(page,item.id)));};
  const open=async(query,title)=>{await page.getByLabel('搜索密码库',{exact:true}).fill(query);await page.getByLabel(`查看${title}详情`,{exact:true}).click();await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button',{name:'编辑',exact:true}).click();return loginEditor(page);};
  await flush();const initial=await list();assert.equal(initial.length,5);
  const independent=initial.find(item=>!item.passwordGroupId);assert.ok(independent);
  let form=await open('server-shared',fixture.title), groups=form.locator('[data-credential-group]');
  await expect(groups).toHaveCount(2);await expect(groups.nth(0).getByLabel('密码 3',{exact:true})).toHaveValue('server-added-password');
  await groups.nth(0).getByLabel('用户名',{exact:true}).fill('edge-shared');
  await form.getByLabel('名称 *',{exact:true}).fill('Edge Bitwarden project');
  await form.getByLabel('恢复备注与笔记',{exact:true}).fill('  Edge note\n全部凭据  ');
  await groups.nth(0).getByRole('button',{name:'添加密码',exact:true}).click();await groups.nth(0).getByLabel('密码 4',{exact:true}).fill('edge-added-password');
  await form.getByRole('button',{name:'添加凭据组',exact:true}).click();await expect(groups).toHaveCount(3);
  await groups.nth(2).getByLabel('凭据组名称',{exact:true}).fill('Edge third');await groups.nth(2).getByLabel('用户名',{exact:true}).fill('edge-third');await groups.nth(2).getByLabel('密码 1',{exact:true}).fill('edge-third-password');
  await page.setViewportSize({width:320,height:950});await groups.nth(2).scrollIntoViewIfNeeded();
  assert.ok(await form.locator('[data-project-credential-editor]').evaluateAll(els=>els.every(el=>el.scrollWidth<=el.clientWidth+1)));
  await screenshot(page,'bw-project-third-320.png');await save(form);await flush();
  const edited=await list();assert.equal(edited.length,7);
  const project=edited.filter(item=>item.passwordGroupId===fixture.projectId);assert.equal(project.length,6);
  assert.ok(project.every(item=>item.title==='Edge Bitwarden project'&&item.notes==='  Edge note\n全部凭据  '));
  assert.equal(project.filter(item=>item.username==='edge-shared').length,4);
  for(const old of initial.filter(item=>item.passwordGroupId)) {const next=project.find(item=>item.bitwardenCipherId===old.bitwardenCipherId);assert.ok(next);assert.equal(next.password,old.password);assert.deepEqual(next.customFields,old.customFields);}
  assert.deepEqual(edited.find(item=>item.id===independent.id),independent);
  await page.setViewportSize({width:1280,height:950});form=await open('edge-shared','Edge Bitwarden project');groups=form.locator('[data-credential-group]');
  await expect(groups).toHaveCount(3);await groups.nth(0).getByLabel('用户名',{exact:true}).fill('cancelled');
  await form.getByRole('button',{name:'取消',exact:true}).click();await form.waitFor({state:'hidden'});
  for(const item of edited) assert.deepEqual(contentSnapshot(await readItem(page,item.id)),contentSnapshot(item));
  await page.getByLabel('搜索密码库',{exact:true}).fill('');
  await page.getByRole('button',{name:'选择新建类型',exact:true}).click();await page.locator('m3e-menu-item[data-create-type="PASSWORD"]').click();
  form=loginEditor(page);await form.getByLabel('名称 *',{exact:true}).fill('New Bitwarden project');
  await chooseOption(form.getByLabel('保存到',{exact:true}),{label:fixture.name});
  await form.getByLabel('用户名',{exact:true}).fill('new-primary');await form.getByLabel('密码',{exact:true}).fill('new-primary-password');
  await form.getByRole('button',{name:'添加凭据组',exact:true}).click();groups=form.locator('[data-credential-group]');await expect(groups).toHaveCount(2);
  await groups.nth(1).getByLabel('用户名',{exact:true}).fill('new-secondary');await groups.nth(1).getByLabel('密码 1',{exact:true}).fill('new-secondary-password');
  await page.setViewportSize({width:420,height:950});await groups.nth(1).scrollIntoViewIfNeeded();await screenshot(page,'bw-project-create-420.png');
  await save(form);await flush();const final=await list();assert.equal(final.length,9);
  const created=final.filter(item=>item.title==='New Bitwarden project');assert.equal(created.length,2);assert.ok(created[0].passwordGroupId);assert.equal(created[0].passwordGroupId,created[1].passwordGroupId);assert.notEqual(created[0].passwordGroupId,fixture.projectId);
  for(const item of final.filter(item=>item.passwordGroupId)){const metadata=JSON.parse(item.customFields.find(field=>field.name==='monica.content.credential').value);assert.equal(metadata.projectId,item.passwordGroupId);}
  await writeFile(join(output,'bw-project-readback.json'),JSON.stringify({synthetic:true,fixturePath:process.env.MONICA_BW_PROJECT_FIXTURE,items:final},null,2));
  evidence.bitwardenProjects={status:'passed',providerId,saved:final,checks:['real source UI login','Android-derived project restored','shared edit/password append/group append','actual UI sync','independent same-title record unchanged','cancel no writes','new two-group project saved to real server','320/420px']};
  await page.setViewportSize({width:1280,height:900});await page.getByLabel('搜索密码库',{exact:true}).fill('');
}
export async function verifyBitwardenProjectUi(page,evidence){for(const item of evidence.bitwardenProjects.saved)assert.deepEqual(contentSnapshot(await readItem(page,item.id)),contentSnapshot(item));evidence.bitwardenProjects.restartVerified=true;}

export async function runBitwardenProjectAndroidReturnUi({page,evidence,screenshot}) {
  const root=process.env.MONICA_BW_PROJECT_ANDROID_RETURN;
  const proof=JSON.parse(await readFile(join(root,'bitwarden-project-return-evidence.json'),'utf8'));
  const bytes=await readFile(join(root,'edge-return-fixture.json'));
  assert.equal(proof.status,'passed');assert.equal(createHash('sha256').update(bytes).digest('hex'),proof.edgeFixtureSha256);
  const returned=JSON.parse(bytes);assert.equal(returned.synthetic,true);assert.equal(returned.items.length,9);
  const fixture=JSON.parse(await readFile(returned.fixturePath,'utf8'));
  assert.equal(fixture.synthetic,true);assert.equal(fixture.baseUrl,'http://127.0.0.1:18316');
  await page.setViewportSize({width:1280,height:950});
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  await page.locator('m3e-list-action').filter({hasText:'连接 Bitwarden'}).click();
  const dialog=page.getByRole('dialog',{name:'连接 Bitwarden',exact:true});
  await fill(dialog,{'显示名称':fixture.name,'服务器地址 *':fixture.baseUrl,'邮箱 *':fixture.email,'主密码 *':fixture.password});
  await dialog.getByRole('button',{name:'登录并连接',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});
  const source=page.locator('[data-home-provider-id]').filter({has:page.getByRole('heading',{name:fixture.name,exact:true})});
  const providerId=await source.getAttribute('data-home-provider-id');assert.ok(providerId);
  const state=async()=>page.evaluate(async id=>{const result=await chrome.runtime.sendMessage({type:'PROVIDER_LIST'});if(!result.ok)throw new Error(result.error);return result.data.find(item=>item.id===id);},providerId);
  const previous=(await state()).lastSyncAt;
  await source.locator('.source-actions-primary').getByRole('button',{name:/^(立即同步|重试同步)$/}).click();
  await expect.poll(async()=>{const current=await state();return !!current.lastSyncAt&&current.lastSyncAt!==previous&&!current.lastError;},{timeout:60000}).toBe(true);
  await expect(source.getByRole('button',{name:'取消同步',exact:true})).toHaveCount(0,{timeout:60000});
  await page.getByRole('button',{name:/^全部项目/}).click();
  const listed=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(listed.ok,true);
  const saved=await Promise.all(listed.data.filter(item=>item.providerRefs.some(ref=>ref.providerId===providerId)).map(item=>readItem(page,item.id)));
  const id=item=>item.bitwardenCipherId??item.providerRefs.find(ref=>ref.remoteId)?.remoteId;
  const semantic=item=>({title:item.title,username:item.username,password:item.password,notes:item.notes,fields:item.customFields,uris:item.uris,otp:item.totpSecret??'',project:item.passwordGroupId});
  assert.equal(saved.length,9);for(const expected of returned.items)assert.deepEqual(semantic(saved.find(item=>id(item)===id(expected))),semantic(expected));
  for(const title of ['Edge Bitwarden project','New Bitwarden project']) {
    await page.setViewportSize({width:1280,height:950});await page.getByLabel('搜索密码库',{exact:true}).fill(title);
    await page.getByLabel(`查看${title}详情`,{exact:true}).click();
    await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button',{name:'编辑',exact:true}).click();
    const form=loginEditor(page), groups=form.locator('[data-credential-group]');
    const expected=saved.filter(item=>item.title===title), metadata=item=>JSON.parse(item.customFields.find(field=>field.name==='monica.content.credential').value);
    const groupIds=[...new Set(expected.sort((a,b)=>metadata(a).groupOrder-metadata(b).groupOrder).map(item=>metadata(item).groupId))];
    await expect(groups).toHaveCount(groupIds.length);
    for(const [index,groupId] of groupIds.entries()) {
      const rows=expected.filter(item=>metadata(item).groupId===groupId).sort((a,b)=>metadata(a).passwordOrder-metadata(b).passwordOrder);
      await expect(groups.nth(index).getByLabel('用户名',{exact:true})).toHaveValue(rows[0].username);
      for(const [position,row] of rows.entries())await expect(groups.nth(index).getByLabel(`密码 ${position+1}`,{exact:true})).toHaveValue(row.password);
    }
    // HTML textarea.value normalizes line endings; the vault comparison above and
    // cancellation/restart checks below still require the original CRLF bytes.
    await expect(form.getByLabel('恢复备注与笔记',{exact:true})).toHaveValue(expected[0].notes.replace(/\r\n?/g,'\n'));
    for(const width of [420,320]) {await page.setViewportSize({width,height:950});await groups.first().scrollIntoViewIfNeeded();
      assert.ok(await form.locator('[data-project-credential-editor]').evaluateAll(els=>els.every(el=>el.scrollWidth<=el.clientWidth+1)));
      await screenshot(page,`bw-android-return-${groupIds.length}groups-${width}.png`);}
    await form.getByRole('button',{name:'取消',exact:true}).click();await form.waitFor({state:'hidden'});
  }
  for(const item of saved)assert.deepEqual(contentSnapshot(await readItem(page,item.id)),contentSnapshot(item));
  evidence.bitwardenProjects={status:'passed',providerId,saved,layer:'Actual Android encrypted server writes -> fresh Edge source connection -> rendered editors',
    checks:['hash-verified Android return fixture','real source login and HTTP sync','nine exact records','Android-edited shared fields/label/password order','both project editors at420/320','cancel no writes']};
  await page.setViewportSize({width:1280,height:900});await page.getByLabel('搜索密码库',{exact:true}).fill('');
}
