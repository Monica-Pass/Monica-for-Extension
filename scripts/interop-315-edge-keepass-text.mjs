import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';
import { loginEditor, save, readItem, expand } from './interop-315-edge-features.mjs';

const password='monica-android-extension-interop-password';
const privateText='\n-----BEGIN OPENSSH PRIVATE KEY-----\r\nsynthetic-private\r\n-----END OPENSSH PRIVATE KEY-----\n';
const commentText=' \tAndroid comment\r\n ';
const editedComment=' \tEdge comment  ';
const plainText=' \tAndroid plain text\nsecond line\t ';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const textSnapshot=item=>({email:item.email,notes:item.notes,custom:item.customFields.map(field=>[field.name,field.value]).sort(([left],[right])=>left.localeCompare(right))});

export async function runKeePassTextUi({page,evidence,screenshot,output}) {
  assert.ok(process.env.MONICA_KEEPASS_TEXT_FIXTURE_ROOT,'Explicit retained Android core fixture required');
  const root=resolve(process.env.MONICA_KEEPASS_TEXT_FIXTURE_ROOT);
  const core=JSON.parse(await readFile(join(root,'evidence.json'),'utf8'));
  assert.equal(core.status,'passed');assert.equal(core.sshPortability.whitespaceAndCrLfExact,true);
  const plainXml=process.env.MONICA_KEEPASS_TEXT_PLAIN==='1';
  if (plainXml) assert.equal(core.plainTextPortability.androidPlainFieldsVerified,true);
  const input=join(root,plainXml?'android-plain-aes.kdbx':'android-aes.kdbx');
  assert.equal(hash(await readFile(input)),(plainXml?core.plainTextPortability.variants:core.supportedCiphers).find(value=>value.cipher==='AES-256').inputSha256);
  const connect=async(file,name)=>{
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    await page.locator('m3e-list-action').filter({hasText:'连接 KeePass'}).click();
    const dialog=page.getByRole('dialog',{name:'连接 KeePass',exact:true});
    await dialog.getByLabel('显示名称',{exact:true}).fill(name);
    await dialog.getByLabel('KeePass 数据库文件',{exact:true}).setInputFiles(file);
    await dialog.getByLabel('数据库密码（可留空）',{exact:true}).fill(password);
    await dialog.getByRole('button',{name:'解锁并连接',exact:true}).click();
    await dialog.waitFor({state:'hidden',timeout:60000});
    const card=page.locator('[data-home-provider-id]').filter({has:page.getByRole('heading',{name,exact:true})});
    const id=await card.getAttribute('data-home-provider-id');assert.ok(id);
    return {id,card};
  };
  const flush=async source=>{
    await page.setViewportSize({width:1280,height:900});
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    await source.card.getByRole('button',{name:/^(立即同步|重试同步|写入本机副本)$/}).first().click();
    await expect(source.card.getByRole('button',{name:'取消同步',exact:true})).toHaveCount(0,{timeout:60000});
    await expect(source.card.locator('.form-error')).toHaveCount(0);
    await page.getByRole('button',{name:/^全部项目/}).click();
  };
  const find=async(source,title)=>{
    const response=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(response.ok,true);
    const item=response.data.find(value=>value.title===title&&value.providerRefs.some(ref=>ref.providerId===source.id));assert.ok(item,title);
    return readItem(page,item.id);
  };
  const edit=async title=>{
    await page.getByLabel('搜索密码库',{exact:true}).fill(title);
    await page.getByLabel(`查看${title}详情`,{exact:true}).first().click();
    await page.locator('[role="dialog"][data-item-kind="login"]').filter({has:page.getByRole('heading',{name:title,exact:true})}).getByRole('button',{name:'编辑',exact:true}).click();
    return loginEditor(page);
  };
  const source=await connect(input,'SSH 原文验证');await flush(source);
  const initial=await find(source,'Android SSH');
  const expected=JSON.parse(initial.sshKeyData);
  assert.equal(expected.privateKeyOpenSsh,privateText);assert.equal(expected.comment,plainXml?plainText:commentText);assert.equal(expected.publicKeyOpenSsh,plainXml?'ssh-rsa\tplain-public':' ssh-rsa android-public\n');
  const expectedText=plainXml?textSnapshot(initial):undefined;
  if (plainXml) {assert.equal(initial.email,plainText);assert.equal(initial.notes,plainText);assert.ok(initial.customFields.some(field=>field.name==='Future plain\tfield'&&field.value===plainText));}
  const assertStored=(item,ssh)=>{assert.deepEqual(JSON.parse(item.sshKeyData),ssh);if(expectedText) assert.deepEqual(textSnapshot(item),expectedText);};
  let editor=await edit('Android SSH');
  await page.setViewportSize({width:420,height:920});
  assert.equal(await editor.getByLabel('OpenSSH 私钥',{exact:true}).inputValue(),privateText.replaceAll('\r\n','\n'));
  await editor.getByLabel('名称 *',{exact:true}).fill('Edge SSH exact text');
  await save(editor);await flush(source);
  assertStored(await find(source,'Edge SSH exact text'),expected);
  editor=await edit('Edge SSH exact text');
  await page.setViewportSize({width:320,height:920});
  await expand(editor,'密钥信息与高级设置');
  await inspectSshLayout({page,editor,evidence,screenshot,phase:'manager',widths:[320,420,1280]});
  await page.setViewportSize({width:320,height:920});
  await editor.getByLabel('注释',{exact:true}).fill(editedComment);
  await editor.getByLabel('注释',{exact:true}).scrollIntoViewIfNeeded();
  await screenshot(page,'keepass-ssh-text-320.png');
  await save(editor);await flush(source);
  const finalExpected={...expected,comment:editedComment};
  assertStored(await find(source,'Edge SSH exact text'),finalExpected);
  editor=await edit('Edge SSH exact text');
  await editor.getByLabel('OpenSSH 私钥',{exact:true}).fill('cancelled private-key draft');
  await editor.getByRole('button',{name:'取消',exact:true}).click();
  assertStored(await find(source,'Edge SSH exact text'),finalExpected);
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  const downloadPromise=page.waitForEvent('download');
  await source.card.getByRole('button',{name:'导出 KDBX',exact:true}).click();
  const exported=join(output,'edge-ssh-text.kdbx');await (await downloadPromise).saveAs(exported);
  await expect(source.card.locator('.provider-dirty-warning')).toHaveCount(0);
  const reopened=await connect(exported,'SSH 导出重开');await flush(reopened);
  const item=await find(reopened,'Edge SSH exact text');
  assertStored(item,finalExpected);
  evidence.keePassText={status:'passed',fixture:root,plainXml,inputSha256:hash(await readFile(input)),exportSha256:hash(await readFile(exported)),itemId:item.id,expected:finalExpected,expectedText,checks:['actual Android core KDBX import','portrait rename preserves untouched text','comment edit preserves CRLF private key','cancel private-key draft','UI export and second-source reopen',...(plainXml?['plain XML tabs in SSH/email/notes/custom name and value']:[])]};
}

