import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { expect } from "@playwright/test";
import { saveStandaloneMdbxDownload } from './interop-mdbx-download.mjs';

// Every mutation below is performed by the rendered extension UI. Runtime calls
// are restricted to readback. The only imported file is an explicit synthetic
// fixture, copied by the real Native Host into this run's isolated state.
export async function runFeatureChecks({ page, evidence, screenshot }) {
  evidence.featureChecks = [];
  const snapshots = [];
  let providerName = "Monica 本地库";
  const title = "Edge315 · grouped content";
  let groupedId;
  const fixture = process.env.MONICA_315_MDBX_FIXTURE;
  if (fixture) await check("ui-import-synthetic-mdbx", async () => {
    await page.getByRole("button", { name: "密码源", exact: true }).click();
    await page.locator("m3e-list-action").filter({ hasText: "连接 MDBX2 保险库" }).click();
    const source = page.getByRole("dialog", { name: /MDBX2/ });
    await source.getByLabel("显示名称", { exact: true }).fill("Edge315 synthetic MDBX");
    await source.getByLabel("MDBX2 可移植备份", { exact: true }).setInputFiles(fixture);
    await source.getByLabel("保险库密码（可留空）", { exact: true }).fill(process.env.MONICA_315_MDBX_PASSWORD || "Synthetic transfer fixture password");
    await source.getByRole("button", { name: "验证、解锁并导入", exact: true }).click();
    await source.waitFor({ state: "hidden", timeout: 60000 });
    providerName = "Edge315 synthetic MDBX";
    await screenshot(page, "features-01-mdbx-import.png");
    return { fixture, fixtureSha256: sha256(await readFile(fixture)), existingExternalBlobs: "Not imported by this single-file UI operation; only newly uploaded attachment checks count." };
  });
  else skip("ui-import-synthetic-mdbx", "MONICA_315_MDBX_FIXTURE not supplied; all new records use the isolated local vault.");

  if (fixture) await check("ui-password-bound-note", async () => {
    const listed = await page.evaluate(() => chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));
    assert.equal(listed.ok,true);
    const summary = listed.data.find(item => item.kind === 'secure-note');
    assert.ok(summary);
    const note = await readItem(page,summary.id);
    assert.ok(note.replicaGroupId?.startsWith('note:'));
    const name = 'Edge315 linked note password';
    let editor = await create('PASSWORD',name);
    await editor.getByLabel('用户名',{exact:true}).fill('note-user');
    await chooseOption(editor.getByLabel('选择关联笔记',{exact:true}),note.replicaGroupId);
    await save(editor); await flushNative();
    const [linked] = await itemsNamed(name);
    assert.equal(linked.boundNoteEntryId,note.replicaGroupId);
    assert.equal(linked.boundNoteId,undefined);
    const linkedRef = linked.providerRefs.find(ref => ref.remoteId);
    assert.ok(linkedRef);
    const linkedNative = await page.evaluate(ref => chrome.runtime.sendMessage({type:'MDBX2_OBJECT_REVEAL',providerId:ref.providerId,objectId:ref.remoteId}),linkedRef);
    assert.equal(linkedNative.ok,true);
    assert.equal(JSON.parse(linkedNative.data.payloadJson).bound_note_entry_id,note.replicaGroupId);
    let detail = await openDetail(name);
    await detail.getByRole('button',{name:'查看关联笔记',exact:true}).click();
    const nested = page.locator('[role="dialog"][data-item-kind="secure-note"]');
    await expect(nested.getByRole('heading',{name:note.title,exact:true})).toBeVisible();
    await screenshot(page,'bound-note-detail.png');
    await nested.getByRole('button',{name:'关闭详情',exact:true}).focus();
    await page.keyboard.press('Escape');
    await expect(nested).toHaveCount(0);
    await detail.getByRole('button',{name:'编辑',exact:true}).click();
    editor = loginEditor(page);
    await expect(editor).toBeVisible();
    await screenshot(page,'bound-note-editor-before-unlink.png');
    await editor.getByRole('button',{name:'解除笔记关联',exact:true}).click();
    await screenshot(page,'bound-note-unlink-editor.png');
    await save(editor); await flushNative();
    const removed = await readItem(page,linked.id);
    assert.equal(removed.boundNoteEntryId,undefined); assert.equal(removed.boundNoteId,undefined);
    detail = await openDetail(name);
    await expect(detail.getByRole('button',{name:'查看关联笔记',exact:true})).toHaveCount(0);
    await detail.getByRole('button',{name:'关闭详情',exact:true}).click();
    assert.deepEqual(await readItem(page,note.id),note,'Linked note was modified');
    if (process.env.MONICA_315_KEEP_NOTE_LINK === '1') {
      editor = await edit(name);
      await chooseOption(editor.getByLabel('选择关联笔记',{exact:true}),note.replicaGroupId);
      await save(editor); await flushNative();
      const restored = await readItem(page,linked.id);
      assert.equal(restored.boundNoteEntryId,note.replicaGroupId);
      snapshots.push(restored);
    } else snapshots.push(removed);
    return {noteId:note.id,logicalId:note.replicaGroupId,createLink:true,nativeLinkedIdVerified:true,view:true,nestedEscape:true,unlink:true,noteUnchanged:true};
  });

  if (fixture && process.env.MONICA_315_KEEP_NOTE_LINK === '1') await check("ui-copy-password-bound-note", async () => {
    const name = 'Edge315 linked note password';
    const [source] = await itemsNamed(name);
    assert.ok(source?.boundNoteEntryId, 'Run the bound-note case with KEEP_NOTE_LINK=1');
    const listed = await page.evaluate(() => chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));
    assert.equal(listed.ok,true);
    const notes = await Promise.all(listed.data.filter(item => item.kind === 'secure-note').map(item => readItem(page,item.id)));
    const note = notes.find(item => item.replicaGroupId === source.boundNoteEntryId);
    assert.ok(note);
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    const targetFixture = process.env.MONICA_315_NOTE_COPY_TARGET_FIXTURE;
    let targetProviderId = source.providerRefs[0].providerId;
    if (targetFixture) {
      await page.locator('m3e-list-action').filter({hasText:'连接 MDBX2 保险库'}).click();
      const destination = page.getByRole('dialog',{name:/MDBX2/});
      await destination.getByLabel('显示名称',{exact:true}).fill('Edge315 note copy destination');
      await destination.getByLabel('MDBX2 可移植备份',{exact:true}).setInputFiles(targetFixture);
      await destination.getByLabel('保险库密码（可留空）',{exact:true}).fill('Synthetic transfer fixture password');
      await destination.getByRole('button',{name:'验证、解锁并导入',exact:true}).click();
      await destination.waitFor({state:'hidden',timeout:60000});
      const providers = await page.evaluate(() => chrome.runtime.sendMessage({type:'PROVIDER_LIST'}));
      assert.equal(providers.ok,true);
      targetProviderId = providers.data.find(provider => provider.name === 'Edge315 note copy destination').id;
      assert.notEqual(targetProviderId,source.providerRefs[0].providerId);
    }
    await page.locator(`[data-home-provider-id="${targetProviderId}"]`).getByRole('button',{name:'批量传输',exact:true}).click();
    const dialog = page.getByRole('dialog',{name:'复制或移动项目',exact:true});
    await expect.poll(() => dialog.getByLabel('目标密码源',{exact:true}).evaluate(node => node.value)).toBe(targetProviderId);
    await dialog.getByLabel('筛选项目',{exact:true}).fill(name);
    await dialog.locator('.batch-item-row').filter({hasText:name}).locator('m3e-checkbox').click();
    await dialog.getByRole('button',{name:'检查并生成计划',exact:true}).click();
    await expect(dialog.locator('.batch-plan-row')).toHaveCount(2);
    await expect(dialog.locator('.batch-plan-row.blocked')).toHaveCount(0);
    await expect(dialog.getByText('关联项目 · 自动包含',{exact:true})).toHaveCount(1);
    const folder = dialog.locator('.batch-folder-row').first();
    const tree = dialog.locator('.batch-folder-tree');
    assert.ok((await folder.boundingBox()).width >= (await tree.boundingBox()).width * .95,'Folder row was squeezed beside empty state');
    await dialog.locator('.batch-plan-panel').scrollIntoViewIfNeeded();
    await screenshot(page,'bound-note-copy-plan.png');
    const previousViewport = page.viewportSize();
    await page.setViewportSize({width:420,height:900});
    await dialog.locator('.batch-folder-tree').scrollIntoViewIfNeeded();
    assert.ok((await folder.boundingBox()).width >= (await tree.boundingBox()).width * .95);
    assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1),'Transfer dialog overflows at narrow width');
    await screenshot(page,'bound-note-copy-narrow.png');
    await page.setViewportSize(previousViewport);
    await dialog.getByRole('button',{name:'执行复制',exact:true}).click();
    await expect(dialog.locator('.batch-result-row.result-completed')).toHaveCount(2,{timeout:60000});
    await expect(dialog.locator('.batch-result-row.result-failed')).toHaveCount(0);
    await screenshot(page,'bound-note-copy-result.png');
    await dialog.getByRole('button',{name:'关闭批量传输',exact:true}).click();
    const copies = await itemsNamed(name);
    assert.equal(copies.length,2);
    const copied = copies.find(item => item.id !== source.id);
    assert.equal(copied.providerRefs[0].providerId,targetProviderId);
    assert.ok(copied.boundNoteEntryId);
    assert.notEqual(copied.boundNoteEntryId,source.boundNoteEntryId);
    const afterList = await page.evaluate(() => chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));
    const afterNotes = await Promise.all(afterList.data.filter(item => item.kind === 'secure-note').map(item => readItem(page,item.id)));
    const copiedNote = afterNotes.find(item => item.replicaGroupId === copied.boundNoteEntryId);
    assert.ok(copiedNote); assert.notEqual(copiedNote.id,note.id);
    assert.equal(copiedNote.providerRefs[0].providerId,targetProviderId);
    assert.equal(copiedNote.content,note.content);
    for (const item of [copied,copiedNote]) {
      const ref = item.providerRefs.find(ref => ref.remoteId);
      const result = await page.evaluate(ref => chrome.runtime.sendMessage({type:'MDBX2_OBJECT_REVEAL',providerId:ref.providerId,objectId:ref.remoteId}),ref);
      assert.equal(result.ok,true);
      const payload = JSON.parse(result.data.payloadJson);
      if(item.kind === 'login') assert.equal(payload.bound_note_entry_id,copiedNote.replicaGroupId);
      else assert.equal(payload.monica_entry_id,copied.boundNoteEntryId);
    }
    assert.deepEqual(await readItem(page,source.id),source);
    assert.deepEqual(await readItem(page,note.id),note);
    snapshots.push(copied,copiedNote);
    return {sourceId:source.id,sourceNoteId:note.id,copiedId:copied.id,copiedNoteId:copiedNote.id,copiedNoteLogicalId:copied.boundNoteEntryId,
      sourceProviderId:source.providerRefs[0].providerId,targetProviderId,crossVault:Boolean(targetFixture),targetFixture,
      targetFixtureSha256:targetFixture ? sha256(await readFile(targetFixture)) : undefined,nativeReferenceVerified:true,sourceUnchanged:true};
  });

  if (fixture) await check("ui-wallet-visible-card-face", async () => {
    const name = "Edge315 travel card";
    let editor = await create("card", name);
    await fill(editor, { "银行卡号 *": "4242424242424242", "持卡人": "LIN CHEN" });
    await save(editor); await flushNative();
    const [created] = await itemsNamed(name);
    assert.ok(created);
    const showTile = async () => {
      await page.getByRole("button", { name: /^钱包与身份/ }).click();
      await page.getByLabel("搜索密码库", { exact: true }).fill(name);
      return page.locator(`m3e-card[data-item-id="${created.id}"]`);
    };
    let tile = await showTile();
    await expect(tile.locator('.wallet-card-identifier')).toContainText('4242');
    await expect(tile).not.toContainText('4242424242424242');
    await tile.getByRole('button', {name: `${name}的更多操作`, exact:true}).click();
    await page.getByRole('menuitem', {name:'附件',exact:true}).click();
    const attachments = page.locator('[role="dialog"]').filter({has:page.getByRole('heading',{name:`附件 · ${name}`,exact:true})});
    const chooser = page.waitForEvent('filechooser');
    await attachments.getByRole('button',{name:'添加附件',exact:true}).click();
    await (await chooser).setFiles({name:'travel-card.png',mimeType:'image/png',buffer:syntheticPng()});
    await expect(attachments.getByText('travel-card.png 已添加。',{exact:true})).toBeVisible({timeout:30000});
    await attachments.getByRole('button',{name:'关闭附件管理',exact:true}).click();
    await tile.getByLabel(`查看${name}详情`,{exact:true}).click();
    let detail = page.locator('[role="dialog"][data-item-kind="card"]');
    await detail.getByRole('button',{name:'编辑',exact:true}).click();
    editor = itemEditor(page);
    await editor.getByLabel('使用卡面图片',{exact:true}).check();
    await chooseOption(editor.getByLabel('卡面图片',{exact:true}),'travel-card.png');
    await expect.poll(()=>editor.locator('.wallet-card-face img').evaluateAll(images=>images[0]?.naturalWidth || 0)).toBe(2);
    await editor.getByRole('button',{name:'管理图片附件',exact:true}).click();
    const nestedAttachments = page.locator('.provider-attachments-dialog');
    const nestedChooser = page.waitForEvent('filechooser');
    await nestedAttachments.getByRole('button',{name:'添加附件',exact:true}).click();
    await (await nestedChooser).setFiles({name:'alternate-card.png',mimeType:'image/png',buffer:syntheticPng()});
    await expect(nestedAttachments.getByText('alternate-card.png 已添加。',{exact:true})).toBeVisible({timeout:30000});
    await nestedAttachments.getByRole('button',{name:'关闭附件管理',exact:true}).click();
    try { await expect.poll(() => editor.getByLabel('卡面图片',{exact:true}).locator('m3e-option').evaluateAll(nodes => nodes.some(node => node.value === 'alternate-card.png'))).toBe(true); }
    catch (error) {
      evidence.walletPickerDiagnostics = await page.evaluate(async item => ({attachments: await chrome.runtime.sendMessage({type:'PROVIDER_ATTACHMENT_LIST',providerId:item.providerRefs[0].providerId,itemId:item.id,pageSize:50}), options:[...document.querySelectorAll('.card-face-picker m3e-option')].map(node=>({value:node.value,text:node.textContent})),alerts:[...document.querySelectorAll('.card-face-picker p')].map(node=>node.textContent)}),created);
      throw error;
    }
    await editor.getByRole('button',{name:'管理图片附件',exact:true}).click();
    await nestedAttachments.getByRole('button',{name:'关闭附件管理',exact:true}).focus();
    await page.keyboard.press('Escape');
    await expect(nestedAttachments).toHaveCount(0);
    await expect(editor).toBeVisible();
    await expect.poll(() => editor.getByLabel('卡面图片',{exact:true}).locator('m3e-option').evaluateAll(nodes => nodes.some(node => node.value === 'alternate-card.png'))).toBe(true);
    await chooseOption(editor.getByLabel('卡面图片',{exact:true}),'alternate-card.png');
    await chooseOption(editor.getByLabel('卡面图片',{exact:true}),'');
    await expect(editor.locator('.wallet-card-face img')).toHaveCount(0);
    await chooseOption(editor.getByLabel('卡面图片',{exact:true}),'alternate-card.png');
    await expect.poll(()=>editor.locator('.wallet-card-face img').evaluateAll(images=>images[0]?.naturalWidth || 0)).toBe(2);
    await editor.getByLabel('卡面图片',{exact:true}).scrollIntoViewIfNeeded();
    await screenshot(page,'walletface-editor-all.png');
    await save(editor); await flushNative();
    for (const mode of ['ALL','CARD_NUMBER_ONLY','HIDDEN']) {
      tile = await showTile();
      await tile.getByLabel(`查看${name}详情`,{exact:true}).click();
      detail = page.locator('[role="dialog"][data-item-kind="card"]');
      await detail.getByRole('button',{name:'编辑',exact:true}).click();
      editor = itemEditor(page);
      await chooseOption(editor.getByLabel('卡面显示模式',{exact:true}),mode);
      await save(editor); await flushNative();
      tile = await showTile();
      const face = tile.locator('.wallet-card-face');
      await expect(face).toHaveAttribute('data-display-mode',mode);
      await expect.poll(()=>face.locator('img').evaluateAll(images=>images[0]?.naturalWidth || 0)).toBe(2);
      await expect(face.locator('.wallet-card-identifier')).toHaveCount(mode==='HIDDEN'?0:1);
      await expect(face.locator('header')).toHaveCount(mode==='ALL'?1:0);
      await screenshot(page,`walletface-list-${mode}.png`);
      await tile.getByLabel(`查看${name}详情`,{exact:true}).click();
      detail = page.locator('[role="dialog"][data-item-kind="card"]');
      await expect(detail.locator('.wallet-card-face')).toHaveAttribute('data-display-mode',mode);
      await expect.poll(()=>detail.locator('.wallet-card-face img').evaluateAll(images=>images[0]?.naturalWidth || 0)).toBe(2);
      await screenshot(page,`walletface-detail-${mode}.png`);
      await detail.getByRole('button',{name:'关闭详情',exact:true}).click();
    }
    await page.setViewportSize({width:420,height:860});
    await screenshot(page,'walletface-list-narrow.png');
    assert.equal(await tile.evaluate(node=>node.getBoundingClientRect().right>innerWidth+1),false);
    await page.setViewportSize({width:1280,height:860});
    await page.getByLabel('搜索密码库',{exact:true}).fill('');
    const kinds = page.getByRole('group',{name:'项目类型',exact:true});
    await kinds.getByRole('button',{name:'证件',exact:true}).click();
    await expect(page.locator('.vault-tile--card')).toHaveCount(0);
    await expect(page.locator('.vault-tile--identity').first()).toBeVisible();
    await kinds.getByRole('button',{name:'全部类型',exact:true}).click();
    await screenshot(page,'walletface-mixed-wallet.png');
    snapshots.push(await readItem(page,created.id));
    return {modes:['ALL','CARD_NUMBER_ONLY','HIDDEN'], actualNativeAttachment:true, listDetailEditor:true, imageWidth:2};
  });

  if (fixture) await check("ui-android-content-drag-keyboard-unknown-preservation", async () => {
    const listed = await page.evaluate(() => chrome.runtime.sendMessage({type:"VAULT_LIST_ITEMS"}));
    assert.equal(listed.ok,true);
    let original;
    for (const summary of listed.data.filter(item=>item.title.endsWith('-group'))) {
      const item = await readItem(page,summary.id);
      if(item.customFields.some(field=>field.name==='monica.content.order' && field.value.split(',').includes('FUTURE'))) { original=item; break; }
    }
    assert.ok(original,'Actual Android fixture with unknown order marker is required');
    let detail = await openDetail(original.title);
    await detail.locator(`[data-password-member-id="${original.id}"]`).click();
    await detail.getByRole('button',{name:'编辑',exact:true}).click();
    const editor=loginEditor(page);
    await expand(editor,'内容顺序');
    const list=editor.locator('.content-order-list');
    const order=()=>list.locator('[data-order-token]').evaluateAll(rows=>rows.map(row=>row.dataset.orderToken));
    const before=await order();
    const handle=list.locator('[data-order-token="FUTURE"] .content-drag-handle');
    const destination=list.locator('[data-order-token="NOTES"]');
    await handle.scrollIntoViewIfNeeded();
    const from=await handle.boundingBox(), to=await destination.boundingBox();
    assert.ok(from && to);
    const drag=async()=>{await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+20,to.y+8,{steps:12});};
    await drag(); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await order(),before,'Escape changed the order');
    await drag(); await page.mouse.up();
    await expect.poll(async()=> (await order())[0]).toBe('FUTURE');
    await handle.focus(); await page.keyboard.press('ArrowDown');
    await expect.poll(async()=> (await order())[1]).toBe('FUTURE');
    const expected=await order();
    await screenshot(page,'features-content-pointer-order.png');
    await save(editor);
    const saved=await readItem(page,original.id);
    assert.equal(saved.customFields.find(field=>field.name==='monica.content.order').value,expected.join(','));
    assert.deepEqual(saved.customFields.filter(field=>field.name!=='monica.content.order'),original.customFields.filter(field=>field.name!=='monica.content.order'));
    detail = await openDetail(saved.title);
    await detail.locator(`[data-password-member-id="${saved.id}"]`).click();
    const futureSection = detail.locator('.detail-section').filter({has:page.getByRole('heading',{name:'未知内容 FUTURE',exact:true})});
    await expect(futureSection).toHaveCSS('order',String(expected.indexOf('FUTURE')));
    await screenshot(page,'features-content-ordered-detail.png');
    await detail.getByRole('button',{name:'关闭详情',exact:true}).click();
    snapshots.push(saved);
    return {id:saved.id,source:'actual Android application fixture',pointer:true,keyboard:true,escapePreserved:true,unknownMarkerPreserved:true,allOtherFieldsExact:true};
  });

  await check("ui-group-member-detach-cancel-confirm", async () => {
    const itemTitle = "Edge315 · detachable group";
    const editor = await create("PASSWORD", itemTitle);
    await fill(editor, { "用户名": "detach-primary", "密码": "synthetic-primary", "恢复备注与笔记": "Preserve this member content" });
    await editor.getByRole("button", { name: "添加另一个账号", exact: true }).click();
    await fill(editor, { "账号 2": "detach-secondary", "密码 2": "synthetic-secondary" });
    await save(editor);
    if (providerName !== "Monica 本地库") await flushNative();
    const before = await itemsNamed(itemTitle);
    let detail = await openDetail(itemTitle);
    await detail.getByRole("button", { name: "detach-primary", exact: true }).click();
    await detail.getByRole("button", { name: "拆分为独立密码", exact: true }).click();
    let confirm = page.getByRole("dialog", { name: "拆分为独立密码？", exact: true });
    await confirm.getByRole("button", { name: "取消", exact: true }).click();
    assert.deepEqual(await itemsNamed(itemTitle), before);
    await detail.getByRole("button", { name: "拆分为独立密码", exact: true }).click();
    confirm = page.getByRole("dialog", { name: "拆分为独立密码？", exact: true });
    await screenshot(page, "features-group-detach-confirm.png");
    await confirm.getByRole("button", { name: "确认拆分", exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    const after = await itemsNamed(itemTitle);
    const selected = after.find(item=>item.username==='detach-primary');
    const original = before.find(item=>item.id===selected.id);
    assert.equal(selected.passwordGroupId, undefined);
    for(const key of ['id','password','username','notes','customFields','totpSecret','passkeyBindings','createdAt']) assert.deepEqual(selected[key],original[key]);
    assert.deepEqual(after.find(item=>item.username==='detach-secondary'),before.find(item=>item.username==='detach-secondary'));
    await expect(detail.getByRole("button", { name: "拆分为独立密码", exact: true })).toHaveCount(0);
    await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
    await expect(page.getByLabel(`查看${itemTitle}详情`, { exact: true })).toHaveCount(2);
    snapshots.push(...after);
    return { selectedId: selected.id, allIdsPreserved: true, memberCount: after.length, cancelPreserved: true, otherMemberUnchanged: true };
  });

  await check("ui-wifi-advanced-create-edit-preserve", async () => {
    const itemTitle = "Edge315 · Enterprise Wi-Fi";
    let editor = await create("WIFI", itemTitle);
    await expand(editor, "更多网络设置");
    await expand(editor, "Android 原始元数据");
    await editor.getByLabel("JSON", { exact: true }).fill('{"ssid":"Synthetic Enterprise","future":9007199254740993,"proxy":{"kind":"takagi.ru.monica.data.model.WifiProxy.None","futureProxy":true}}');
    await editor.getByRole("button", { name: "应用原始元数据", exact: true }).click();
    await chooseOption(editor.getByLabel("安全类型", { exact: true }), "WPA2_ENTERPRISE");
    await chooseOption(editor.getByLabel("EAP 方法", { exact: true }), "TTLS");
    await chooseOption(editor.getByLabel("第二阶段认证", { exact: true }), "PAP");
    await fill(editor, { "匿名身份": "0007", "CA 证书": "Synthetic CA", "域名": "example.test" });
    await chooseOption(editor.getByLabel("MAC 随机化", { exact: true }), "DEVICE_MAC");
    await chooseOption(editor.getByLabel("代理设置", { exact: true }), "Manual");
    await fill(editor, { "代理主机": "proxy.example.test", "代理端口": "8080", "绕过代理的地址": "localhost" });
    await chooseOption(editor.getByLabel("IP 设置", { exact: true }), "Static");
    await fill(editor, { "IP 地址": "192.0.2.7", "网关": "192.0.2.1", "DNS 1": "192.0.2.2", "DNS 2": "192.0.2.3", "网络前缀长度": "24" });
    await page.setViewportSize({ width: 420, height: 860 });
    await editor.getByLabel("代理主机", { exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, "features-wifi-network-narrow.png");
    await expect(editor.getByRole("button", { name: "加密保存", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 860 });
    await save(editor);
    let [item] = await itemsNamed(itemTitle);
    let wifi = JSON.parse(item.wifiMetadata);
    assert.equal(wifi.eap.method, "TTLS"); assert.equal(wifi.eap.anonymousIdentity, "0007");
    assert.equal(wifi.proxy.kind, "takagi.ru.monica.data.model.WifiProxy.Manual");
    assert.equal(wifi.proxy.port, 8080); assert.equal(wifi.ip.dns2, "192.0.2.3");
    assert.match(item.wifiMetadata, /"future":9007199254740993/);
    const detail = await openDetail(itemTitle);
    await expand(detail, "更多信息");
    await expect(detail.getByText("proxy.example.test", { exact: true })).toBeVisible();
    await expect(detail.getByText("192.0.2.3", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "编辑", exact: true }).click();
    editor = loginEditor(page);
    await expand(editor, "更多网络设置");
    await expect(editor.getByLabel("CA 证书", { exact: true })).toHaveValue("Synthetic CA");
    await chooseOption(editor.getByLabel("代理设置", { exact: true }), "AutoConfig");
    await editor.getByLabel("PAC 地址", { exact: true }).fill("https://example.test/proxy.pac");
    await chooseOption(editor.getByLabel("IP 设置", { exact: true }), "Dhcp");
    await save(editor);
    [item] = await itemsNamed(itemTitle); wifi = JSON.parse(item.wifiMetadata);
    assert.equal(wifi.proxy.kind, "takagi.ru.monica.data.model.WifiProxy.AutoConfig");
    assert.equal(wifi.proxy.pacUrl, "https://example.test/proxy.pac");
    assert.equal(wifi.proxy.futureProxy, true); assert.equal(wifi.proxy.host, undefined);
    assert.equal(wifi.ip.kind, "takagi.ru.monica.data.model.WifiIp.Dhcp");
    assert.equal(wifi.ip.ipAddress, undefined); assert.match(item.wifiMetadata, /"future":9007199254740993/);
    snapshots.push(item);
    return { id: item.id, enterprise: true, manualAndPac: true, staticAndDhcp: true, unknownFieldsPreserved: true };
  });

  await check("ui-application-binding-create-edit-clear", async () => {
    const itemTitle = "Edge315 · Android application";
    let editor = await create("PASSWORD", itemTitle);
    await expand(editor, "关联应用");
    await fill(editor, { "应用名称": "Synthetic App", "应用包名": "com.example.synthetic" });
    await page.setViewportSize({ width: 420, height: 860 });
    await editor.getByLabel("应用包名", { exact: true }).scrollIntoViewIfNeeded();
    await screenshot(page, "features-application-narrow.png");
    await page.setViewportSize({ width: 1280, height: 860 });
    await save(editor);
    let [item] = await itemsNamed(itemTitle);
    assert.equal(item.appName, "Synthetic App");
    assert.equal(item.appPackageName, "com.example.synthetic");
    let detail = await openDetail(itemTitle);
    await expand(detail, "更多信息");
    await expect(detail.getByText("Synthetic App", { exact: true })).toBeVisible();
    await expect(detail.getByText("com.example.synthetic", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "编辑", exact: true }).click();
    editor = loginEditor(page);
    await expand(editor, "关联应用");
    await expect(editor.getByLabel("应用名称", { exact: true })).toHaveValue("Synthetic App");
    await fill(editor, { "应用名称": "Renamed App", "应用包名": "" });
    await save(editor);
    [item] = await itemsNamed(itemTitle);
    assert.equal(item.appName, "Renamed App");
    assert.equal(item.appPackageName, "");
    editor = await edit(itemTitle);
    await editor.getByLabel("恢复备注与笔记", { exact: true }).fill("Unrelated edit preserves app name");
    await save(editor);
    [item] = await itemsNamed(itemTitle);
    assert.equal(item.appName, "Renamed App");
    assert.equal(item.appPackageName, "");
    snapshots.push(item);
    return { id: item.id, created: true, edited: true, cleared: true, unrelatedEditPreserved: true };
  });

  await check("ui-independent-identical-titles", async () => {
    for (const username of ["independent-a", "independent-b"]) {
      const editor = await create("PASSWORD", "Edge315 · same title");
      await editor.getByLabel("用户名", { exact: true }).fill(username);
      await editor.getByLabel("密码", { exact: true }).fill(`Synthetic-${username}-password`);
      await save(editor);
    }
    const items = await itemsNamed("Edge315 · same title");
    assert.equal(items.length, 2);
    assert.equal(new Set(items.map(item => item.id)).size, 2);
    for (const item of items) assert.ok(!item.passwordGroupId);
    await page.getByLabel("搜索密码库", { exact: true }).fill("Edge315 · same title");
    await expect(page.getByLabel("查看Edge315 · same title详情", { exact: true })).toHaveCount(2);
    await screenshot(page, "features-02-independent-identical-titles.png");
    for (const item of items) snapshots.push(item);
    return { count: items.length, ids: items.map(item => item.id) };
  });

  await check("ui-explicit-group-otp-passkey-notes", async () => {
    const editor = await create("PASSWORD", title);
    await editor.getByLabel("用户名", { exact: true }).fill("group-primary");
    await editor.getByLabel("密码", { exact: true }).fill("Synthetic-group-primary-password");
    await editor.getByRole("button", { name: "添加另一个账号", exact: true }).click();
    await editor.getByLabel("账号 2", { exact: true }).fill("group-secondary");
    await editor.getByLabel("密码 2", { exact: true }).fill("Synthetic-group-secondary-password");
    await expand(editor, "两步验证");
    await editor.getByLabel("内嵌验证码密钥", { exact: true }).fill("JBSWY3DPEHPK3PXP");
    await editor.getByRole("button", { name: "添加绑定元数据", exact: true }).click();
    await editor.getByRole("button", { name: "编辑绑定元数据", exact: true }).click();
    await fill(editor, { "凭据 ID": "synthetic-edge315-credential", "网站域名（RP ID）": "edge315.synthetic.invalid", "网站名称": "Synthetic Edge 315", "账号": "group-primary", "显示名称": "Synthetic User" });
    await editor.getByRole("button", { name: "保存绑定草稿", exact: true }).click();
    await editor.getByLabel("恢复备注与笔记", { exact: true }).fill("Recovery note\n  preserve indentation  \n🔑 synthetic");
    await screenshot(page, "features-03-coexisting-editor.png");
    await save(editor);
    const items = await itemsNamed(title);
    assert.equal(items.length, 2);
    assert.ok(items[0].passwordGroupId);
    assert.equal(items[0].passwordGroupId, items[1].passwordGroupId);
    const primary = items.find(item => item.username === "group-primary");
    assert.ok(primary);
    groupedId = primary.id;
    assert.equal(primary.totpSecret, "JBSWY3DPEHPK3PXP");
    assert.match(primary.passkeyBindings, /synthetic-edge315-credential/);
    assert.match(primary.notes, /preserve indentation/);
    const detail = await openDetail(title);
    await expect(detail.getByRole("heading", { name: "同一项目 · 2 个账号", exact: true })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Passkey 绑定", exact: true })).toBeVisible();
    await expect(detail.getByText(/这里只管理绑定元数据，不创建签名凭据/)).toBeVisible();
    await screenshot(page, "features-04-coexisting-detail.png");
    await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
    return { ids: items.map(item => item.id), passwordGroupId: primary.passwordGroupId, passkeyCapability: "binding metadata only; no signing credential created" };
  });

  for (const [kind, label, fields] of [
    ["GPG_KEY", "GPG", { "GPG 私钥": "SYNTHETIC PRIVATE KEY\nsecond line", "GPG 公钥": "SYNTHETIC PUBLIC KEY", "指纹": "SYNTHETIC-FINGERPRINT", "用户身份": "Synthetic User <synthetic@example.invalid>" }],
    ["API_KEY", "API Key", { "API Key": "synthetic-edge315-api-key", "API 地址": "https://edge315.synthetic.invalid/api" }]
  ]) await check(`ui-create-edit-${kind.toLowerCase()}`, async () => {
    const itemTitle = `Edge315 · ${label}`;
    let editor = await create(kind, itemTitle);
    await fill(editor, fields);
    await save(editor);
    let [item] = await itemsNamed(itemTitle);
    assert.equal(item.loginType, kind);
    const detail = await openDetail(itemTitle);
    await screenshot(page, `features-${kind.toLowerCase()}-detail.png`);
    await detail.getByRole("button", { name: "编辑", exact: true }).click();
    editor = loginEditor(page);
    for (const [name, value] of Object.entries(fields)) await expect(editor.getByLabel(name, { exact: true })).toHaveValue(value);
    await editor.getByLabel("恢复备注与笔记", { exact: true }).fill("Edited in actual Edge UI");
    await save(editor);
    [item] = await itemsNamed(itemTitle);
    assert.equal(item.loginType, kind);
    assert.equal(item.notes, "Edited in actual Edge UI");
    snapshots.push(item);
    return { id: item.id, kind, passwordSha256: sha256(item.password) };
  });

  if (groupedId) await check("ui-content-blocks-order-create-edit", async () => {
    let editor = await edit(title);
    for (const [kind, values] of [
      ["API_KEY", { Key: "synthetic-block-key", "服务地址": "https://synthetic.invalid/key", "备注": "key notes" }],
      ["API_TOKEN", { "服务商": "Synthetic", "API 地址": "https://synthetic.invalid/token", Token: "synthetic-block-token", "备注": "token notes" }],
      ["GPG_KEY", { "公钥": "synthetic-public", "私钥": "synthetic-private", "指纹": "fingerprint", "用户身份": "Synthetic User", "备注": "GPG notes" }],
      ["SSH_KEY", { "算法": "ed25519", "密钥位数": "256", "格式": "OpenSSH", "OpenSSH 公钥": "ssh-ed25519 synthetic", "OpenSSH 私钥": "synthetic-private-ssh", "SHA-256 指纹": "SHA256:synthetic", "注释": "synthetic", "备注": "SSH notes" }],
      ["QR_CODE", { "二维码内容": "https://synthetic.invalid/%ACCOUNT%", "二维码模式": "template", "模板版本": "1", "备注": "QR notes" }]
    ]) {
      progress(`${kind}: select`);
      await chooseOption(editor.getByLabel("添加内容类型", { exact: true }), kind);
      progress(`${kind}: open`);
      await editor.getByRole("button", { name: "添加内容", exact: true }).click();
      const sheet = page.locator(".content-sheet");
      progress(`${kind}: fill`);
      await sheet.getByLabel("内容名称", { exact: true }).fill(`Edge315 block ${kind}`);
      await fill(sheet, values);
      progress(`${kind}: save draft`);
      await sheet.getByRole("button", { name: "保存内容草稿", exact: true }).click();
      await sheet.waitFor({ state: "hidden" });
      progress(`${kind}: saved draft`);
    }
    await expand(editor, "内容顺序");
    await editor.getByRole("button", { name: "上移Edge315 block QR_CODE", exact: true }).click();
    await screenshot(page, "features-05-content-editor-order.png");
    await save(editor);
    progress("content parent saved; validating multipart hashes");
    let item = await readItem(page, groupedId);
    const blocks = decodeBlocks(item.customFields);
    assert.equal(blocks.length, 5);
    const qr = blocks.find(block => block.kind === "QR_CODE");
    assert.equal(qr.data.mode, "template");
    const order = item.customFields.find(field => field.name === "monica.content.order").value;
    assert.ok(order.indexOf(`BLOCK:${qr.id}`) < order.indexOf(`BLOCK:${blocks.find(block => block.kind === "SSH_KEY").id}`));
    editor = await edit(title);
    const blockSection = editor.locator("section.content-entry").filter({ has: page.getByRole("heading", { name: "Edge315 block API_KEY", exact: true }) });
    await blockSection.getByRole("button", { name: "编辑内容", exact: true }).click();
    await page.locator(".content-sheet").getByLabel("Key", { exact: true }).fill("synthetic-block-key-edited");
    await page.locator(".content-sheet").getByRole("button", { name: "保存内容草稿", exact: true }).click();
    await save(editor);
    progress("API block edited; opening detail QR");
    item = await readItem(page, groupedId);
    assert.equal(decodeBlocks(item.customFields).find(block => block.kind === "API_KEY").data.key, "synthetic-block-key-edited");
    const detail = await openDetail(title);
    await expect(detail.getByRole("heading", { name: "Edge315 block API_KEY", exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "查看二维码", exact: true }).click();
    await expect(page.getByRole("img", { name: "项目内容二维码", exact: true })).toBeVisible();
    await screenshot(page, "features-06-content-detail-qr.png");
    progress("QR screenshot captured; closing QR");
    await page.getByRole("button", { name: "关闭二维码", exact: true }).click();
    progress("QR closed; closing detail");
    await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
    return { contentKinds: blocks.map(block => block.kind), order };
  });
  else skip("ui-content-blocks-order-create-edit", "Explicit group prerequisite failed.");

  if (groupedId) await check("ui-full-card-and-note-copies", async () => {
    const editor = await edit(title);
    await expand(editor, "添加完整副本");
    await editor.getByRole("button", { name: "银行卡副本", exact: true }).click();
    let copy = itemEditor(page);
    await fill(copy, { "名称 *": "Edge315 full card copy", "持卡人": "Synthetic User", "卡组织": "Visa", "银行卡号 *": "0000424242424242", "到期月": "09", "到期年": "2030", "安全码": "007" });
    await expand(copy, "更多银行卡信息");
    await chooseOption(copy.getByLabel("卡类型", { exact: true }), "PREPAID");
    await fill(copy, { "银行": "Synthetic Bank", "昵称": "Synthetic card", PIN: "0007", "生效月": "01", "生效年": "2025", IBAN: "GB00SYNTHETIC001", "SWIFT/BIC": "SYNTHETIC", "路由号码": "000001", "账户号码": "000002", "分行代码": "0003", "币种": "CNY", "客服电话": "+86-000000000" });
    const billing = copy.getByRole("region", { name: "账单地址", exact: true });
    await fill(billing, { "街道地址": "  Synthetic Street  ", "公寓/单元": "007", "城市": "Synthetic City", "省/州": "Synthetic Province", "邮编": "000001", "国家/地区": "CN" });
    await expand(billing, "原始格式与附加信息");
    const billingSource = await billing.getByLabel("账单地址 JSON", { exact: true }).inputValue();
    await billing.getByLabel("账单地址 JSON", { exact: true }).fill(billingSource.slice(0, -1) + ',"future":{"exact":9007199254740993,"null":null,"empty":""}}');
    await billing.getByLabel("城市", { exact: true }).fill("Synthetic City Edited");
    await copy.getByLabel("备注", { exact: true }).fill("Full card wrapper notes");
    await screenshot(page, "features-07-full-card-copy-editor.png");
    await save(copy);
    await editor.getByRole("button", { name: "完整笔记副本", exact: true }).click();
    copy = itemEditor(page);
    await fill(copy, { "名称 *": "Edge315 full note copy", "笔记内容 *": "# Full note\n\n  keep spaces  \n🔑", "标签": "synthetic, Edge315", "备注": "Full note wrapper notes" });
    await copy.getByRole("checkbox", { name: "使用 Markdown", exact: true }).click();
    await save(copy);
    await save(editor);
    const item = await readItem(page, groupedId);
    const card = wallet(item, "bank_card");
    assert.equal(card.data.cardNumber, "0000424242424242");
    assert.equal(card.data.pin, "0007");
    assert.equal(card.data.cardType, "PREPAID");
    assert.equal(card.data.accountNumber, "000002");
    assert.match(card.data.billingAddress, /"exact":9007199254740993/);
    assert.match(card.data.billingAddress, /"null":null/);
    assert.equal(JSON.parse(card.data.billingAddress).city, "Synthetic City Edited");
    assert.equal(JSON.parse(card.data.billingAddress).streetAddress, "  Synthetic Street  ");
    assert.equal(card.notes, "Full card wrapper notes");
    const note = wallet(item, "note");
    assert.equal(note.data.content, "# Full note\n\n  keep spaces  \n🔑");
    assert.equal(note.notes, "Full note wrapper notes");
    assert.equal(note.data.isMarkdown, true);
    const detail = await openDetail(title);
    const cardSection = detail.locator("section.detail-section").filter({ has: page.getByRole("heading", { name: "Edge315 full card copy", exact: true }) });
    await cardSection.getByRole("button", { name: "查看完整副本", exact: true }).click();
    const cardDetail = page.locator('[role="dialog"][data-item-kind="card"]');
    await expect(cardDetail.getByRole("heading", { name: "Edge315 full card copy", exact: true })).toBeVisible();
    await screenshot(page, "features-08-full-card-copy-detail.png");
    await cardDetail.getByRole("button", { name: "关闭详情", exact: true }).click();
    await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
    return { cardFields: Object.keys(card.data), noteFields: Object.keys(note.data) };
  });
  else skip("ui-full-card-and-note-copies", "Explicit group prerequisite failed.");

  if (groupedId && providerName !== "Monica 本地库") await check("ui-wallet-cardface-and-attachment-bytes", async () => {
    await flushNative();
    const editor = await edit(title);
    const section = editor.locator("section.content-entry").filter({ has: page.getByRole("heading", { name: "Edge315 full card copy", exact: true }) });
    await expand(section, "添加副本附件或卡面");
    await chooseOption(section.getByLabel("副本附件用途", { exact: true }), "CARD_FACE");
    const png = syntheticPng();
    await section.getByLabel("选择副本附件", { exact: true }).setInputFiles({ name: "synthetic-cardface.png", mimeType: "image/png", buffer: png });
    page.once("dialog", dialog => dialog.accept());
    await section.getByRole("button", { name: "上传副本附件", exact: true }).click();
    await expect(section.getByText("附件已上传并校验。请保存整个项目以提交副本引用。", { exact: true })).toBeVisible({ timeout: 30000 });
    await save(editor);
    await flushNative();
    const item = await readItem(page, groupedId);
    const card = wallet(item, "bank_card");
    const asset = card.assets.find(asset => asset.displayName === "synthetic-cardface.png");
    assert.equal(asset.sha256, sha256(png));
    assert.equal(asset.size, png.length);
    assert.equal(card.data.cardFace.imageAttachmentName, asset.name);
    const detail = await openDetail(title);
    await detail.getByRole("button", { name: "synthetic-cardface.png", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "附件预览", exact: true });
    const img = preview.getByRole("img", { name: "synthetic-cardface.png", exact: true });
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate(node => node.naturalWidth)).toBe(2);
    const download = await Promise.all([page.waitForEvent("download"), preview.getByRole("link", { name: "下载已校验附件", exact: true }).click()]);
    assert.equal(sha256(await readFile(await download[0].path())), sha256(png));
    await screenshot(page, "features-09-native-cardface-preview.png");
    await preview.getByRole("button", { name: "关闭附件", exact: true }).click();
    await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
    return { attachmentSha256: asset.sha256, bytes: png.length, backend: "actual Native Messaging MDBX2", existingAndroidBlobCoverage: false };
  });
  else skip("ui-wallet-cardface-and-attachment-bytes", "A successful synthetic MDBX import and explicit group are required.");

  if (groupedId) {
    const grouped = await readItem(page, groupedId);
    snapshots.push(grouped);
    await check("ui-edit-cancel-preserves-all-fields", async () => {
      const before = await readItem(page, groupedId);
      const editor = await edit(title);
      await editor.getByLabel("名称 *", { exact: true }).fill("Synthetic cancelled name");
      await editor.getByLabel("恢复备注与笔记", { exact: true }).fill("Synthetic cancelled notes");
      await editor.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(payloadHash(await readItem(page, groupedId)), payloadHash(before));
    });
  }
  if (providerName !== "Monica 本地库") await check("ui-flush-and-native-readback", async () => {
    await flushNative();
    const records = [];
    for (const snapshot of snapshots) {
      try {
      const item = await readItem(page, snapshot.id);
      const reference = item.providerRefs.find(reference => reference.remoteId);
      assert.ok(reference?.remoteId && reference.revision, `An encrypted cache item is not proof of a Native commit: ${item.title} ${item.id} ${JSON.stringify(item.providerRefs)}`);
      const revealed = await page.evaluate(request => chrome.runtime.sendMessage(request), { type: "MDBX2_OBJECT_REVEAL", providerId: reference.providerId, objectId: reference.remoteId });
      assert.equal(revealed.ok, true, JSON.stringify(revealed));
      assert.equal(revealed.data.title, item.title);
      assert.equal(revealed.data.headCommitId, reference.revision);
      const payload = JSON.parse(revealed.data.payloadJson);
      if (item.kind === "login") {
        assert.equal(payload.username, item.username);
        assert.equal(payload.password_plain ?? payload.password, item.password);
        assert.equal(payload.password_group_id || undefined, item.passwordGroupId || undefined);
        assert.equal(payload.bound_note_entry_id || undefined, item.boundNoteEntryId || undefined);
        assert.equal(payload.bound_note_room_id ?? undefined, item.boundNoteId);
        if (item.appName !== undefined) assert.equal(payload.app_name, item.appName);
        if (item.appPackageName !== undefined) assert.equal(payload.app_package_name, item.appPackageName);
        if (item.wifiMetadata !== undefined) assert.equal(payload.wifi_metadata, item.wifiMetadata);
        assert.equal(payload.authenticator_key, item.totpSecret || "");
        assert.equal(payload.passkey_bindings, item.passkeyBindings || "");
        assert.equal(payload.notes, item.notes);
        assert.deepEqual(payload.custom_fields.map(field => ({ title: field.title, value: field.value, is_protected: field.is_protected, sort_order: field.sort_order })), item.customFields.map((field, index) => ({ title: field.name, value: field.value, is_protected: field.protected, sort_order: index })));
      }
      records.push({ id: item.id, remoteId: reference.remoteId, revision: reference.revision, exactFieldsVerified: ["title", "username", "password_plain", "password_group_id", "bound_note_entry_id", "bound_note_room_id", "app_name", "app_package_name", "wifi_metadata", "authenticator_key", "passkey_bindings", "notes", "custom_fields"], nativeRecordSha256: sha256(JSON.stringify(revealed.data)) });
      } catch (error) { records.push({ id: snapshot.id, title: snapshot.title, status: "failed", error: error.message }); }
    }
    evidence.nativeExactReadback = records;
    assert.ok(!records.some(record => record.status === "failed"), JSON.stringify(records.filter(record => record.status === "failed")));
    return { records };
  });
  await check("ui-future-type-safe-complete-read-only", async () => {
    const futureTitle = "Edge315 · future read-only";
    const originalPayload = '{"id":"edge315-synthetic-future","kind":"future-synthetic-kind","title":"Edge315 · future read-only","payloadSchemaVersion":31501,"future":{"counter":9007199254740993,"long":9223372036854775807,"nil":null,"empty":"","negativeZero":-0,"array":[null,"",{"nested":9007199254740995}],"secret":"SYNTHETIC-FUTURE-SECRET"}}';
    await page.getByRole("button", { name: "设置与备份", exact: true }).click();
    await expand(page, "明文手动迁移");
    await page.locator("label.file-action").filter({ hasText: "导入明文 JSON / CSV" }).locator('input[type="file"]').setInputFiles({ name: "synthetic-future.json", mimeType: "application/json", buffer: Buffer.from('{"items":[' + originalPayload + ']}') });
    await expect(page.getByText("已加密导入 1 个密码库项目。", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^全部项目/ }).click();
    await page.getByLabel("搜索密码库", { exact: true }).fill(futureTitle);
    const row = page.locator("article.item-card").filter({ has: page.getByLabel(`查看${futureTitle}详情`, { exact: true }) });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /编辑|删除/ })).toHaveCount(0);
    assert.ok(!(await row.innerText()).includes("SYNTHETIC-FUTURE-SECRET"));
    const [item] = await itemsNamed(futureTitle);
    assert.equal(item.kind, "opaque");
    assert.equal(item.nativeType, "future-synthetic-kind");
    assert.equal(item.originalPayload, originalPayload);
    await row.getByLabel(`查看${futureTitle}详情`, { exact: true }).click();
    const detail = page.locator('[role="dialog"][data-item-kind="opaque"]');
    await expect(detail.getByRole("button", { name: /^(编辑|删除)/ })).toHaveCount(0);
    assert.ok(!(await detail.innerText()).includes("SYNTHETIC-FUTURE-SECRET"));
    await screenshot(page, "features-10-future-hidden.png");
    await detail.getByRole("button", { name: "显示完整原始内容", exact: true }).click();
    await expect(detail.locator(".protected-value pre")).toHaveText(originalPayload);
    await screenshot(page, "features-11-future-explicit-reveal.png");
    await detail.getByRole("button", { name: "隐藏完整原始内容", exact: true }).click();
    await expect(detail.locator(".protected-value pre")).toHaveCount(0);
    await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
    snapshots.push(item);
    return { kind: item.nativeType, originalPayloadSha256: sha256(originalPayload), numericLexemesPreserved: true, scope: "actual UI JSON import into isolated local vault; not a Native future-type import" };
  });
  if (groupedId && providerName !== "Monica 本地库") await check("ui-group-delete-cancel-confirm-native-tombstones", async () => {
    await flushNative();
    const before = await itemsNamed(title);
    const independent = await itemsNamed("Edge315 · same title");
    assert.equal(before.length, 2);
    const nativeRecords = [];
    for (const item of before) {
      const ref = item.providerRefs.find(ref => ref.remoteId);
      const revealed = await page.evaluate(request => chrome.runtime.sendMessage(request), { type: "MDBX2_OBJECT_REVEAL", providerId: ref.providerId, objectId: ref.remoteId });
      assert.equal(revealed.ok, true, JSON.stringify(revealed));
      nativeRecords.push({ ref, record: revealed.data });
    }
    await page.getByLabel("搜索密码库", { exact: true }).fill(title);
    const row = page.locator("article.item-card").filter({ has: page.getByLabel(`查看${title}详情`, { exact: true }) });
    let cancelPrompt = "";
    page.once("dialog", async dialog => { cancelPrompt = dialog.message(); await dialog.dismiss(); });
    await row.getByRole("button", { name: "删除登录项", exact: true }).click();
    assert.match(cancelPrompt, /整组 2 个账号/);
    for (const item of before) assert.equal(payloadHash(await readItem(page, item.id)), payloadHash(item));
    await expect(row).toBeVisible();
    await screenshot(page, "features-12-group-delete-cancelled.png");
    page.once("dialog", async dialog => { assert.match(dialog.message(), /整组 2 个账号/); await dialog.accept(); });
    await row.getByRole("button", { name: "删除登录项", exact: true }).click();
    await expect(row).toHaveCount(0);
    await flushNative();
    assert.equal((await itemsNamed(title)).length, 0);
    const tombstones = [];
    for (const { ref, record } of nativeRecords) {
      const result = await page.evaluate(request => chrome.runtime.sendMessage(request), { type: "MDBX2_OBJECT_LIST", providerId: ref.providerId, collectionId: record.collectionId, deleted: true, pageSize: 200 });
      assert.equal(result.ok, true, JSON.stringify(result));
      const tombstone = result.data.items.find(item => item.objectId === ref.remoteId);
      assert.ok(tombstone?.deleted, "Deleted group member must be tombstoned in actual Native MDBX, not just hidden locally.");
      assert.notEqual(tombstone.headCommitId, record.headCommitId);
      tombstones.push(tombstone);
    }
    assert.equal((await itemsNamed("Edge315 · same title")).length, 2);
    for (const item of independent) assert.equal(payloadHash(await readItem(page, item.id)), payloadHash(item));
    await page.getByLabel("搜索密码库", { exact: true }).fill("Edge315 · same title");
    await expect(page.getByLabel("查看Edge315 · same title详情", { exact: true })).toHaveCount(2);
    await screenshot(page, "features-13-group-deleted-independent-preserved.png");
    const deletedIds = new Set(before.map(item => item.id));
    for (let index = snapshots.length - 1; index >= 0; index--) if (deletedIds.has(snapshots[index].id)) snapshots.splice(index, 1);
    return { cancelPreservedMembers: 2, nativeTombstones: tombstones, independentSameTitlePreserved: 2 };
  });
  const freshSnapshots = await Promise.all(snapshots.map(item => readItem(page, item.id)));
  evidence.featurePersistence = freshSnapshots.map(item => ({ id: item.id, title: item.title, sha256: payloadHash(item) }));
  evidence.limitations.push("Feature records were created/edited in real Edge UI. Android application reopening and real WebDAV/KeePass/Bitwarden service acceptance are separate matrix rows; they are not inferred here.");
  await page.reload();
  await page.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
  return evidence.featureChecks;

  async function check(name, body) {
    const selectedCases = process.env.MONICA_315_FEATURE_CASES?.split(",");
    if (selectedCases && !selectedCases.includes(name)) { skip(name, "Not selected for this independent targeted run."); return; }
    progress(`START ${name}`);
    try {
      await page.reload();
      await page.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
      const details = await body();
      evidence.featureChecks.push({ name, status: "passed", details });
      console.error(`Edge feature passed: ${name}`);
    } catch (error) {
      await screenshot(page, `feature-failed-${name}.png`).catch(() => undefined);
      if (name === "ui-flush-and-native-readback") evidence.nativeReadbackFailureDiagnostics = await page.evaluate(async () => Object.fromEntries(await Promise.all(["PROVIDER_LIST", "PROVIDER_QUEUE_STATUS", "PROVIDER_DIAGNOSTIC_EXPORT"].map(async type => [type, await chrome.runtime.sendMessage({ type })]))));
      evidence.featureChecks.push({ name, status: "failed", error: error.message, stack: error.stack });
      console.error(`Edge feature failed: ${name}: ${error.message}`);
    }
  }
  async function flushNative() {
    await page.getByRole("button", { name: "密码源", exact: true }).click();
    const card = page.locator("m3e-card[data-home-provider-id]").filter({ has: page.getByRole("heading", { name: providerName, exact: true }) });
    const button = card.getByRole("button", { name: /^(立即同步|重试同步|写入本机副本)$/ });
    await button.click();
    await expect(card.getByRole("button", { name: "取消同步", exact: true })).toHaveCount(0, { timeout: 60000 });
    await expect(button).toBeVisible({ timeout: 60000 });
    await page.getByRole("button", { name: /^全部项目/ }).click();
    await page.getByRole("heading", { name: "全部项目", exact: true }).waitFor();
  }
  function skip(name, reason) { evidence.featureChecks.push({ name, status: "skipped", reason }); }
  async function create(kind, name) {
    await page.getByLabel("搜索密码库", { exact: true }).fill("");
    await page.getByRole("button", { name: "选择新建类型", exact: true }).click();
    await page.locator(`m3e-menu-item[data-create-type="${kind}"]`).click();
    const editor = ["PASSWORD", "WIFI", "SSH_KEY", "BARCODE", "GPG_KEY", "API_KEY"].includes(kind) ? loginEditor(page) : itemEditor(page);
    await editor.getByLabel("名称 *", { exact: true }).fill(name);
    await chooseOption(editor.getByLabel("保存到", { exact: true }), { label: providerName });
    return editor;
  }
  async function itemsNamed(name) {
    const response = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
    assert.equal(response.ok, true, JSON.stringify(response));
    return Promise.all(response.data.filter(item => item.title === name).map(item => readItem(page, item.id)));
  }
  async function openDetail(name) {
    await page.getByLabel("搜索密码库", { exact: true }).fill(name);
    await page.getByLabel(`查看${name}详情`, { exact: true }).first().click();
    const detail = page.locator('[role="dialog"][data-item-kind="login"]');
    // A grouped list row may represent either member when both timestamps match.
    // Select the intended account through its real detail control before editing.
    if (name === title) await detail.getByRole("button", { name: "group-primary", exact: true }).click();
    return detail;
  }
  async function edit(name) {
    const detail = await openDetail(name);
    await detail.getByRole("button", { name: "编辑", exact: true }).click();
    return loginEditor(page);
  }
}

export async function verifyFeaturePersistence(page, evidence) {
  for (const snapshot of evidence.featurePersistence || []) assert.equal(payloadHash(await readItem(page, snapshot.id)), snapshot.sha256, `Saved fields changed after Edge restart: ${snapshot.title}`);
}

/** Small independent app-UI → Edge-UI → app-UI handoff; no simulated service. */
export async function runAndroidUiReturnCheck({ page, evidence, screenshot, output }) {
  const fixture = process.env.MONICA_315_ANDROID_UI_FIXTURE;
  assert.ok(fixture, "MONICA_315_ANDROID_UI_FIXTURE must explicitly name the synthetic Android UI file.");
  const inputBytes = await readFile(fixture);
  const android = JSON.parse(await readFile(join(dirname(fixture), "android-ui-record.json"), "utf8"));
  const original = JSON.parse(android.payloadJson);
  const providerName = "Edge315 Android UI return";
  const returnedUsername = "edge-ui-return-用户";
  await page.getByRole("button", { name: "密码源", exact: true }).click();
  await page.locator("m3e-list-action").filter({ hasText: "连接 MDBX2 保险库" }).click();
  const source = page.getByRole("dialog", { name: /MDBX2/ });
  await source.getByLabel("显示名称", { exact: true }).fill(providerName);
  await source.getByLabel("MDBX2 可移植备份", { exact: true }).setInputFiles(fixture);
  await source.getByLabel("保险库密码（可留空）", { exact: true }).fill(process.env.MONICA_315_MDBX_PASSWORD || "Synthetic transfer fixture password");
  await source.getByRole("button", { name: "验证、解锁并导入", exact: true }).click();
  await source.waitFor({ state: "hidden", timeout: 60000 });
  await page.getByRole("button", { name: /^全部项目/ }).click();
  await page.getByLabel("搜索密码库", { exact: true }).fill(android.title);
  await page.getByLabel(`查看${android.title}详情`, { exact: true }).click();
  const detail = page.locator('[role="dialog"][data-item-kind="login"]');
  await expect(detail.getByText(original.username, { exact: true })).toBeVisible();
  await screenshot(page, "android-ui-01-edge-detail.png");
  await detail.getByRole("button", { name: "编辑", exact: true }).click();
  const editor = loginEditor(page);
  await expect(editor.getByLabel("用户名", { exact: true })).toHaveValue(original.username);
  await editor.getByLabel("用户名", { exact: true }).fill(returnedUsername);
  await screenshot(page, "android-ui-02-edge-edit.png");
  await save(editor);
  await page.getByRole("button", { name: "密码源", exact: true }).click();
  const card = page.locator("m3e-card[data-home-provider-id]").filter({ has: page.getByRole("heading", { name: providerName, exact: true }) });
  const providerId = await card.getAttribute("data-home-provider-id");
  const sync = card.getByRole("button", { name: /^(立即同步|重试同步|写入本机副本)$/ });
  await sync.click();
  await expect(card.getByRole("button", { name: "取消同步", exact: true })).toHaveCount(0, { timeout: 60000 });
  await expect(sync).toBeVisible({ timeout: 60000 });
  const listed = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
  assert.equal(listed.ok, true);
  const found = listed.data.find(item => item.title === android.title && item.providerRefs.some(ref => ref.providerId === providerId));
  assert.ok(found);
  const item = await readItem(page, found.id);
  const reference = item.providerRefs.find(ref => ref.providerId === providerId);
  const native = await page.evaluate(request => chrome.runtime.sendMessage(request), { type: "MDBX2_OBJECT_REVEAL", providerId, objectId: reference.remoteId });
  assert.equal(native.ok, true, JSON.stringify(native));
  const payload = JSON.parse(native.data.payloadJson);
  assert.equal(payload.username, returnedUsername);
  assert.equal(payload.password_plain, original.password_plain);
  assert.equal(payload.password_group_id, original.password_group_id);
  assert.equal(native.data.title, android.title);
  const downloadEvent = page.waitForEvent("download", { timeout: 60000 });
  await card.getByRole("button", { name: "导出 MDBX2 完整备份", exact: true }).click();
  const download = await downloadEvent;
  const returnedPath = join(output, "edge-ui-return.mdbx");
  const returnedBytes = await saveStandaloneMdbxDownload(download, returnedPath);
  assert.ok(returnedBytes.length > 0);
  assert.equal(sha256(await readFile(fixture)), sha256(inputBytes));
  await screenshot(page, "android-ui-03-edge-native-export.png");
  evidence.androidUiReturn = { status: "passed", inputFixture: fixture, inputSha256: sha256(inputBytes), title: android.title, originalUsername: original.username, returnedUsername, itemId: item.id, nativeObjectId: reference.remoteId, nativeHeadCommitId: native.data.headCommitId, output: returnedPath, outputSha256: sha256(returnedBytes), layer: "actual Android UI fixture → real Edge extension UI edit → actual Native commit → UI exported MDBX; Android reopen is pending" };
  await writeFile(join(output, "android-ui-return-evidence.json"), JSON.stringify(evidence.androidUiReturn, null, 2));
  await page.getByRole("button", { name: /^全部项目/ }).click();
}

export async function runAndroidUiReopenCheck({ page, evidence, screenshot }) {
  const fixture = process.env.MONICA_315_ANDROID_UI_REOPEN_FIXTURE;
  assert.ok(fixture, "MONICA_315_ANDROID_UI_REOPEN_FIXTURE must explicitly name the returned synthetic Android UI file.");
  const bytes = await readFile(fixture);
  const originalRecord = JSON.parse(await readFile(join(dirname(fixture), "android-ui-record.json"), "utf8"));
  const original = JSON.parse(originalRecord.payloadJson);
  const username = "edge-ui-return-用户 · Android UI return";
  await page.getByRole("button", { name: "密码源", exact: true }).click();
  await page.locator("m3e-list-action").filter({ hasText: "连接 MDBX2 保险库" }).click();
  const source = page.getByRole("dialog", { name: /MDBX2/ });
  await source.getByLabel("显示名称", { exact: true }).fill("Edge315 Android UI final reopen");
  await source.getByLabel("MDBX2 可移植备份", { exact: true }).setInputFiles(fixture);
  await source.getByLabel("保险库密码（可留空）", { exact: true }).fill(process.env.MONICA_315_MDBX_PASSWORD || "Synthetic transfer fixture password");
  await source.getByRole("button", { name: "验证、解锁并导入", exact: true }).click();
  await source.waitFor({ state: "hidden", timeout: 60000 });
  const list = await page.evaluate(() => chrome.runtime.sendMessage({ type: "VAULT_LIST_ITEMS" }));
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.data.length, 1, "The final reopen fixture must contain only the explicitly created UI login.");
  const item = await readItem(page, list.data[0].id);
  assert.equal(item.title, originalRecord.title);
  assert.equal(item.username, username);
  assert.equal(item.password, original.password_plain);
  assert.equal(item.passwordGroupId, original.password_group_id);
  const ref = item.providerRefs[0];
  const native = await page.evaluate(request => chrome.runtime.sendMessage(request), { type: "MDBX2_OBJECT_REVEAL", providerId: ref.providerId, objectId: ref.remoteId });
  assert.equal(native.ok, true, JSON.stringify(native));
  const raw = JSON.parse(native.data.payloadJson);
  assert.equal(raw.username, username);
  assert.equal(raw.password_plain, original.password_plain);
  await page.getByRole("button", { name: /^全部项目/ }).click();
  await page.getByLabel(`查看${item.title}详情`, { exact: true }).click();
  const detail = page.locator('[role="dialog"][data-item-kind="login"]');
  await expect(detail.getByText(username, { exact: true })).toBeVisible();
  await screenshot(page, "android-ui-04-edge-final-reopen-detail.png");
  await detail.getByRole("button", { name: "关闭详情", exact: true }).click();
  assert.equal(sha256(await readFile(fixture)), sha256(bytes));
  evidence.androidUiReopen = { status: "passed", fixture, fixtureSha256: sha256(bytes), itemCount: 1, title: item.title, username, nativeHeadCommitId: native.data.headCommitId, nativeObjectId: native.data.objectId, passwordUnchanged: true, passwordGroupIdUnchanged: true, layer: "actual Android UI → actual Edge UI edit/native export → Android UI reopen/edit/export → final real Edge UI read-only reopen" };
}

