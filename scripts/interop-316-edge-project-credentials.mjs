import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { loginEditor, save, readItem } from './interop-315-edge-features.mjs';
export async function runProjectCredentialUi({page,evidence,screenshot}) {
  const project=randomUUID(), group=randomUUID(), other=randomUUID();
  const now=new Date().toISOString();
  const rows=[0,1,2].map(index=>({kind:'login',id:randomUUID(),title:'Credential UI fixture',username:index<2?'shared':'recovery',password:`password-${index}`,totpSecret:'JBSWY3DPEHPK3PXP',uris:[],notes:'',favorite:false,providerRefs:[],createdAt:now,updatedAt:now,passwordGroupId:project,
    customIconType:'EMOJI',customIconValue:'🔑',customIconUpdatedAt:123,
    customFields:[{name:'monica.content.credential',protected:true,value:JSON.stringify({version:1,groupId:index<2?group:other,passwordId:randomUUID(),label:index<2?'工作账号':'恢复账号',primary:index<2,groupOrder:index<2?0:1,passwordOrder:index<2?index:0,future:'keep'})}]}));
  // Explicit synthetic fixture setup only. Edits, clearing, reveal and cancellation use rendered UI.
  const seeded=await page.evaluate(items=>chrome.runtime.sendMessage({type:'VAULT_IMPORT_ITEMS',items}),rows);
  assert.equal(seeded.ok,true,JSON.stringify(seeded));
  const actual=seeded.data; assert.equal(actual.length,3);
  let projectTitle='Credential UI fixture';
  await page.reload(); await page.getByRole('heading',{name:'全部项目',exact:true}).waitFor();
  const open=async()=>{
    await page.setViewportSize({width:1280,height:950});
    await page.getByLabel('搜索密码库',{exact:true}).fill(projectTitle);
    await page.getByLabel(`查看${projectTitle}详情`,{exact:true}).first().click();
    await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button',{name:'编辑',exact:true}).click();
    const form=loginEditor(page);await expect(form.locator('[data-project-credential-editor]').first()).toBeVisible();return form;
  };
  let form=await open();
  const groups=form.locator('[data-credential-group]');await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).getByLabel('密码 2',{exact:true})).toHaveValue('password-1');
  for(const width of [1280,420,320]) {
    await page.setViewportSize({width,height:950});await groups.nth(0).scrollIntoViewIfNeeded();
    const geometries=await form.locator('[data-project-credential-editor]').evaluateAll(elements=>elements.map(el=>({scroll:el.scrollWidth,client:el.clientWidth})));assert.ok(geometries.every(geometry=>geometry.scroll<=geometry.client+1));
    await screenshot(page,`project-credentials-${width}.png`);
  }
  await groups.nth(0).getByLabel('用户名',{exact:true}).fill('updated-shared');
  await groups.nth(0).getByLabel('密码 2',{exact:true}).fill('updated-second-password');
  await groups.nth(0).getByLabel('内嵌验证码密钥',{exact:true}).fill('');
  await groups.nth(1).getByLabel('内嵌验证码密钥',{exact:true}).fill('JBSWY3DPEHPK3PXQ');
  await groups.nth(0).getByRole('button',{name:'添加密码',exact:true}).click();
  await groups.nth(0).getByLabel('密码 3',{exact:true}).fill('added-password');
  await page.mouse.move(0,0);
  await screenshot(page,'project-credentials-added-320.png');
  evidence.projectCredentialButton = await groups.nth(0).locator('.add-password').evaluate(el => ({shape:el.getAttribute('shape'),round:getComputedStyle(el).getPropertyValue('--m3e-button-shape-round'),baseRadius:el.shadowRoot?.querySelector('.base') ? getComputedStyle(el.shadowRoot.querySelector('.base')).borderRadius : null}));
  projectTitle='Renamed credential project';
  await form.getByLabel('名称 *',{exact:true}).fill(projectTitle);
  await form.getByLabel('恢复备注与笔记',{exact:true}).fill('  Shared project note\n保留全部凭据  ');
  await save(form);
  const saved=await Promise.all(actual.map(row=>readItem(page,row.id)));
  for(const [index,row] of saved.entries()) {
    assert.equal(row.username,index<2?'updated-shared':'recovery');
    assert.equal(row.password,index===1?'updated-second-password':`password-${index}`);
    assert.equal(row.totpSecret,index<2?'':'JBSWY3DPEHPK3PXQ');
    assert.deepEqual(row.customFields,actual[index].customFields);
    assert.equal(row.title,projectTitle);
    assert.equal(row.notes,'  Shared project note\n保留全部凭据  ');
  }
  const listing=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(listing.ok,true);
  const newRows=listing.data.filter(row=>row.title===projectTitle && !actual.some(old=>old.id===row.id));
  assert.equal(newRows.length,1);const added=await readItem(page,newRows[0].id);
  assert.equal(added.password,'added-password');assert.equal(added.username,'updated-shared');assert.equal(added.totpSecret,'');
  assert.equal(added.notes,'  Shared project note\n保留全部凭据  ');
  assert.equal(added.customIconType,'EMOJI');assert.equal(added.customIconValue,'🔑');assert.equal(added.customIconUpdatedAt,123);
  const meta=JSON.parse(added.customFields.find(field=>field.name==='monica.content.credential').value);
  assert.equal(meta.groupId,group);assert.equal(meta.passwordOrder,2);
  assert.ok(actual.every(row=>JSON.parse(row.customFields[0].value).passwordId!==meta.passwordId));
  saved.push(added);
  form=await open();await page.setViewportSize({width:320,height:950});
  await form.locator('[data-credential-group]').nth(0).getByRole('button',{name:'添加密码',exact:true}).click();
  await form.locator('[data-credential-group]').nth(1).getByLabel('用户名',{exact:true}).fill('cancelled');
  await form.getByRole('button',{name:'取消',exact:true}).click();await form.waitFor({state:'hidden'});
  for(const row of saved) assert.deepEqual(await readItem(page,row.id),row);
  const afterCancel=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));
  assert.equal(afterCancel.data.filter(row=>row.title===projectTitle).length,4);
  evidence.projectCredentials={status:'passed',layer:'Synthetic runtime-imported fixture; actual Edge editor, not Android application',saved,checks:['three viewport widths','one shared account/OTP per group','independent password edit','clear and change OTP in separate groups','exact metadata','new password identity and reopen','cancel added password']};
  evidence.projectCredentials.checks.push('project title and notes update every group and newly appended password');
  await page.setViewportSize({width:1280,height:900});
  await createGroupedProject({page,evidence,screenshot});
}
export async function verifyProjectCredentialUi(page,evidence) {
  for(const item of evidence.projectCredentials.saved) assert.deepEqual(await readItem(page,item.id),item);
  evidence.projectCredentials.restartVerified=true;
}

