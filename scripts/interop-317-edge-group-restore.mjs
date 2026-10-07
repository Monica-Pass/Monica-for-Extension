import assert from 'node:assert/strict';
import { mkdir, rename, rmdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { expect } from '@playwright/test';
import { readItem } from './interop-315-edge-features.mjs';

const rpc = async (page, request) => {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
};
const dialogOf = page => page.locator('[data-project-restore-dialog]');
async function watchRequests(page) {
  await page.evaluate(() => {
    if (window.__restoreOriginalSend) return;
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__restoreOriginalSend = original; window.__restoreCalls = [];
    chrome.runtime.sendMessage = function(request, ...args) {
      const promise = original(request, ...args);
      if (request?.type === 'VAULT_PASSWORD_PROJECT_RESTORE') {
        const call = { input: structuredClone(request.input), confirmed: request.confirmed };
        window.__restoreCalls.push(call);
        promise.then(result => { call.result = result; });
        if (window.__restoreDropNext) {
          window.__restoreDropNext = false;
          return promise.then(() => undefined);
        }
      }
      return promise;
    };
  });
}
async function dimensions(locator) {
  const sizes = await locator.evaluate(el => ({ width:el.clientWidth, scroll:el.scrollWidth }));
  assert.ok(sizes.scroll <= sizes.width + 1, JSON.stringify(sizes));
  for (const button of await locator.getByRole('button').all()) {
    if (!await button.isVisible()) continue;
    const box = await button.boundingBox();
    assert.ok(box.width >= 48 && box.height >= 48, `${await button.getAttribute('aria-label')}: ${JSON.stringify(box)}`);
  }
}
async function restoredHeads(page, members) {
  const values = [];
  for (const item of members) {
    const ref = item.providerRefs[0];
    values.push(await rpc(page,{type:'MDBX2_OBJECT_REVEAL',providerId:ref.providerId,objectId:ref.remoteId}));
  }
  assert.equal(new Set(values.map(row=>row.headCommitId)).size,1,'All group members must share one restore commit');
  return values;
}

export async function restoreProjectThroughUi({page,evidence,screenshot,members,ref}) {
  await watchRequests(page);
  const confirmedBefore=await page.evaluate(()=>window.__restoreCalls.filter(row=>row.confirmed).length);
  const state = evidence.groupRestore = {status:'running',checks:[]};
  const popup = await page.context().newPage();
  try {
    await popup.goto(new URL('popup.html',page.url()).href);
    for (const type of ['VAULT_PASSWORD_PROJECT_RESTORE','VAULT_PASSWORD_PROJECT_RESTORES','VAULT_PASSWORD_PROJECT_RESTORE_RESUME']) {
      const result = await popup.evaluate(type=>chrome.runtime.sendMessage({type}),type);
      assert.equal(result.ok,false); assert.match(result.error,/管理页/);
    }
  } finally { await popup.close(); }
  const unconfirmed = await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_PASSWORD_PROJECT_RESTORE',confirmed:false}));
  assert.equal(unconfirmed.ok,false);
  state.checks.push('popup denied all group restore commands','explicit confirmation required');
  const button = page.locator('[data-restore-project]');
  await expect(button).toHaveCount(1);
  const before = await rpc(page,{type:'VAULT_LIST_DELETED_ITEMS'});
  await button.focus(); await button.press('Enter');
  let dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  for (const width of [1280,420,320]) {
    await page.setViewportSize({width,height:950});
    await dimensions(dialog);
    await screenshot(page,`group-restore-confirm-${width}.png`);
  }
  const text = await dialog.innerText();
  await expect(dialog.getByText('Primary',{exact:true})).toBeVisible();
  await expect(dialog.getByText('Recovery',{exact:true})).toBeVisible();
  await expect(dialog.getByText('2 个密码',{exact:true})).toBeVisible();
  await expect(dialog.getByText('1 个密码',{exact:true})).toBeVisible();
  for (const row of members) assert.ok(!text.includes(row.password),'Confirmation must not disclose password values');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await dialogOf(page).getByRole('button',{name:'取消',exact:true}).click();
  await expect(dialogOf(page)).toHaveCount(0);
  assert.deepEqual(await rpc(page,{type:'VAULT_LIST_DELETED_ITEMS'}),before);
  assert.equal(await page.evaluate(()=>window.__restoreCalls.filter(row=>row.confirmed).length),confirmedBefore);
  state.checks.push('320/420/1280px confirmation and 48px controls','no secret disclosure','Escape/cancel preserves exact tombstones and focus');
  // A concurrent explicit deletion changes one cached tombstone after the user
  // reviewed the cohort. Keep the same request on retry and refuse all writes.
  await button.click(); dialog=dialogOf(page);
  const staleIndex=await page.evaluate(()=>window.__restoreCalls.length);
  await rpc(page,{type:'VAULT_DELETE_ITEM',itemId:members[0].id});
  const concurrent=await rpc(page,{type:'VAULT_LIST_DELETED_ITEMS'});
  await dialog.locator('[data-confirm-project-restore]').click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  const stale=await page.evaluate(index=>window.__restoreCalls[index],staleIndex);
  assert.equal(stale.result.code,'password-project-restore-not-staged');
  await dialog.getByRole('button',{name:'重试这次恢复',exact:true}).click();
  await page.waitForFunction(index=>window.__restoreCalls[index]?.result!==undefined,staleIndex+1);
  const retried=await page.evaluate(index=>window.__restoreCalls[index],staleIndex+1);
  assert.deepEqual(retried.input,stale.input); assert.equal(retried.result.code,'password-project-restore-not-staged');
  assert.deepEqual(await rpc(page,{type:'VAULT_LIST_DELETED_ITEMS'}),concurrent);
  assert.deepEqual(await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORES',operationId:stale.input.operationId}),[]);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  state.checks.push('concurrent tombstone update rejects exact confirmed cohort and repeated request without staging','current credential labels and member counts');
  // Explicitly restore then delete the synthetic project again to establish a
  // new user-reviewed cohort for the independent successful restoration case.
  const individualRestore = page.getByRole('button',{name:`恢复 ${members[0].title}`,exact:true});
  await expect(individualRestore).toHaveCount(members.length);
  for(let remaining=members.length;remaining>0;remaining--) {
    await individualRestore.first().click();
    await expect(individualRestore).toHaveCount(remaining-1,{timeout:30000});
  }
  const current=await Promise.all(members.map(row=>readItem(page,row.id)));
  assert.ok(current.every(row=>!row.deletedAt));
  state.checks.push('actual individual restore buttons handle queued re-deletion of an acknowledged tombstone without source sync');
  await rpc(page,{type:'VAULT_DELETE_PASSWORD_GROUP',anchorItemId:current[0].id,expected:Object.fromEntries(current.map(row=>[row.id,row.updatedAt]))});
  await rpc(page,{type:'PROVIDER_SYNC',providerId:ref.providerId});
  await page.setViewportSize({width:1280,height:950});
  await page.getByRole('button',{name:/^全部项目/}).click();
  await page.getByRole('button',{name:/^回收站/}).click();
  const successIndex=await page.evaluate(()=>window.__restoreCalls.length);
  await button.click(); dialog = dialogOf(page);
  await page.evaluate(()=>{window.__restoreDropNext=true;});
  await dialog.locator('[data-confirm-project-restore]').click();
  await expect(dialog).toHaveCount(0,{timeout:60000});
  const calls = await page.evaluate(index=>window.__restoreCalls.slice(index),successIndex);
  assert.equal(calls.length,1); assert.equal(calls[0].result.ok,true);
  const receipt = await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORES',operationId:calls[0].input.operationId});
  assert.equal(receipt[0].status,'completed');
  assert.deepEqual(receipt[0].memberIds.slice().sort(),members.map(row=>row.id).sort());
  const heads = await restoredHeads(page,members);
  state.commitId = heads[0].headCommitId; state.completedOperationId = calls[0].input.operationId;
  state.checks.push('lost successful response resolves from terminal receipt with one request','all original members restored in one commit');
  assert.deepEqual(await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORES'}),[]);
  await expect(page.getByLabel('搜索密码库',{exact:true})).toBeFocused();
}

export async function cancelUnsentProjectThroughUi({page,evidence,screenshot,members}) {
  await watchRequests(page);
  const originals=await Promise.all(members.map(row=>rpc(page,{type:'MDBX2_OBJECT_REVEAL',providerId:row.providerRefs[0].providerId,objectId:row.providerRefs[0].remoteId})));
  await page.getByRole('button',{name:/^回收站/}).click();
  for(const width of [1280,420,320]) {
    await page.setViewportSize({width,height:950});
    const action=page.locator('[data-restore-project]'),tile=action.locator('..');
    await action.scrollIntoViewIfNeeded();
    const box=await action.boundingBox();assert.ok(box.width>=180 && box.height>=48 && box.height<=80,JSON.stringify(box));
    const overflow=await tile.evaluate(el=>el.scrollWidth-el.clientWidth);assert.ok(overflow<=1);
    await screenshot(page,`group-cancel-trash-${width}.png`);
  }
  await page.setViewportSize({width:1280,height:950});
  await page.locator('[data-restore-project]').click();
  const start=await page.evaluate(()=>window.__restoreCalls.length);
  await page.evaluate(()=>{window.__restoreDropNext=true;});
  const dialog=dialogOf(page);
  await expect(dialog.getByText('Primary',{exact:true})).toBeVisible();
  await screenshot(page,'group-cancel-unsynchronized-confirm.png');
  await dialog.locator('[data-confirm-project-restore]').click();
  await expect(dialog).toHaveCount(0,{timeout:60000});
  const calls=await page.evaluate(index=>window.__restoreCalls.slice(index),start);
  assert.equal(calls.length,1);assert.equal(calls[0].result.ok,true);
  const operationId=calls[0].input.operationId;
  assert.equal((await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORES',operationId}))[0].status,'completed');
  for(const row of members) {
    const current=await readItem(page,row.id);
    assert.deepEqual({...current,updatedAt:row.updatedAt},row);
    const native=await rpc(page,{type:'MDBX2_OBJECT_REVEAL',providerId:row.providerRefs[0].providerId,objectId:row.providerRefs[0].remoteId});
    assert.deepEqual(native,originals.find(original=>original.objectId===native.objectId));
  }
  await expect(page.getByLabel('搜索密码库',{exact:true})).toBeFocused();
  evidence.groupCancellation={status:'passed',automaticSyncDisabledInSyntheticProfile:true,operationId,request:calls[0].input,
    checks:['actual whole-project delete and immediate restore UI before source sync','lost successful cancellation response resolved with one request',
      'all three rich cached records restored exactly','all native payloads and heads unchanged'],nativeHeads:originals.map(row=>({objectId:row.objectId,headCommitId:row.headCommitId}))};
  await page.setViewportSize({width:1280,height:860});
  await page.getByRole('button',{name:/^全部项目/}).click();
}

// Fault only the two receipt files in this newly created synthetic Host root.
// Preserve and restore every original byte, including on assertion failure.
async function obstructReceipts(evidence) {
  const root=resolve(evidence.output), operations=resolve(evidence.isolatedAppData,'Monica Extension','MDBX2','operations');
  const child=relative(root,operations);
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child),'Fault path must remain inside isolated run');
  const slots=[];
  const restore=async()=>{for(const slot of slots.reverse()) {
    if(slot.obstructed) await rmdir(slot.path);
    if(slot.moved) await rename(slot.saved,slot.path);
  }};
  try {
    for(const index of [0,1]) {
      const path=join(operations,`object-operations.state.${index}.json`), saved=path+'.ui-test-saved';
      const slot={path,saved,moved:false,obstructed:false}; slots.push(slot);
      try { await rename(path,saved); slot.moved=true; } catch(error) {if(error.code!=='ENOENT')throw error;}
      await mkdir(path); slot.obstructed=true;
    }
    return restore;
  } catch(error) {await restore();throw error;}
}

export async function stageProjectRestoreForRestart({page,evidence,screenshot,flush,output}) {
  const members=evidence.nativeRestore.saved, first=members[0], ref=first.providerRefs[0];
  await page.getByLabel('搜索密码库',{exact:true}).fill(first.title);
  const card=page.locator('article.item-card').filter({has:page.getByLabel(`查看${first.title}详情`,{exact:true})});
  page.once('dialog',async dialog=>{assert.match(dialog.message(),/条密码移到回收站/);await dialog.accept();});
  await card.getByRole('button',{name:'删除登录项',exact:true}).click();
  await flush();
  await page.getByRole('button',{name:/^回收站/}).click();
  const deleted=await rpc(page,{type:'VAULT_LIST_DELETED_ITEMS'});
  const nativeDeleted=await rpc(page,{type:'MDBX2_OBJECT_LIST',providerId:ref.providerId,collectionId:ref.remoteFolderId,deleted:true,pageSize:200});
  await page.locator('[data-restore-project]').click();
  const count=await page.evaluate(()=>window.__restoreCalls.length);
  const restoreFiles=await obstructReceipts(evidence);
  try {
    await dialogOf(page).locator('[data-confirm-project-restore]').click();
    await expect(dialogOf(page).getByRole('alert')).toBeVisible({timeout:60000});
    const call=await page.evaluate(index=>window.__restoreCalls[index],count);
    assert.equal(call.result.ok,false);
    assert.equal((await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORES',operationId:call.input.operationId}))[0].status,'prepared');
    assert.deepEqual(await rpc(page,{type:'VAULT_LIST_DELETED_ITEMS'}),deleted);
    assert.deepEqual(await rpc(page,{type:'MDBX2_OBJECT_LIST',providerId:ref.providerId,collectionId:ref.remoteFolderId,deleted:true,pageSize:200}),nativeDeleted);
    await rpc(page,{type:'MDBX2_VAULT_LOCK',providerId:ref.providerId});
    await dialogOf(page).getByRole('button',{name:'重试这次恢复',exact:true}).click();
    await page.waitForFunction(index=>window.__restoreCalls[index]?.result!==undefined,count+1);
    const retry=await page.evaluate(index=>window.__restoreCalls[index],count+1);
    assert.equal(retry.result.ok,false); assert.deepEqual(retry.input,call.input);
    await dialogOf(page).getByRole('button',{name:'查看待处理操作',exact:true}).click();
    const panel=page.locator(`[data-restore-operation="${call.input.operationId}"]`);
    await expect(panel.getByRole('button',{name:'解锁并设置',exact:true})).toBeVisible();
    for(const width of [420,320]) {
      await page.setViewportSize({width,height:950});
      await panel.scrollIntoViewIfNeeded(); await dimensions(panel);
      await screenshot(page,`group-restore-pending-${width}.png`);
    }
    evidence.groupRestore.pending={operationId:call.input.operationId,request:call.input,deleted,output};
    evidence.groupRestore.checks.push('real Host receipt-write failure retains atomic local/native tombstones','locked retry retains exact confirmed request','pending operation visible with source unlock action');
  } finally {await restoreFiles();evidence.groupRestore.receiptFilesRestored=true;}
  await page.setViewportSize({width:1280,height:860});
  await page.getByRole('button',{name:/^全部项目/}).click();
  await page.getByLabel('搜索密码库',{exact:true}).fill('');
}

export async function resumeProjectRestoreAfterRestart({page,evidence,screenshot}) {
  const state=evidence.groupRestore, pending=state.pending;
  assert.ok(pending);
  const receipt=await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORES',operationId:pending.operationId});
  assert.equal(receipt[0].status,'prepared');
  assert.deepEqual(await rpc(page,{type:'VAULT_LIST_DELETED_ITEMS'}),pending.deleted);
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  const panel=page.locator(`[data-restore-operation="${pending.operationId}"]`);
  await expect(panel).toBeVisible();
  await screenshot(page,'group-restore-restarted-pending.png');
  await panel.getByRole('button',{name:'解锁并设置',exact:true}).click();
  const source=page.locator('.mdbx2-dialog[role="dialog"]');
  await source.getByLabel('保险库密码（可留空）',{exact:true}).fill('Synthetic transfer fixture password');
  await source.getByRole('button',{name:'解锁本机副本',exact:true}).click();
  await source.getByRole('button',{name:'解锁本机副本',exact:true}).waitFor({state:'hidden'});
  await source.getByRole('button',{name:'取消',exact:true}).click();
  await panel.locator('[data-restore-resume]').click();
  await expect(panel).toHaveCount(0,{timeout:60000});
  await expect(page.locator('[data-restores-refresh]')).toBeFocused();
  const restored=[];
  for(const item of evidence.nativeRestore.saved) {
    const current=await readItem(page,item.id);
    assert.deepEqual({...current,updatedAt:item.updatedAt,providerRefs:item.providerRefs},item);
    restored.push(current);
  }
  const heads=await restoredHeads(page,restored);
  state.restartCommitId=heads[0].headCommitId; assert.notEqual(state.restartCommitId,state.commitId);
  const expectedPath=join(pending.output,'edge-restored-project-expected.json');
  const expected=JSON.parse(await readFile(expectedPath,'utf8'));
  for(const [index,item] of restored.entries()) {
    const original=expected.originalRecords.find(row=>row.original.id===item.id);
    assert.deepEqual({...heads[index],headCommitId:original.native.headCommitId},original.native);
  }
  expected.restored=restored;
  await writeFile(expectedPath,JSON.stringify(expected,null,2));
  evidence.nativeRestore.saved=restored;
  state.checks.push('actual browser and Host restart preserves pending encrypted journal','source unlock and exact-operation UI resume','fresh single commit and exact original raw payload for every member');
  state.status='passed'; state.restartVerified=true;
  if(evidence.groupCancellation) {
    const cancellation=await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORES',operationId:evidence.groupCancellation.operationId});
    assert.equal(cancellation[0].status,'completed');
    const before=await Promise.all(restored.map(row=>readItem(page,row.id)));
    await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORE',input:evidence.groupCancellation.request,confirmed:true});
    for(const row of before)assert.deepEqual(await readItem(page,row.id),row);
    evidence.groupCancellation.restartVerified=true;
    evidence.groupCancellation.checks.push('cancellation terminal receipt survives browser restart and replays without changing later restored members');
  }
  await page.getByRole('button',{name:/^全部项目/}).click();
}
