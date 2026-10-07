import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { chooseOption, loginEditor, save, fill, readItem } from './interop-315-edge-features.mjs';

export async function runWebDavNoteUi({page,evidence,screenshot,readOnly=false}) {
  const fixture=JSON.parse(await readFile(process.env.MONICA_WEBDAV_NOTE_FIXTURE,'utf8'));
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  await page.locator('m3e-list-action').filter({hasText:'连接 Monica Android WebDAV'}).click();
  const connection=page.getByRole('dialog',{name:'连接 Monica Android WebDAV',exact:true});
  await fill(connection,{'显示名称':fixture.name,'WebDAV 地址 *':fixture.baseUrl,'用户名':fixture.username,'WebDAV 密码':fixture.password,'Android 备份加密密码（可选）':fixture.backupPassword});
  await connection.getByRole('button',{name:'测试连接',exact:true}).click();
  await expect(connection.getByRole('button',{name:'加密保存',exact:true})).toBeEnabled();
  await connection.getByRole('button',{name:'加密保存',exact:true}).click(); await connection.waitFor({state:'hidden'});
  const card=page.locator('[data-home-provider-id]').filter({has:page.getByRole('heading',{name:fixture.name,exact:true})});
  const providerId=await card.getAttribute('data-home-provider-id'); assert.ok(providerId);
  const list=async()=>{
    const result=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'})); assert.equal(result.ok,true);
    return Promise.all(result.data.filter(item=>item.providerRefs.some(ref=>ref.providerId===providerId)).map(item=>readItem(page,item.id)));
  };
  const find=async title=>{const item=(await list()).find(item=>item.title===title);assert.ok(item,title);return item;};
  const sync=async()=>{
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    const button=card.getByRole('button',{name:/^(立即同步|重试同步)$/}); await button.click();
    await expect(card.getByRole('button',{name:'取消同步',exact:true})).toHaveCount(0,{timeout:60000});
    await expect(button).toBeVisible({timeout:60000}); await expect(card.locator('.form-error')).toHaveCount(0);
    await page.getByRole('button',{name:/^全部项目/}).click();
  };
  const create=async(kind,title)=>{
    await page.getByLabel('搜索密码库',{exact:true}).fill('');
    await page.getByRole('button',{name:'选择新建类型',exact:true}).click();
    await page.locator(`m3e-menu-item[data-create-type="${kind}"]`).click();
    const editor=kind==='PASSWORD'?loginEditor(page):page.locator('m3e-dialog').filter({has:page.locator('#vault-item-form')}).last();
    await editor.getByLabel('名称 *',{exact:true}).fill(title);
    await chooseOption(editor.getByLabel('保存到',{exact:true}),{label:fixture.name}); return editor;
  };
  const edit=async title=>{
    await page.getByLabel('搜索密码库',{exact:true}).fill(title);
    await page.getByLabel(`查看${title}详情`,{exact:true}).first().click();
    const detail=page.locator('[role="dialog"][data-item-kind="login"]').filter({has:page.getByRole('heading',{name:title,exact:true})});
    await detail.getByRole('button',{name:'编辑',exact:true}).click(); return loginEditor(page);
  };
  const logical=note=>note.replicaGroupId?.startsWith('note:')?note.replicaGroupId:`note:${note.id}`;
  await sync();
  const original=await list();
  if (readOnly) {
    evidence.webdavNoteReturn={status:'running',providerId,fixture:process.env.MONICA_WEBDAV_NOTE_FIXTURE,checks:[],geometry:[]};
    await verifyWebDavNoteReturn({page,evidence,screenshot,phase:'initial'});
    await page.reload();
    await page.getByRole('heading',{name:'全部项目',exact:true}).waitFor();
    await sync();
    await verifyWebDavNoteReturn({page,evidence,screenshot,phase:'reload'});
    return;
  }
  const first=original.find(item=>item.kind==='secure-note'&&item.content.startsWith('# First'));
  const second=original.find(item=>item.kind==='secure-note'&&item.content.startsWith('# Second'));
  assert.ok(first);assert.ok(second);assert.equal(first.title,second.title);
  const title='Edge WebDAV note password'; let editor=await create('PASSWORD',title);
  await editor.getByLabel('密码',{exact:true}).fill('synthetic-edge-note-password');
  const picker=editor.getByLabel('选择关联笔记',{exact:true});
  await chooseOption(editor.getByLabel('保存到',{exact:true}),{label:'Monica 本地库'});
  await expect.poll(()=>picker.locator('m3e-option').evaluateAll(nodes=>nodes.map(node=>node.value))).not.toContain(logical(first));
  await chooseOption(editor.getByLabel('保存到',{exact:true}),{label:fixture.name});
  const labels=await picker.locator('m3e-option').allTextContents();
  assert.ok(labels.some(label=>label.includes('# First note')));assert.ok(labels.some(label=>label.includes('# Second note')));
  await chooseOption(picker,logical(first)); await save(editor); await sync();
  assert.equal((await find(title)).boundNoteEntryId,logical(first));
  editor=await edit(title);
  await expect.poll(()=>editor.getByLabel('选择关联笔记',{exact:true}).locator('m3e-option').evaluateAll(nodes=>nodes.filter(node=>node.value==='').map(node=>node.textContent.trim()))).toEqual(['不关联笔记']);
  await chooseOption(editor.getByLabel('选择关联笔记',{exact:true}),logical(second));
  const geometry=[];
  for (const width of [420,320]) {
    await page.setViewportSize({width,height:920}); await editor.locator('.bound-note-section').scrollIntoViewIfNeeded();
    await expect(editor.locator('.bound-note-preview')).toContainText('Same title, different ID');
    geometry.push(await editor.locator('.bound-note-section').evaluate(node=>({width:innerWidth,scroll:node.scrollWidth,client:node.clientWidth})));
    assert.ok(geometry.at(-1).scroll<=geometry.at(-1).client+1,'Note section overflow');
    await screenshot(page,`webdav-note-picker-${width}.png`);
    await editor.getByLabel('选择关联笔记',{exact:true}).click();
    const panelId=await editor.getByLabel('选择关联笔记',{exact:true}).getAttribute('aria-controls');
    const panel=page.locator(`[id="${panelId}"]`);
    const rows=await panel.locator('.bound-note-option-text').evaluateAll(nodes=>nodes.map(node=>{
      const title=node.querySelector('.bound-note-option-title').getBoundingClientRect();
      const excerpt=node.querySelector('.bound-note-option-excerpt').getBoundingClientRect();
      return {titleTop:title.top,excerptTop:excerpt.top,height:excerpt.height,width:excerpt.width};
    }));
    assert.equal(rows.length,2);assert.ok(rows.every(row=>row.excerptTop>row.titleTop && row.height>=16 && row.width>=100),'Note excerpts must render on a distinct visible line');
    await screenshot(page,`webdav-note-options-${width}.png`);
    await page.keyboard.press('Escape');await expect(editor).toBeVisible();
  }
  await save(editor); await sync();
  const linked=await find(title);assert.equal(linked.boundNoteEntryId,logical(second));
  editor=await edit(title);await editor.getByRole('button',{name:'解除笔记关联',exact:true}).click();
  await editor.getByRole('button',{name:'取消',exact:true}).click(); assert.equal((await find(title)).boundNoteEntryId,linked.boundNoteEntryId);
  await page.getByLabel(`查看${title}详情`,{exact:true}).first().click();
  const detail=page.locator('[role="dialog"][data-item-kind="login"]');
  await detail.getByRole('button',{name:'查看关联笔记',exact:true}).click();
  const nested=page.locator('[role="dialog"][data-item-kind="secure-note"]');
  await expect(nested).toContainText('Same title, different ID');await page.keyboard.press('Escape');
  await expect(nested).toHaveCount(0);await expect(detail).toBeVisible();await detail.getByRole('button',{name:'关闭详情',exact:true}).click();
  const unlink=original.find(item=>item.kind==='login'&&item.title.endsWith('-unlink'));
  editor=await edit(unlink.title);await editor.getByRole('button',{name:'解除笔记关联',exact:true}).click();await save(editor);await sync();
  assert.equal((await find(unlink.title)).boundNoteEntryId,undefined);
  editor=await create('secure-note','Edge fresh note');
  await editor.getByLabel('笔记内容 *',{exact:true}).fill('Created from real Edge\n保留正文 🔑');await save(editor);await sync();
  const fresh=await find('Edge fresh note'); editor=await create('PASSWORD','Edge fresh note password');
  await chooseOption(editor.getByLabel('选择关联笔记',{exact:true}),logical(fresh));await save(editor);await sync();
  await page.reload();await page.getByRole('heading',{name:'全部项目',exact:true}).waitFor();await sync();
  const final=await find('Edge fresh note password');assert.equal(final.boundNoteEntryId,logical(fresh));
  const finalNotes=(await list()).filter(item=>item.kind==='secure-note');
  for (const before of [first,second]) assert.ok(finalNotes.some(note=>note.title===before.title&&note.content===before.content),'Original note content changed');
  await page.getByLabel('搜索密码库',{exact:true}).fill('');
  evidence.webdavNotes={status:'passed',providerId,fixture:process.env.MONICA_WEBDAV_NOTE_FIXTURE,geometry,checks:['create','same-title selection','replace','cancel','nested detail/Escape','unlink','new note/create link','reload/sync']};
}