async function createGroupedProject({page,evidence,screenshot}) {
  const title='New grouped project';
  await page.getByLabel('搜索密码库',{exact:true}).fill('');
  await page.getByRole('button',{name:'选择新建类型',exact:true}).click();
  await page.locator('m3e-menu-item[data-create-type="PASSWORD"]').click();
  let form=loginEditor(page);
  await form.getByLabel('名称 *',{exact:true}).fill(title);
  await form.getByLabel('用户名',{exact:true}).fill('primary-user');
  await form.getByLabel('密码',{exact:true}).fill('primary-password');
  await form.getByRole('button',{name:'添加凭据组',exact:true}).click();
  let groups=form.locator('[data-credential-group]');await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).getByRole('heading',{name:'凭据组 1',exact:true})).toBeVisible();
  await expect(groups.nth(1).getByRole('heading',{name:'凭据组 2',exact:true})).toBeVisible();
  await groups.nth(0).getByLabel('凭据组名称',{exact:true}).fill('Primary account');
  await groups.nth(0).getByRole('button',{name:'添加密码',exact:true}).click();
  await groups.nth(0).getByLabel('密码 2',{exact:true}).fill('alternate-password');
  await groups.nth(1).getByLabel('凭据组名称',{exact:true}).fill('Recovery account');
  await groups.nth(1).getByLabel('用户名',{exact:true}).fill('recovery-user');
  await groups.nth(1).getByLabel('密码 1',{exact:true}).fill('recovery-password');
  await groups.nth(1).getByLabel('内嵌验证码密钥',{exact:true}).fill('JBSWY3DPEHPK3PXP');
  await page.setViewportSize({width:320,height:950});await groups.nth(1).scrollIntoViewIfNeeded();
  await screenshot(page,'project-create-groups-320.png');await save(form);
  const list=async()=>{ const response=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(response.ok,true);return Promise.all(response.data.filter(item=>item.title===title).map(item=>readItem(page,item.id))); };
  const created=await list();assert.equal(created.length,3);
  const meta=item=>JSON.parse(item.customFields.find(field=>field.name==='monica.content.credential').value);
  assert.equal(new Set(created.map(item=>item.passwordGroupId)).size,1);
  assert.equal(new Set(created.map(item=>meta(item).groupId)).size,2);
  assert.equal(new Set(created.map(item=>meta(item).passwordId)).size,3);
  assert.ok(created.every(item=>meta(item).projectId===item.passwordGroupId));
  assert.deepEqual(created.filter(item=>meta(item).primary).map(item=>item.password).sort(),['alternate-password','primary-password']);
  assert.ok(created.filter(item=>meta(item).primary).every(item=>item.username==='primary-user'));
  const recovery=created.find(item=>!meta(item).primary);assert.equal(recovery.username,'recovery-user');assert.equal(recovery.totpSecret,'JBSWY3DPEHPK3PXP');
  await page.setViewportSize({width:1280,height:950});await page.getByLabel('搜索密码库',{exact:true}).fill(title);
  await page.getByLabel(`查看${title}详情`,{exact:true}).first().click();
  await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button',{name:'编辑',exact:true}).click();
  form=loginEditor(page);groups=form.locator('[data-credential-group]');
  await groups.nth(0).getByLabel('凭据组名称',{exact:true}).fill('Renamed primary');
  await form.getByRole('button',{name:'添加凭据组',exact:true}).click();await expect(groups).toHaveCount(3);
  await expect(groups.nth(2).getByRole('heading',{name:'凭据组 3',exact:true})).toBeVisible();
  await groups.nth(2).getByLabel('凭据组名称',{exact:true}).fill('Third account');
  await groups.nth(2).getByLabel('用户名',{exact:true}).fill('third-user');
  await groups.nth(2).getByLabel('密码 1',{exact:true}).fill('third-password');await save(form);
  const edited=await list();assert.equal(edited.length,4);
  for(const old of created) {
    const current=edited.find(item=>item.id===old.id);assert.ok(current);
    const expected=meta(old);if(expected.primary) expected.label='Renamed primary';
    assert.deepEqual(meta(current),expected);assert.equal(current.password,old.password);assert.equal(current.username,old.username);
  }
  assert.equal(new Set(edited.map(item=>meta(item).groupId)).size,3);
  assert.equal(new Set(edited.map(item=>meta(item).passwordId)).size,4);
  // Use the actual keyboard and pointer controls; assert stable identities and content afterwards.
  await page.getByLabel(`查看${title}详情`,{exact:true}).first().click();
  await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button',{name:'编辑',exact:true}).click();
  form=loginEditor(page);groups=form.locator('[data-credential-group]');
  await groups.nth(0).locator('.password-order [slot="header"]').click();
  const firstPassword=edited.find(item=>meta(item).primary && meta(item).passwordOrder===0);
  const passwordHandle=groups.nth(0).locator(`[data-order-token="${meta(firstPassword).passwordId}"] .content-drag-handle`);
  await passwordHandle.focus();await page.keyboard.press('ArrowDown');
  await expect(groups.nth(0).getByLabel('密码 1',{exact:true})).toHaveValue('alternate-password');
  const panel=form.locator('m3e-expansion-panel').filter({has:page.locator('[slot="header"]').filter({hasText:'内容顺序'})});
  await panel.locator('[slot="header"]').first().click();
  const recoveryToken=`CREDENTIAL:${meta(edited.find(item=>meta(item).label==='Recovery account')).groupId}`;
  const thirdToken=`CREDENTIAL:${meta(edited.find(item=>meta(item).label==='Third account')).groupId}`;
  const thirdHandle=panel.locator(`[data-order-token="${thirdToken}"] .content-drag-handle`);
  await thirdHandle.focus();await page.keyboard.press('ArrowUp');
  await page.setViewportSize({width:320,height:950});await thirdHandle.scrollIntoViewIfNeeded();
  const target=panel.locator('[data-order-token="NOTES"]');await target.scrollIntoViewIfNeeded();
  const from=await thirdHandle.boundingBox(),to=await target.boundingBox();assert.ok(from&&to);
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();
  await page.mouse.move(to.x+20,to.y+8,{steps:12});await page.mouse.up();
  const order=await panel.locator('[data-order-token]').evaluateAll(elements=>elements.map(el=>el.dataset.orderToken));
  assert.ok(order.indexOf(thirdToken)<order.indexOf('NOTES'));
  assert.ok(order.indexOf(thirdToken)<order.indexOf(recoveryToken));
  await screenshot(page,'project-content-order-320.png');
  await panel.locator('[slot="header"]').first().click();
  const thirdGroup=form.locator(`[data-credential-group="${thirdToken.slice(11)}"]`);
  await thirdGroup.scrollIntoViewIfNeeded();await screenshot(page,'project-extra-group-320.png');
  await save(form);
  const reordered=await list();
  for(const old of edited) {
    const current=reordered.find(item=>item.id===old.id);assert.ok(current);
    assert.equal(current.password,old.password);assert.equal(current.username,old.username);
    assert.equal(meta(current).passwordId,meta(old).passwordId);assert.equal(meta(current).groupId,meta(old).groupId);
    assert.equal(meta(current).groupOrder,meta(old).primary?0:meta(old).label==='Third account'?1:2);
    assert.equal(meta(current).passwordOrder,meta(old).primary?1-meta(old).passwordOrder:meta(old).passwordOrder);
    const persistedOrder=current.customFields.find(field=>field.name==='monica.content.order').value.split(',');
    assert.ok(persistedOrder.indexOf(thirdToken)<persistedOrder.indexOf('NOTES'));
    assert.ok(persistedOrder.indexOf(thirdToken)<persistedOrder.indexOf(recoveryToken));
  }
  await page.setViewportSize({width:1280,height:950});
  await page.getByLabel(`查看${title}详情`,{exact:true}).first().click();
  await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button',{name:'编辑',exact:true}).click();
  form=loginEditor(page);groups=form.locator('[data-credential-group]');
  await expect(groups.nth(0).getByLabel('密码 1',{exact:true})).toHaveValue('alternate-password');
  await expect(groups.nth(1).getByLabel('凭据组名称',{exact:true})).toHaveValue('Third account');
  const reopenedThird=form.locator(`[data-credential-group="${thirdToken.slice(11)}"]`);
  assert.ok(await reopenedThird.evaluate(el=>Number(getComputedStyle(el.closest('[data-project-credential-editor]')).order)) < await form.getByLabel('恢复备注与笔记',{exact:true}).evaluate(el=>Number(getComputedStyle(el.closest('m3e-form-field')).order)));
  await groups.nth(0).locator('.password-order [slot="header"]').click();
  await groups.nth(0).locator('.content-drag-handle').first().focus();await page.keyboard.press('ArrowDown');
  await form.getByRole('button',{name:'取消',exact:true}).click();await form.waitFor({state:'hidden'});
  for(const item of reordered) assert.deepEqual(await readItem(page,item.id),item);
  evidence.projectCredentials.saved.push(...reordered);
  evidence.projectCredentials.checks.push('password keyboard order preserves identity and secrets','extra credential pointer order among notes and other content','cancel reorder has no writes','saved order reopens');
  evidence.projectCredentials.checks.push('UI create project with two groups and three passwords','rename existing group','append third credential group','project/group/password identity preservation');
  await page.setViewportSize({width:1280,height:900});
}
