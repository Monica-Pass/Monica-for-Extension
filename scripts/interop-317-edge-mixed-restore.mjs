import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { readItem } from './interop-315-edge-features.mjs';

async function rpc(page, request) {
  const response = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  assert.equal(response.ok, true, JSON.stringify(response)); return response.data;
}
async function unlock(page) {
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  await page.getByRole('button',{name:'解锁并设置',exact:true}).first().click();
  const dialog=page.locator('.mdbx2-dialog[role="dialog"]');
  await dialog.getByLabel('保险库密码（可留空）',{exact:true}).fill('Synthetic transfer fixture password');
  await dialog.getByRole('button',{name:'解锁本机副本',exact:true}).click();
  await dialog.getByRole('button',{name:'解锁本机副本',exact:true}).waitFor({state:'hidden'});
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
}
async function verifyMembers(page,fixture,allowCreated=false) {
  const restored=await Promise.all(fixture.sources.map(row=>readItem(page,row.id)));
  for(const row of restored) {
    const source=fixture.sources.find(source=>source.id===row.id);
    assert.equal(row.deletedAt,undefined);
    const expected=allowCreated&&row.id===fixture.addedId?{...source,replicaGroupId:`password:${source.id}`}:source;
    assert.deepEqual({...row,updatedAt:source.updatedAt,deletedAt:source.deletedAt,providerRefs:source.providerRefs},expected);
    if(row.id===fixture.addedId) assert.equal(Boolean(row.providerRefs[0].remoteId),allowCreated);
  }
  for(const original of fixture.originals) {
    const current=await rpc(page,{type:'MDBX2_OBJECT_REVEAL',providerId:fixture.providerId,objectId:original.objectId});
    assert.deepEqual({...current,headCommitId:original.headCommitId},original);
    if(original.objectId!==fixture.originals[0].objectId) assert.equal(current.headCommitId,original.headCommitId);
  }
  return restored;
}
export async function runMixedRestoreUi({page,fixture,evidence,screenshot,output}) {
  const state=evidence.mixedRestore={status:'running',fixtureLayer:'Actual partial native acknowledgement and encrypted backup imported through manager UI',checks:[]};
  await unlock(page);
  await page.getByRole('button',{name:/^回收站/}).click();
  await page.getByLabel('搜索密码库',{exact:true}).fill(fixture.sources[0].title);
  const before=await rpc(page,{type:'VAULT_LIST_DELETED_ITEMS'});
  assert.equal(before.filter(row=>fixture.sources.some(source=>source.id===row.id)).length,4);
  const button=page.locator('[data-restore-project]');
  await expect(button).toHaveCount(1);
  await button.click();
  const dialog=page.locator('[data-project-restore-dialog]');
  for(const width of [1280,420,320]) {
    await page.setViewportSize({width,height:950});
    await expect(dialog).toBeVisible();
    assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
    await screenshot(page,`mixed-restore-confirm-${width}.png`);
  }
  await dialog.getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual(await rpc(page,{type:'VAULT_LIST_DELETED_ITEMS'}),before);
  await button.click();
  // Observe the real request; discard only its successful response to the page.
  await page.evaluate(()=>{
    const send=chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__mixedRestoreCalls=[];
    chrome.runtime.sendMessage=function(request,...rest){
      const result=send(request,...rest);
      if(request?.type==='VAULT_PASSWORD_PROJECT_RESTORE') {
        window.__mixedRestoreCalls.push(structuredClone(request));
        if(!window.__mixedRestoreDropped){window.__mixedRestoreDropped=true;return result.then(()=>undefined);}
      }
      return result;
    };
  });
  await dialog.locator('[data-confirm-project-restore]').click();
  await expect(dialog).toHaveCount(0,{timeout:60000});
  const calls=await page.evaluate(()=>window.__mixedRestoreCalls);
  assert.equal(calls.length,1); assert.equal(Object.keys(calls[0].input.expected).length,4);
  const [receipt]=await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORES',operationId:calls[0].input.operationId});
  assert.equal(receipt.status,'completed'); assert.equal(receipt.memberIds.length,4);
  state.request=calls[0].input;state.restored=await verifyMembers(page,fixture);
  state.checks.push('actual backup import/source unlock/whole-project restore buttons','four-member confirmation at 1280/420/320px',
    'cancel keeps exact cohort','lost success response recovered with one request','completed receipt describes all four members',
    'one native tombstone restored; two active heads unchanged; unpublished password retained');
  await writeFile(join(output,'mixed-restore-before-restart.json'),JSON.stringify(state,null,2));
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:/^全部项目/}).click();
  await page.getByLabel('搜索密码库',{exact:true}).fill('');
}
export async function verifyMixedRestoreUi({page,fixture,evidence,screenshot,output}) {
  const state=evidence.mixedRestore;
  await unlock(page);
  const before=await verifyMembers(page,fixture);
  await rpc(page,{type:'VAULT_PASSWORD_PROJECT_RESTORE',input:state.request,confirmed:true});
  assert.deepEqual(await verifyMembers(page,fixture),before);
  await rpc(page,{type:'PROVIDER_SYNC',providerId:fixture.providerId});
  const restored=await verifyMembers(page,fixture,true);
  const added=restored.find(row=>row.id===fixture.addedId);
  const native=await rpc(page,{type:'MDBX2_OBJECT_REVEAL',providerId:fixture.providerId,objectId:added.providerRefs[0].remoteId});
  assert.ok(native.payloadJson.includes('synthetic-unpublished-secret'));
  assert.equal(JSON.parse(native.payloadJson).monica_entry_id,`password:${added.id}`);
  assert.ok(!fixture.originals.some(row=>row.objectId===native.objectId));
  const originalRecords=await Promise.all(restored.map(async original=>({original,ref:original.providerRefs[0],
    native:await rpc(page,{type:'MDBX2_OBJECT_REVEAL',providerId:fixture.providerId,objectId:original.providerRefs[0].remoteId})})));
  state.status='passed';state.restartVerified=true;state.restored=restored;
  state.checks.push('actual browser and Host restart retain all members and terminal receipt','old request replay makes no changes',
    'ordinary source sync creates the unpublished member once and keeps existing native payloads');
  await writeFile(join(output,'mixed-restored-project-expected.json'),JSON.stringify({synthetic:true,sources:fixture.sources,originals:fixture.originals,restored},null,2));
  await writeFile(join(output,'edge-restored-project-expected.json'),JSON.stringify({synthetic:true,restorationMode:'mixed',originalRecords,restored},null,2));
  await page.getByRole('button',{name:/^全部项目/}).click();
  await page.getByLabel('搜索密码库',{exact:true}).fill(fixture.sources[0].title);
  await screenshot(page,'mixed-restore-restarted-completed.png');
}
