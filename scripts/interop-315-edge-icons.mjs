import assert from 'node:assert/strict';
import {expect} from '@playwright/test';
import {loginEditor,save,readItem,chooseOption} from './interop-315-edge-features.mjs';
export async function runIconUiCheck({page,evidence,screenshot}) {
  const name='Synthetic custom icon';
  const fixture=process.env.MONICA_315_MDBX_FIXTURE, providerName='Synthetic icon MDBX';
  if(fixture) {
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    await page.locator('m3e-list-action').filter({hasText:'连接 MDBX2 保险库'}).click();
    const dialog=page.getByRole('dialog',{name:/MDBX2/});
    await dialog.getByLabel('显示名称',{exact:true}).fill(providerName);
    await dialog.getByLabel('MDBX2 可移植备份',{exact:true}).setInputFiles(fixture);
    await dialog.getByLabel('保险库密码（可留空）',{exact:true}).fill('Synthetic transfer fixture password');
    await dialog.getByRole('button',{name:'验证、解锁并导入',exact:true}).click();
    await dialog.waitFor({state:'hidden',timeout:60000});
  }
  async function flush() {
    if(!fixture)return;
    const viewport=page.viewportSize(); await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    const card=page.locator('m3e-card[data-home-provider-id]').filter({has:page.getByRole('heading',{name:providerName,exact:true})});
    const button=card.getByRole('button',{name:/^(立即同步|重试同步|写入本机副本)$/});await button.click();
    await expect(card.getByRole('button',{name:'取消同步',exact:true})).toHaveCount(0,{timeout:60000});
    await expect(button).toBeVisible({timeout:60000});
    await page.getByRole('button',{name:/^全部项目/}).click();
    if(viewport)await page.setViewportSize(viewport);
  }
  await page.getByRole('button',{name:'选择新建类型',exact:true}).click();
  await page.locator('m3e-menu-item[data-create-type="PASSWORD"]').click();
  let editor=loginEditor(page);
  await editor.getByLabel('名称 *',{exact:true}).fill(name);
  if(fixture)await chooseOption(editor.getByLabel('保存到',{exact:true}),{label:providerName});
  await editor.getByLabel('密码',{exact:true}).fill('Synthetic icon password');
  await editor.getByRole('button',{name:'更换图标',exact:true}).click();
  await editor.getByLabel('搜索图标名称',{exact:true}).fill('github');
  await editor.getByRole('button',{name:'github',exact:true}).click();
  await expect.poll(()=>editor.locator('.icon-current img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);
  await screenshot(page,'icons-library-desktop.png');
  await page.setViewportSize({width:420,height:920});
  await editor.locator('.custom-icon-picker').scrollIntoViewIfNeeded();
  assert.equal(await editor.evaluate(node=>node.scrollWidth>node.clientWidth),false);
  await screenshot(page,'icons-library-narrow.png');
  await save(editor);await flush();
  const listed=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(listed.ok,true);
  const id=listed.data.find(item=>item.title===name).id;
  assert.equal((await readItem(page,id)).customIconValue,'github');
  const open=async()=>{
    await page.getByLabel('搜索密码库',{exact:true}).fill(name);
    await page.getByLabel(`查看${name}详情`,{exact:true}).first().click();
    return page.locator('[role="dialog"][data-item-kind="login"]');
  };
  let detail=await open();
  await expect(detail.locator('.website-icon img')).toBeVisible();
  // Wait for Vue's entrance translation before measuring the final layout.
  await expect.poll(()=>detail.evaluate(node=>{const r=node.getBoundingClientRect();return Math.max(Math.abs(r.x),Math.abs(r.y),Math.abs(r.width-420),Math.abs(r.height-920));}),{message:'Portrait detail must fill the viewport'}).toBeLessThan(1);
  await screenshot(page,'icons-detail-narrow.png');
  await detail.getByRole('button',{name:'编辑',exact:true}).click();
  editor=loginEditor(page);await editor.getByRole('button',{name:'更换图标',exact:true}).click();
  await editor.getByRole('button',{name:'Emoji',exact:true}).click();
  await editor.getByLabel('Emoji',{exact:true}).fill('👩🏽‍💻');
  await editor.getByRole('button',{name:'使用这个 Emoji',exact:true}).click();
  await expect(editor.locator('.website-icon__emoji')).toHaveText('👩🏽‍💻');
  await screenshot(page,'icons-emoji-narrow.png');
  await save(editor);await flush();assert.equal((await readItem(page,id)).customIconValue,'👩🏽‍💻');
  detail=await open();await expect(detail.locator('.website-icon__emoji')).toHaveText('👩🏽‍💻');
  await detail.getByRole('button',{name:'编辑',exact:true}).click();editor=loginEditor(page);
  await editor.getByRole('button',{name:'更换图标',exact:true}).click();
  await editor.getByRole('button',{name:'跟随网站',exact:true}).click();
  await editor.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal((await readItem(page,id)).customIconValue,'👩🏽‍💻');
  await page.setViewportSize({width:1280,height:900});
  evidence.customIcons={status:'passed',id,libraryImageDecoded:true,emojiSequenceSaved:true,cancelPreservedIcon:true,narrowNoOverflow:true};
  if(fixture) {
    const item=await readItem(page,id), ref=item.providerRefs.find(ref=>ref.remoteId);assert.ok(ref);
    const result=await page.evaluate(ref=>chrome.runtime.sendMessage({type:'MDBX2_OBJECT_REVEAL',providerId:ref.providerId,objectId:ref.remoteId}),ref);assert.equal(result.ok,true);
    const payload=JSON.parse(result.data.payloadJson);assert.equal(payload.custom_icon_type,'EMOJI');assert.equal(payload.custom_icon_value,'👩🏽‍💻');
    evidence.customIcons.actualNativePayloadVerified=true;
  }
}
export async function verifyIconPersistence(page,evidence) {
  assert.equal((await readItem(page,evidence.customIcons.id)).customIconValue,'👩🏽‍💻');
  evidence.customIcons.browserRestartPreserved=true;
}
