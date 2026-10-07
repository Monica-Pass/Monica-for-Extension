import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import kdbx from 'kdbxweb';
import { expect } from '@playwright/test';
import { loginEditor, save, readItem, chooseOption } from './interop-315-edge-features.mjs';

const password='synthetic-gpg-fixture';
const publicKey='-----BEGIN PGP PUBLIC KEY BLOCK-----\r\nsynthetic\tpublic key\r\n';
const snapshot=item=>({title:item.title,password:item.password,loginType:item.loginType,customFields:item.customFields});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const addresses={relative:'/v1/chat/completions',service:'internal service: staging',protocol:'grpc://synthetic.invalid:443',userinfo:'https://user:synthetic@example.invalid/api',script:'javascript:synthetic()',long:'route/'+'x'.repeat(2200),empty:''};

export async function runGpgFieldUi({page,evidence,screenshot,output}) {
  const db=kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)),'Synthetic GPG field preservation');
  db.setVersion(3);db.header.keyEncryptionRounds=1000;
  const entry=db.createEntry(db.getDefaultGroup());entry.fields.set('Title','GPG field preservation');
  entry.fields.set('Password',kdbx.ProtectedValue.fromString('synthetic-private-key'));
  entry.fields.set('monica_gpg_type','GPG_KEY');
  for(const [name,value] of [['before','retained'],['monica_gpg_public_0000',publicKey.slice(0,23)],['monica_gpg_fingerprint','old fingerprint'],['middle','0007'],['monica_gpg_public_0001',publicKey.slice(23)],['monica_gpg_user_id','old user']]) entry.fields.set(name,kdbx.ProtectedValue.fromString(value));
  for(const [name,address] of Object.entries(addresses)) {
    const api=db.createEntry(db.getDefaultGroup());api.fields.set('Title',`API address ${name}`);
    api.fields.set('Password',kdbx.ProtectedValue.fromString(`synthetic-${name}`));
    api.fields.set('before',kdbx.ProtectedValue.fromString('retained'));api.fields.set('monica_api_key_type','API_KEY');
    if(address) api.fields.set('monica_api_key_url',kdbx.ProtectedValue.fromString(address));
    api.fields.set('after',kdbx.ProtectedValue.fromString('0007'));
  }
  const input=join(output,'synthetic-gpg.kdbx');await writeFile(input,new Uint8Array(await db.save()));
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
  const find=async(source,title='GPG field preservation')=>{
    const response=await page.evaluate(()=>chrome.runtime.sendMessage({type:'VAULT_LIST_ITEMS'}));assert.equal(response.ok,true);
    const item=response.data.find(value=>value.title===title&&value.providerRefs.some(ref=>ref.providerId===source.id));assert.ok(item,title);
    return readItem(page,item.id);
  };
  const edit=async(title='GPG field preservation')=>{
    await page.getByLabel('搜索密码库',{exact:true}).click();
    await page.getByLabel('搜索密码库',{exact:true}).fill(title);
    await expect(page.getByLabel('搜索密码库',{exact:true})).toHaveValue(title);
    await page.getByLabel(`查看${title}详情`,{exact:true}).first().click();
    await expect(page.locator('[role="dialog"][data-item-kind="login"] a[href^="javascript:"]')).toHaveCount(0);
    await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button',{name:'编辑',exact:true}).click();
    return loginEditor(page);
  };
  const source=await connect(input,'GPG 字段验证');await flush(source);
  const initial=await find(source);assert.equal(initial.loginType,'GPG_KEY');
  const expected=snapshot(initial);
  for(const [label,name,value] of [['指纹','monica_gpg_fingerprint','  edited fingerprint  '],['用户身份','monica_gpg_user_id','']]) {
    const editor=await edit();await page.setViewportSize({width:320,height:900});
    await expect(editor.getByLabel('GPG 公钥',{exact:true})).toHaveValue(publicKey.replaceAll('\r\n','\n'));
    await editor.getByLabel(label,{exact:true}).fill(value);
    await screenshot(page,`gpg-${name}-320.png`);
    await save(editor);await flush(source);
    expected.customFields=expected.customFields.map(field=>field.name===name?{...field,value}:field);
    assert.deepEqual(snapshot(await find(source)),expected);
  }
  const editor=await edit();await editor.getByLabel('GPG 公钥',{exact:true}).fill('cancelled key replacement');
  await editor.getByRole('button',{name:'取消',exact:true}).click();
  await editor.waitFor({state:'hidden'});
  assert.deepEqual(snapshot(await find(source)),expected);
  const apiExpected=[];
  for(const [name,address] of Object.entries(addresses)) {
    const title=`API address ${name}`,initial=await find(source,title),api=snapshot(initial);
    assert.equal(api.loginType,'API_KEY');
    const form=await edit(title);await page.setViewportSize({width:420,height:900});
    await expect(form.getByLabel('API 地址',{exact:true})).toHaveValue(address);
    const changed={service:'/v2/services: 中文',userinfo:'',empty:'/new'};
    if(name==='relative') {api.title+=' renamed';await form.getByLabel('名称 *',{exact:true}).fill(api.title);}
    if(Object.hasOwn(changed,name)) {
      await form.getByLabel('API 地址',{exact:true}).fill(changed[name]);
      api.customFields=api.customFields.map(field=>field.name==='monica_api_key_url'?{...field,value:changed[name]}:field);
      if(name==='empty') api.customFields.push({name:'monica_api_key_url',value:changed[name],protected:false});
    }
    if(name==='protocol') {await form.getByLabel('API 地址',{exact:true}).fill('cancelled draft');await form.getByRole('button',{name:'取消',exact:true}).click();await form.waitFor({state:'hidden'});}
    else await save(form);
    await flush(source);assert.deepEqual(snapshot(await find(source,api.title)),api);apiExpected.push(api);
  }
  await page.getByRole('button',{name:'选择新建类型',exact:true}).click();
  await page.locator('m3e-menu-item[data-create-type="API_KEY"]').click();
  const create=loginEditor(page);await create.getByLabel('名称 *',{exact:true}).fill('API address edge');
  await chooseOption(create.getByLabel('保存到',{exact:true}),{label:'GPG 字段验证'});
  await create.getByLabel('API Key',{exact:true}).fill('synthetic-edge-api');
  await create.getByLabel('API 地址',{exact:true}).fill('localhost:9080/api');
  await page.setViewportSize({width:320,height:900});await create.getByLabel('API 地址',{exact:true}).scrollIntoViewIfNeeded();
  await screenshot(page,'api-address-kdbx-create-320.png');await save(create);await flush(source);
  const created=await find(source,'API address edge');assert.equal(created.password,'synthetic-edge-api');
  assert.equal(created.customFields.find(field=>field.name==='monica_api_key_url')?.value,'localhost:9080/api');apiExpected.push(snapshot(created));
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  const download=page.waitForEvent('download');await source.card.getByRole('button',{name:'导出 KDBX',exact:true}).click();
  const exported=join(output,'edge-gpg.kdbx');await(await download).saveAs(exported);
  const reopened=await connect(exported,'GPG 导出重开');await flush(reopened);
  const item=await find(reopened);assert.deepEqual(snapshot(item),expected);
  const apiItems=[];for(const expected of apiExpected) {const actual=await find(reopened,expected.title);assert.deepEqual(snapshot(actual),expected);apiItems.push({id:actual.id,expected});}
  evidence.apiAddressFile={status:'passed',layer:'Synthetic KDBX in actual Edge; not Android application evidence',items:apiItems,checks:['seven imported arbitrary addresses','rename, edit, clear and cancel','create localhost address at320px','protected field attributes and order','UI export and second-source reopen']};
  evidence.gpgFields={status:'passed',layer:'Synthetic KDBX in actual Edge; not Android application evidence',inputSha256:hash(await readFile(input)),exportSha256:hash(await readFile(exported)),itemId:item.id,expected,checks:['320px fingerprint edit','clear protected user ID','retain exact legacy public chunks, order and protection','cancel public-key replacement','UI export and second-source reopen']};
}

export async function verifyGpgFieldPersistence(page,evidence) {
  assert.deepEqual(snapshot(await readItem(page,evidence.gpgFields.itemId)),evidence.gpgFields.expected);
  evidence.gpgFields.restartVerified=true;
  for(const {id,expected} of evidence.apiAddressFile.items) assert.deepEqual(snapshot(await readItem(page,id)),expected);
  evidence.apiAddressFile.restartVerified=true;
}