function loginEditor(page) { return page.locator("m3e-dialog").filter({ has: page.locator("#login-item-form") }).first(); }
function itemEditor(page) { return page.locator("m3e-dialog").filter({ has: page.locator("#vault-item-form") }).last(); }
async function save(editor) {
  await editor.getByRole("button", { name: "加密保存", exact: true }).click();
  try { await editor.waitFor({ state: "hidden", timeout: 30000 }); }
  catch (error) { throw new Error(`${error.message}\nVisible editor error: ${(await editor.locator('.form-error, [role="alert"]').allTextContents()).join("; ")}`); }
}
async function fill(scope, fields) { for (const [name, value] of Object.entries(fields)) await scope.getByLabel(name, { exact: true }).fill(value); }
async function expand(scope, label) {
  const page = typeof scope.page === "function" ? scope.page() : scope;
  const panel = scope.locator("m3e-expansion-panel").filter({ has: page.locator('[slot="header"]').filter({ hasText: label }) }).last();
  if (!await panel.evaluate(node => Boolean(node.open))) await panel.locator('[slot="header"]').first().click();
}
async function chooseOption(control, choice) {
  if (await control.evaluate(node => node.localName) === "select") return control.selectOption(choice);
  // M3E initializes slotted options asynchronously after a newly opened dialog.
  // Wait for its actual component update, not an arbitrary browser delay.
  await control.evaluate(async node => { await node.updateComplete; await Promise.all([...node.querySelectorAll("m3e-option")].map(option => option.updateComplete)); });
  const options = await control.locator("m3e-option").evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent?.replace(/\s+/g, " ").trim() || "" })));
  const selected = options.find(option => typeof choice === "string" ? option.value === choice : option.label === choice.label);
  assert.ok(selected, `Missing choice ${JSON.stringify(choice)}; available ${JSON.stringify(options)}`);
  await control.click();
  const panelId = await control.getAttribute("aria-controls");
  assert.ok(panelId);
  const panel = control.page().locator(`[id="${panelId}"]`);
  await panel.getByRole("option", { name: selected.label, exact: true }).click();
  await expect(control).toHaveJSProperty("value", selected.value);
  await expect(panel).toHaveCount(0);
}
async function readItem(page, itemId) {
  const response = await page.evaluate(id => chrome.runtime.sendMessage({ type: "VAULT_GET_ITEM", itemId: id }), itemId);
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.ok(response.data, `Missing saved item ${itemId}`);
  return response.data;
}
function wallet(item, kind) { const field = item.customFields.find(field => field.name === `monica.content.wallet.${kind}`); assert.ok(field, `Missing full ${kind} copy`); return JSON.parse(field.value); }
function decodeBlocks(fields) {
  return fields.filter(field => /^monica\.content\.block\.[^.]+$/.test(field.name)).map(header => {
    const manifest = JSON.parse(header.value);
    const encoded = Array.from({ length: manifest.parts }, (_, index) => fields.find(field => field.name === `${header.name}.${String(index).padStart(4, "0")}`).value).join("");
    const bytes = Buffer.from(encoded, "base64");
    assert.equal(sha256(bytes), manifest.sha256);
    return JSON.parse(bytes.toString("utf8"));
  });
}
function payloadHash(item) { const { providerRefs, ...fields } = item; return sha256(JSON.stringify(fields)); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function progress(message) { console.error(`${new Date().toISOString()} Edge feature step: ${message}`); }
function syntheticPng() {
  const chunk = (name, payload) => {
    const data = Buffer.concat([Buffer.from(name), payload]);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4); size.writeUInt32BE(payload.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 0, 128, 128, 0, 128, 128, 0, 0, 128, 128, 0, 128, 128]))), chunk("IEND", Buffer.alloc(0))]);
}
export { chooseOption, loginEditor, save, fill, expand, readItem, payloadHash };