export async function verifyKeePassTextPersistence(page,evidence) {
  const item=await readItem(page,evidence.keePassText.itemId);
  assert.deepEqual(JSON.parse(item.sshKeyData),evidence.keePassText.expected);
  if(evidence.keePassText.expectedText) assert.deepEqual(textSnapshot(item),evidence.keePassText.expectedText);
  evidence.keePassText.checks.push('encrypted local state after browser restart');
}

async function inspectSshLayout({page,editor,evidence,screenshot,phase,widths}) {
  const section=editor.locator('section[aria-label="SSH 密钥"]');
  const raw=section.locator('m3e-expansion-panel.special-advanced');
  for (const width of widths) {
    if(width) await page.setViewportSize({width,height:920});
    await editor.getByLabel('注释',{exact:true}).scrollIntoViewIfNeeded();
    const geometry=await section.evaluate(node=>{
      const bounds=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};};
      const base=bounds(node.querySelector(':scope > m3e-form-field'));
      const fields=[...node.querySelectorAll('.editor-disclosure-body > m3e-form-field')].map(bounds);
      const header=node.querySelector('.special-advanced > [slot="header"]');
      const headerContent=node.querySelector('.special-advanced').shadowRoot.querySelector('m3e-expansion-header').shadowRoot.querySelector('.content');
      const text=document.createRange();text.selectNodeContents(header);
      return {viewport:innerWidth,base,fields,header:{availableWidth:headerContent.getBoundingClientRect().width,textWidth:text.getBoundingClientRect().width}};
    });
    assert.ok(geometry.fields.every(field=>field.left>=geometry.base.left-1&&field.right<=geometry.base.right+1),'Advanced fields overflow their section');
    if(geometry.viewport<=420) assert.ok(geometry.fields.every(field=>Math.abs(field.width-geometry.base.width)<1),'Narrow advanced fields must use the primary field width');
    assert.ok(geometry.header.availableWidth>0&&geometry.header.textWidth>0,'Heading measurement must not use inline clientWidth=0');
    assert.ok(geometry.header.textWidth<=geometry.header.availableWidth+1,'Nested metadata heading is clipped');
    await expect(editor.getByRole('button',{name:'加密保存',exact:true})).toBeVisible();
    await screenshot(page,`ssh-layout-${phase}-${geometry.viewport}.png`);
    await expand(editor,'Android 原始元数据');
    const field=raw.locator('m3e-form-field');
    await field.scrollIntoViewIfNeeded();
    const rawWidth=await field.evaluate(node=>node.getBoundingClientRect().width);
    assert.ok(Math.abs(rawWidth-geometry.base.width)<1,'Nested JSON field accumulates an extra gutter');
    await screenshot(page,`ssh-layout-${phase}-${geometry.viewport}-metadata.png`);
    await raw.locator('m3e-expansion-header').click();
    await expect(raw).not.toHaveAttribute('open','');
    (evidence.sshEditorLayout??=[]).push({phase,...geometry,rawWidth,status:'passed'});
  }
}

export async function verifyKeePassTextSidePanel({page,evidence,screenshot}) {
  await page.getByLabel('搜索密码库',{exact:true}).fill('Edge SSH exact text');
  await page.getByLabel('查看Edge SSH exact text详情',{exact:true}).first().click();
  await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button',{name:'编辑',exact:true}).click();
  const editor=loginEditor(page);
  await expand(editor,'密钥信息与高级设置');
  await inspectSshLayout({page,editor,evidence,screenshot,phase:'real-side-panel',widths:[undefined]});
  await editor.getByRole('button',{name:'取消',exact:true}).click();
  const item=await readItem(page,evidence.keePassText.itemId);
  assert.deepEqual(JSON.parse(item.sshKeyData),evidence.keePassText.expected);
  evidence.keePassText.checks.push('actual side panel advanced layout and cancel');
}