export async function verifyWebDavNoteReturn({page,evidence,screenshot,phase,preserveViewport=false}) {
  const result=evidence.webdavNoteReturn;
  const fixture=JSON.parse(await readFile(result.fixture,'utf8'));
  const expected=JSON.parse(await readFile(fixture.expectedFile,'utf8'));
  const response=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));
  assert.equal(response.ok,true);
  const items=await Promise.all(response.data.filter(item=>item.providerRefs.some(ref=>ref.providerId===result.providerId)).map(item=>readItem(page,item.id)));
  assert.equal(items.length,8);
  const notes=items.filter(item=>item.kind==='secure-note');
  assert.equal(notes.length,3);
  const noteSnapshot=note=>note?{title:note.title,content:note.content,notes:note.notes,tags:note.tags||[],isMarkdown:Boolean(note.isMarkdown),favorite:note.favorite,customFields:note.customFields||[]}:null;
  const logical=note=>note.replicaGroupId?.startsWith('note:')?note.replicaGroupId:`note:${note.id}`;
  for (const before of expected.notes) assert.ok(notes.some(note=>JSON.stringify(noteSnapshot(note))===JSON.stringify(before)),'Returned note fields differ');
  const widths=preserveViewport?[await page.evaluate(()=>innerWidth)]:phase==='initial'?[420,320]:[420];
  for (const width of widths) {
    if (!preserveViewport) await page.setViewportSize({width,height:920});
    for (const before of expected.logins) {
      const item=items.find(item=>item.kind==='login'&&item.title===before.title);
      assert.ok(item,before.title);
      for (const key of ['title','username','password','notes','uris','favorite','loginType','customFields']) assert.deepEqual(item[key],before[key],`${phase}: ${before.title} ${key}`);
      const note=notes.find(note=>logical(note)===item.boundNoteEntryId);
      assert.deepEqual(noteSnapshot(note),before.note);
      if (!before.note) {assert.equal(item.boundNoteEntryId,undefined);assert.equal(item.boundNoteId,undefined);}
      await page.getByLabel('搜索密码库',{exact:true}).fill(before.title);
      await page.getByLabel(`查看${before.title}详情`,{exact:true}).first().click();
      const detail=page.locator('[role="dialog"][data-item-kind="login"]').filter({has:page.getByRole('heading',{name:before.title,exact:true})});
      await expect(detail).toBeVisible();
      const link=detail.getByRole('button',{name:'查看关联笔记',exact:true});
      if (before.note) {
        await link.click();
        const nested=page.locator('[role="dialog"][data-item-kind="secure-note"][data-nested-dialog]');
        await expect(nested).toBeVisible();
        assert.equal(await nested.locator('.detail-note pre').textContent(),before.note.content);
        await expect(nested.getByRole('heading',{name:before.note.title,exact:true})).toBeVisible();
        assert.deepEqual(await nested.locator('.detail-tag').allTextContents(),[...before.note.tags,...(before.note.isMarkdown?['Markdown']:[])]);
        const geometry=await nested.evaluate(node=>({width:innerWidth,scroll:node.scrollWidth,client:node.clientWidth,pageScroll:document.documentElement.scrollWidth}));
        assert.ok(geometry.scroll<=geometry.client+1 && geometry.pageScroll<=width+1,'Returned note detail overflow');
        result.geometry.push({phase,title:before.title,...geometry});
        if (phase==='initial'&&before.title==='Edge WebDAV note password') await screenshot(page,`android-note-return-${width}.png`);
        if (phase==='real side panel'&&before.title==='Edge WebDAV note password') await screenshot(page,'android-note-return-real-side-panel.png');
        if (phase==='initial'&&before.title==='Edge fresh note password') await screenshot(page,`android-fresh-note-return-${width}.png`);
        await page.keyboard.press('Escape');
        await expect(nested).toHaveCount(0);await expect(detail).toBeVisible();
      } else {
        await expect(link).toHaveCount(0);
        await expect(detail).not.toContainText('暂时找不到关联笔记');
        if (phase==='initial') await screenshot(page,`android-unlinked-note-return-${width}.png`);
      }
      await detail.getByRole('button',{name:'关闭详情',exact:true}).click();
      await expect(detail).toHaveCount(0);
    }
  }
  await page.getByLabel('搜索密码库',{exact:true}).fill('');
  result.checks.push(`${phase}: 5 passwords, 4 resolved links, explicit unlink, 3 exact notes/tags/Markdown, portrait detail and nested Escape`);
}
