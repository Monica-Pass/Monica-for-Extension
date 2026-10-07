import assert from 'node:assert/strict';
import {expect} from '@playwright/test';
import {loginEditor,save,readItem,chooseOption,expand} from './interop-315-edge-features.mjs';
export async function runSsoUiCheck({page,evidence,screenshot}) {
  const fixture=process.env.MONICA_315_MDBX_FIXTURE,providerName='Synthetic SSO MDBX';
  if(fixture){
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    await page.locator('m3e-list-action').filter({hasText:'连接 MDBX2 保险库'}).click();
    const dialog=page.getByRole('dialog',{name:/MDBX2/});
    await dialog.getByLabel('显示名称',{exact:true}).fill(providerName);
    await dialog.getByLabel('MDBX2 可移植备份',{exact:true}).setInputFiles(fixture);
    await dialog.getByLabel('保险库密码（可留空）',{exact:true}).fill('Synthetic transfer fixture password');
    await dialog.getByRole('button',{name:'验证、解锁并导入',exact:true}).click();await dialog.waitFor({state:'hidden',timeout:60000});
  }
  async function flush(){
    if(!fixture)return;
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    const card=page.locator('m3e-card[data-home-provider-id]').filter({has:page.getByRole('heading',{name:providerName,exact:true})});
    const button=card.getByRole('button',{name:/^(立即同步|重试同步|写入本机副本)$/});await button.click();
    await expect(card.getByRole('button',{name:'取消同步',exact:true})).toHaveCount(0,{timeout:60000});await expect(button).toBeVisible({timeout:60000});
    await page.getByRole('button',{name:/^全部项目/}).click();
  }
  async function create(name){
    await page.getByRole('button',{name:'选择新建类型',exact:true}).click();await page.locator('m3e-menu-item[data-create-type="PASSWORD"]').click();
    const editor=loginEditor(page);await editor.getByLabel('名称 *',{exact:true}).fill(name);
    if(fixture)await chooseOption(editor.getByLabel('保存到',{exact:true}),{label:providerName});
    return editor;
  }
  async function find(name){const listed=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(listed.ok,true);return readItem(page,listed.data.find(i=>i.title===name).id);}
  let editor=await create('Synthetic SSO account');await editor.getByLabel('用户名',{exact:true}).fill('sso@example.test');await save(editor);await flush();
  const account=await find('Synthetic SSO account');
  editor=await create('Synthetic SSO website');
  await expand(editor,'登录方式');await chooseOption(editor.getByLabel('登录方式',{exact:true}),'SSO');
  await editor.getByLabel('SSO 提供商',{exact:true}).fill('GOOGLE');
  await chooseOption(editor.getByLabel('关联账号',{exact:true}),{label:'Synthetic SSO account · sso@example.test'});
  await page.setViewportSize({width:420,height:920});await editor.getByLabel('关联账号',{exact:true}).scrollIntoViewIfNeeded();
  await screenshot(page,'sso-picker-narrow.png');await save(editor);await flush();
  const linked=await find('Synthetic SSO website');assert.ok(linked.ssoRefLogicalId);assert.equal(linked.ssoRefEntryId,undefined);
  assert.equal(linked.ssoRefLogicalId,account.replicaGroupId||`password:${account.id}`);
  const open=async()=>{await page.getByLabel('搜索密码库',{exact:true}).fill('Synthetic SSO website');await page.getByLabel('查看Synthetic SSO website详情',{exact:true}).first().click();return page.locator('[role="dialog"][data-item-kind="login"]');};
  await page.setViewportSize({width:420,height:920});let detail=await open();await expect(detail.getByText('Synthetic SSO account · sso@example.test',{exact:true})).toBeVisible();await screenshot(page,'sso-detail-narrow.png');
  await detail.getByRole('button',{name:'编辑',exact:true}).click();editor=loginEditor(page);await editor.getByRole('button',{name:'解除账号关联',exact:true}).click();await editor.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal((await readItem(page,linked.id)).ssoRefLogicalId,linked.ssoRefLogicalId);
  detail=await open();await detail.getByRole('button',{name:'编辑',exact:true}).click();editor=loginEditor(page);await editor.getByRole('button',{name:'解除账号关联',exact:true}).click();await save(editor);await flush();
  const unlinked=await readItem(page,linked.id);assert.equal(unlinked.ssoRefLogicalId,undefined);
  if(fixture){const ref=unlinked.providerRefs.find(r=>r.remoteId);const result=await page.evaluate(ref=>chrome.runtime.sendMessage({type:'MDBX2_OBJECT_REVEAL',providerId:ref.providerId,objectId:ref.remoteId}),ref);assert.equal(result.ok,true);assert.equal(JSON.parse(result.data.payloadJson).sso_ref_logical_id,null);}
  assert.equal((await readItem(page,account.id)).username,'sso@example.test');
  await page.setViewportSize({width:1280,height:900});
  evidence.ssoPicker={status:'passed',selectedAccount:true,detailResolved:true,cancelPreserved:true,explicitUnlink:true,nativeUnlink:!!fixture};
  if(fixture && process.env.MONICA_315_SSO_SECOND_VAULT){
    detail=await open();await detail.getByRole('button',{name:'编辑',exact:true}).click();editor=loginEditor(page);
    await chooseOption(editor.getByLabel('关联账号',{exact:true}),{label:'Synthetic SSO account · sso@example.test'});await save(editor);await flush();
    const source=await readItem(page,linked.id);
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    await page.locator('m3e-list-action').filter({hasText:'连接 MDBX2 保险库'}).click();
    const destination=page.getByRole('dialog',{name:/MDBX2/});
    await destination.getByLabel('显示名称',{exact:true}).fill('Synthetic SSO destination');
    await destination.getByLabel('MDBX2 可移植备份',{exact:true}).setInputFiles(process.env.MONICA_315_SSO_SECOND_VAULT);
    await destination.getByLabel('保险库密码（可留空）',{exact:true}).fill('Synthetic transfer fixture password');
    await destination.getByRole('button',{name:'验证、解锁并导入',exact:true}).click();await destination.waitFor({state:'hidden',timeout:60000});
    const providers=await page.evaluate(()=>chrome.runtime.sendMessage({type:'PROVIDER_LIST'}));assert.equal(providers.ok,true);
    const targetId=providers.data.find(p=>p.name==='Synthetic SSO destination').id;
    await page.locator(`[data-home-provider-id="${targetId}"]`).getByRole('button',{name:'批量传输',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'复制或移动项目',exact:true});
    await dialog.getByLabel('筛选项目',{exact:true}).fill('Synthetic SSO website');
    await dialog.locator('.batch-item-row').filter({hasText:'Synthetic SSO website'}).locator('m3e-checkbox').click();
    await dialog.getByRole('button',{name:'检查并生成计划',exact:true}).click();
    await expect(dialog.locator('.batch-plan-row')).toHaveCount(2);await expect(dialog.locator('.batch-plan-row.blocked')).toHaveCount(0);
    await expect(dialog.getByText('关联项目 · 自动包含',{exact:true})).toHaveCount(1);
    await page.setViewportSize({width:420,height:920});await dialog.locator('.batch-plan-panel').scrollIntoViewIfNeeded();
    assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1));await screenshot(page,'sso-copy-plan-narrow.png');
    await dialog.getByRole('button',{name:'执行复制',exact:true}).click();await expect(dialog.locator('.batch-result-row.result-completed')).toHaveCount(2,{timeout:60000});
    await expect(dialog.locator('.batch-result-row.result-failed')).toHaveCount(0);await dialog.locator('.batch-result-row').last().scrollIntoViewIfNeeded();await screenshot(page,'sso-copy-result-narrow.png');
    await dialog.getByRole('button',{name:'关闭批量传输',exact:true}).click();
    const list=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(list.ok,true);
    const records=await Promise.all(list.data.filter(i=>['Synthetic SSO website','Synthetic SSO account'].includes(i.title)).map(i=>readItem(page,i.id)));
    const copied=records.find(i=>i.title==='Synthetic SSO website'&&i.providerRefs.some(r=>r.providerId===targetId));
    const copiedAccount=records.find(i=>i.title==='Synthetic SSO account'&&i.providerRefs.some(r=>r.providerId===targetId));
    assert.ok(copied&&copiedAccount);assert.equal(copied.ssoRefLogicalId,copiedAccount.replicaGroupId);assert.notEqual(copied.ssoRefLogicalId,source.ssoRefLogicalId);
    for(const item of [copied,copiedAccount]){const ref=item.providerRefs.find(r=>r.providerId===targetId);const revealed=await page.evaluate(ref=>chrome.runtime.sendMessage({type:'MDBX2_OBJECT_REVEAL',providerId:ref.providerId,objectId:ref.remoteId}),ref);assert.equal(revealed.ok,true);const payload=JSON.parse(revealed.data.payloadJson);assert.equal(item===copied?payload.sso_ref_logical_id:payload.monica_entry_id,copiedAccount.replicaGroupId);}
    assert.deepEqual(await readItem(page,source.id),source);
    evidence.ssoCopy={status:'passed',autoIncludedAccount:true,nativeReferenceRemapped:true,sourceUnchanged:true,narrowNoOverflow:true};
    await page.setViewportSize({width:1280,height:900});
    await page.locator(`[data-home-provider-id="${targetId}"]`).getByRole('button',{name:'批量传输',exact:true}).click();
    const move=page.getByRole('dialog',{name:'复制或移动项目',exact:true});
    await move.getByLabel('筛选项目',{exact:true}).fill('Synthetic SSO account');
    await move.locator('.batch-item-row').filter({hasText:'Synthetic SSO account'}).filter({hasText:providerName}).locator('m3e-checkbox').click();
    await move.locator('.batch-action-segments label').filter({has:page.getByText('移动',{exact:true})}).click();
    await move.getByRole('button',{name:'检查并生成计划',exact:true}).click();
    await expect(move.locator('.batch-plan-row')).toHaveCount(2);await expect(move.locator('.batch-plan-row.blocked')).toHaveCount(0);
    const submit=move.getByRole('button',{name:'确认并移动',exact:true});await expect(submit).toBeDisabled();
    await move.locator('.batch-move-confirm m3e-checkbox').click();await expect(submit).toBeEnabled();
    await page.setViewportSize({width:420,height:920});await move.locator('.batch-move-confirm').scrollIntoViewIfNeeded();await screenshot(page,'sso-move-confirm-narrow.png');
    await submit.click();await expect(move.locator('.batch-result-row.result-completed')).toHaveCount(2,{timeout:60000});await expect(move.locator('.batch-result-row.result-failed')).toHaveCount(0);
    await move.locator('.batch-result-row').last().scrollIntoViewIfNeeded();await screenshot(page,'sso-move-completed-narrow.png');
    await move.getByRole('button',{name:'关闭批量传输',exact:true}).click();
    const moved=await readItem(page,source.id),movedAccount=await readItem(page,account.id);
    assert.ok(moved.providerRefs.some(r=>r.providerId===targetId));assert.ok(movedAccount.providerRefs.some(r=>r.providerId===targetId));
    assert.equal(moved.ssoRefLogicalId,movedAccount.replicaGroupId);
    for(const original of [source,account]){const ref=original.providerRefs.find(r=>r.remoteId);const deleted=await page.evaluate(ref=>chrome.runtime.sendMessage({type:'MDBX2_OBJECT_LIST',providerId:ref.providerId,collectionId:ref.remoteFolderId,deleted:true,pageSize:200}),ref);assert.equal(deleted.ok,true,JSON.stringify(deleted));assert.equal(deleted.data.nextCursor,undefined);assert.ok(deleted.data.items.some(item=>item.objectId===ref.remoteId&&item.deleted),'Source tombstone missing');}
    assert.deepEqual(await readItem(page,copied.id),copied);assert.deepEqual(await readItem(page,copiedAccount.id),copiedAccount);
    evidence.ssoMove={status:'passed',incomingWebsiteIncluded:true,explicitConfirmation:true,sourceTombstones:true,targetAccountLinked:true,priorCopiesUnchanged:true};
    await page.setViewportSize({width:1280,height:900});
  }
}
