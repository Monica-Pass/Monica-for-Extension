import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { readItem } from './interop-315-edge-features.mjs';
import { restoreProjectThroughUi, cancelUnsentProjectThroughUi, stageProjectRestoreForRestart, resumeProjectRestoreAfterRestart } from './interop-317-edge-group-restore.mjs';

export async function runNativeRestoreUi({ page, evidence, screenshot, output, groupRestore = false }) {
  const fixture = process.env.MONICA_315_MDBX_FIXTURE;
  assert.ok(fixture, 'An explicit synthetic MDBX fixture is required');
  const sourceName = 'Synthetic restore MDBX';
  const rpc = async request => {
    const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
    assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
  };
  // Exercise explicit manual-sync and unsent deletion boundaries deterministically
  // using the actual preference in this newly created synthetic profile.
  if(groupRestore) await page.evaluate(()=>chrome.storage.local.set({'monica.sync.preferences.v1':{enabled:false}}));
  await page.getByRole('button', { name: '密码源', exact: true }).click();
  await page.locator('m3e-list-action').filter({ hasText: '连接 MDBX2 保险库' }).click();
  const source = page.locator('.mdbx2-dialog[role="dialog"]');
  await source.getByLabel('显示名称', { exact: true }).fill(sourceName);
  await source.getByLabel('MDBX2 可移植备份', { exact: true }).setInputFiles(fixture);
  await source.getByLabel('保险库密码（可留空）', { exact: true }).fill('Synthetic transfer fixture password');
  await source.getByRole('button', { name: '验证、解锁并导入', exact: true }).click();
  await source.waitFor({ state: 'hidden', timeout: 60000 });
  const summaries = await rpc({ type: 'VAULT_LIST_ITEMS' });
  const originals = await Promise.all(summaries.filter(row => row.kind === 'login').map(row => readItem(page, row.id)));
  let original = originals.find(row => row.passwordGroupId && originals.filter(other => other.passwordGroupId === row.passwordGroupId).length > 1);
  assert.ok(original, 'Expected a synthetic Android password project');
  let members = originals.filter(row => row.passwordGroupId === original.passwordGroupId);
  if (groupRestore) {
    const groups=[randomUUID(),randomUUID()];
    const updated=members.map((row,index)=>({...row,customFields:[...row.customFields,{name:'monica.content.credential',protected:true,
      value:JSON.stringify({version:1,projectId:row.passwordGroupId,groupId:groups[index===2?1:0],passwordId:randomUUID(),
        label:index===2?'Recovery':'Primary',primary:index!==2,groupOrder:index===2?1:0,passwordOrder:index===2?0:index}).replace(/}$/,',"future":9007199254740993}') }]}));
    await rpc({type:'VAULT_SAVE_PASSWORD_GROUP',items:updated,expected:Object.fromEntries(members.map(row=>[row.id,row.updatedAt]))});
    await flush();
    members=await Promise.all(members.map(row=>readItem(page,row.id)));
    original=members[0];
  }
  const records = await Promise.all(members.map(async row => {
    const ref = row.providerRefs.find(ref => ref.remoteId);
    return { original: row, ref, native: await rpc({ type: 'MDBX2_OBJECT_REVEAL', providerId: ref.providerId, objectId: ref.remoteId }) };
  }));
  const ref = original.providerRefs.find(ref => ref.remoteId);
  const nativeBefore = await rpc({ type: 'MDBX2_OBJECT_REVEAL', providerId: ref.providerId, objectId: ref.remoteId });
  await page.getByRole('button', { name: /^全部项目/ }).click();
  await page.getByLabel('搜索密码库', { exact: true }).fill(original.title);
  const card = page.locator('article.item-card').filter({ has: page.getByLabel(`查看${original.title}详情`, { exact: true }) });
  await expect(card).toHaveCount(1);
  page.once('dialog', async dialog => { assert.match(dialog.message(), new RegExp(`${members.length} 条密码移到回收站`)); await dialog.accept(); });
  await card.getByRole('button', { name: '删除登录项', exact: true }).click();
  await expect(card).toHaveCount(0);
  if(groupRestore) {
    await cancelUnsentProjectThroughUi({page,evidence,screenshot,members});
    page.once('dialog',async dialog=>{assert.match(dialog.message(),/条密码移到回收站/);await dialog.accept();});
    await card.getByRole('button',{name:'删除登录项',exact:true}).click();
    await expect(card).toHaveCount(0);
  }
  await flush();
  const trash = await rpc({ type: 'VAULT_LIST_DELETED_ITEMS' });
  const deleted = trash.find(row => row.id === original.id); assert.ok(deleted);
  const nativeDeleted = await rpc({ type: 'MDBX2_OBJECT_LIST', providerId: ref.providerId, collectionId: ref.remoteFolderId, deleted: true, pageSize: 200 });
  for (const record of records) assert.ok(nativeDeleted.items.some(row => row.objectId === record.ref.remoteId && row.deleted));
  await page.getByRole('button', { name: /^回收站/ }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByLabel('搜索密码库', { exact: true }).fill(original.title);
  const restore = page.getByRole('button', { name: `恢复 ${original.title}`, exact: true });
  await expect(restore).toHaveCount(members.length);
  await expect(restore.first()).toBeVisible();
  await screenshot(page, 'native-restore-before-320.png');
  if (groupRestore) await restoreProjectThroughUi({ page, evidence, screenshot, members, ref });
  else for (let remaining = members.length; remaining > 0; remaining--) {
    await restore.first().click();
    await expect(restore).toHaveCount(remaining - 1, { timeout: 30000 });
  }
  const restored = await readItem(page, original.id);
  assert.equal(restored.deletedAt, undefined);
  assert.equal(restored.providerRefs[0].remoteId, ref.remoteId);
  const nativeAfter = await rpc({ type: 'MDBX2_OBJECT_REVEAL', providerId: ref.providerId, objectId: ref.remoteId });
  assert.deepEqual({ ...nativeAfter, headCommitId: nativeBefore.headCommitId }, nativeBefore);
  assert.deepEqual({ ...restored, updatedAt: original.updatedAt, providerRefs: original.providerRefs }, original);
  const restoredMembers = [];
  for (const record of records) {
    const current = await readItem(page, record.original.id);
    assert.deepEqual({ ...current, updatedAt: record.original.updatedAt, providerRefs: record.original.providerRefs }, record.original);
    const native = await rpc({ type: 'MDBX2_OBJECT_REVEAL', providerId: record.ref.providerId, objectId: record.ref.remoteId });
    assert.deepEqual({ ...native, headCommitId: record.native.headCommitId }, record.native);
    restoredMembers.push(current);
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  await flush();
  const final = await readItem(page, original.id);
  assert.deepEqual(final, restored);
  await page.getByLabel('搜索密码库', { exact: true }).fill(original.title);
  await page.getByLabel(`查看${original.title}详情`, { exact: true }).click();
  const detail = page.locator('[role="dialog"][data-item-kind="login"]');
  await expect(detail.getByRole('heading', { name: original.title, exact: true })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  await screenshot(page, 'native-restore-detail-320.png');
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByRole('button', { name: '密码源', exact: true }).click();
  const sourceCard = page.locator('m3e-card[data-home-provider-id]').filter({ has: page.getByRole('heading', { name: sourceName, exact: true }) });
  const downloads = [];
  const onDownload = download => downloads.push(download);
  page.on('download', onDownload);
  assert.match(fixture, /\.mdbx$/i, 'This historical fixture contains missing external Blob references in a standalone database');
  assert.equal((await readFile(fixture)).subarray(0, 16).toString(), 'SQLite format 3\0');
  await sourceCard.getByRole('button', { name: '导出 MDBX2 完整备份', exact: true }).click();
  // This historical standalone input has references but no imported sidecar.
  // Complete export must reject its missing ciphertext; valid attachment archives
  // are exercised by mdbx2-complete-backup-real.spec.ts.
  await expect(page.getByText('完整备份失败：请检查附件是否完整，并确认数据库及附件合计不超过 512 MiB。', { exact: true })).toBeVisible({ timeout: 30000 });
  assert.equal(downloads.length, 0);
  page.off('download', onDownload);
  await screenshot(page, 'native-restore-missing-blobs-export-refused.png');
  await writeFile(join(output, 'edge-restored-project-expected.json'), JSON.stringify({ synthetic: true, originalRecords: records,
    restored: restoredMembers }, null, 2));
  await page.getByRole('button', { name: /^全部项目/ }).click();
  evidence.nativeRestore = { status: 'passed', fixture, inputSha256: createHash('sha256').update(await readFile(fixture)).digest('hex'),
    saved: restoredMembers, completeExportRefusedForMissingBlobs: true, objectId: ref.remoteId, payloadSha256: createHash('sha256').update(nativeBefore.payloadJson).digest('hex'),
    checks: ['real UI deletion', 'confirmed native tombstone', '320px trash restore button', 'original identity and raw payload',
      'all original projected fields', 'ordinary sync after restore', '320px restored detail'], scope: 'Historical Android synthetic input; current Edge/Native restore. Fresh Android return is separate.' };
  if (groupRestore) await stageProjectRestoreForRestart({page,evidence,screenshot,flush,output});
  async function flush() {
    await page.getByRole('button', { name: '密码源', exact: true }).click();
    const sourceCard = page.locator('m3e-card[data-home-provider-id]').filter({ has: page.getByRole('heading', { name: sourceName, exact: true }) });
    const button = sourceCard.getByRole('button', { name: /^(立即同步|重试同步|写入本机副本)$/ });
    await button.click();
    await expect(sourceCard.getByRole('button', { name: '取消同步', exact: true })).toHaveCount(0, { timeout: 60000 });
    await expect(button).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: /^全部项目/ }).click();
  }
}

export async function verifyNativeRestoreUi(page, evidence, screenshot) {
  if (evidence.groupRestore) await resumeProjectRestoreAfterRestart({page,evidence,screenshot});
  for (const item of evidence.nativeRestore.saved) assert.deepEqual(await readItem(page, item.id), item);
  evidence.nativeRestore.restartVerified = true;
}
