import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import type { LoginItem } from '../../src/core/model';

async function send(page: Page, request: object): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), request);
  expect(result.ok, result.error).toBe(true); return result.data;
}

test('supplemental content uses one entry style and isolated editors that retain drafts', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale:'zh-CN', colorScheme:'dark', reducedMotion:'reduce', viewport:{width:1180,height:1000},
    args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page,{type:'VAULT_SETUP',masterPassword:''}); await page.reload();
    await page.getByRole('button',{name:'选择新建类型',exact:true}).click();
    await page.locator('[data-create-type="PASSWORD"]').click();
    await page.getByLabel('名称 *',{exact:true}).fill('Synthetic content layout');
    const form = page.locator('#login-item-form');
    const entries = form.locator('.editor-extras > .editor-content-section');
    await expect(entries).toHaveCount(10);
    await expect(form.locator('.editor-extras m3e-expansion-panel,.editor-extras input,.editor-extras textarea,.editor-extras m3e-select')).toHaveCount(0);
    const geometry = await entries.locator('.editor-content-row').evaluateAll(rows => rows.map(row => {
      const style = getComputedStyle(row), button = getComputedStyle(row.querySelector('button')!);
      return [style.borderRadius,style.backgroundColor,button.minHeight,button.padding];
    }));
    expect(new Set(geometry.map(value => JSON.stringify(value))).size).toBe(1);
    const sheet = page.locator('.editor-content-dialog');
    const open = async (name: string) => { await entries.getByRole('button',{name,exact:true}).click(); await expect(sheet).toBeVisible(); };
    const done = async () => { await sheet.getByRole('button',{name:'完成',exact:true}).click(); await expect(sheet).toHaveCount(0); };
    await open('银行卡与支付');
    await sheet.getByLabel('卡号',{exact:true}).fill('4111111111111111');
    await sheet.getByLabel('持卡人',{exact:true}).fill('Synthetic Holder');
    await page.keyboard.press('Enter');
    expect(await send(page,{type:'VAULT_LIST_ITEMS'})).toHaveLength(0);
    await expect(sheet).toBeVisible(); await done();
    await expect(entries.getByRole('button',{name:'银行卡与支付',exact:true})).toBeFocused();
    await open('银行卡与支付'); await expect(sheet.getByLabel('持卡人',{exact:true})).toHaveValue('Synthetic Holder');
    await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0); await expect(form).toBeVisible();
    for (const name of ['个人信息','地址','两步验证','登录方式','更多选项','内容顺序']) { await open(name); await done(); }
    await open('笔记与恢复备注'); await sheet.getByLabel('恢复备注与笔记',{exact:true}).fill('Synthetic recovery note'); await done();
    await open('自定义字段'); await sheet.getByRole('button',{name:'添加字段',exact:true}).click();
    await sheet.getByLabel('自定义字段 1 名称',{exact:true}).fill('Recovery'); await sheet.getByLabel('自定义字段 1 值',{exact:true}).fill('Synthetic secret');
    await page.setViewportSize({width:320,height:850});
    await page.evaluate(() => { document.documentElement.style.fontSize='200%'; });
    expect(await sheet.locator('.editor-content-fields').evaluate(node => node.scrollWidth<=node.clientWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath('custom-fields-320-large.png')}); await done();
    await entries.first().scrollIntoViewIfNeeded(); await page.screenshot({path:info.outputPath('content-list-320-large.png')});
    await page.evaluate(() => { document.documentElement.style.fontSize=''; }); await page.setViewportSize({width:1180,height:1000});
    await open('添加内容'); await sheet.getByRole('button',{name:'API Key',exact:true}).click();
    await expect(sheet.getByRole('heading',{name:'API Key',exact:true})).toBeVisible();
    await sheet.getByLabel('内容名称',{exact:true}).fill('Synthetic API'); await sheet.getByLabel('Key',{exact:true}).fill('synthetic-api-secret');
    await sheet.getByRole('button',{name:'保存内容草稿',exact:true}).click(); await expect(sheet).toHaveCount(0);
    await expect(entries.getByRole('button',{name:'Synthetic API',exact:true})).toBeVisible();
    await open('内容顺序');
    const beforeOrder = await sheet.locator('[data-order-token]').evaluateAll(rows => rows.map(row => row.getAttribute('data-order-token')));
    const down = sheet.getByRole('button',{name:'下移Synthetic API',exact:true});
    await (await down.isEnabled() ? down : sheet.getByRole('button',{name:'上移Synthetic API',exact:true})).click();
    expect(await sheet.locator('[data-order-token]').evaluateAll(rows => rows.map(row => row.getAttribute('data-order-token')))).not.toEqual(beforeOrder);
    await done();
    await entries.first().scrollIntoViewIfNeeded(); await page.screenshot({path:info.outputPath('content-list-dark.png')});
    await page.emulateMedia({colorScheme:'light'}); await page.screenshot({path:info.outputPath('content-list-light.png')});
    await page.getByRole('button',{name:'加密保存',exact:true}).click(); await expect(form).toHaveCount(0);
    const items = await send(page,{type:'VAULT_LIST_ITEMS'}) as LoginItem[];
    expect(items).toHaveLength(1); expect(items[0]).toMatchObject({title:'Synthetic content layout',notes:'Synthetic recovery note',creditCardHolder:'Synthetic Holder',creditCardNumber:'4111111111111111'});
    expect(items[0].customFields).toContainEqual({name:'Recovery',value:'Synthetic secret',protected:false});
    await page.reload(); await page.getByRole('button',{name:'查看Synthetic content layout详情',exact:true}).click();
    await page.locator('.detail-dialog').getByRole('button',{name:'编辑',exact:true}).click();
    await open('Synthetic API'); await expect(sheet.getByLabel('Key',{exact:true})).toHaveValue('synthetic-api-secret');
    await sheet.getByRole('button',{name:'取消',exact:true}).click(); await expect(sheet).toHaveCount(0);
    await page.getByRole('button',{name:'取消',exact:true}).click();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('API keys, notes and authenticators share supplemental entry navigation', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale:'zh-CN', reducedMotion:'reduce', viewport:{width:1000,height:900},
    args:[`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage(); await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    await send(page,{type:'VAULT_SETUP',masterPassword:''}); await page.reload();
    for (const kind of ['secure-note','totp','api-token']) {
      await page.getByRole('button',{name:'选择新建类型',exact:true}).click(); await page.locator(`[data-create-type="${kind}"]`).click();
      const entries = page.locator('.editor-extras > .editor-content-section');
      await expect(entries).toHaveCount(kind==='totp' ? 2 : 3);
      await entries.getByRole('button',{name:'备注',exact:true}).click();
      const sheet = page.locator('.editor-content-dialog');
      await sheet.getByLabel('备注',{exact:true}).fill('Synthetic draft');
      await sheet.getByRole('button',{name:'完成',exact:true}).click();
      await entries.getByRole('button',{name:'备注',exact:true}).click();
      await expect(sheet.getByLabel('备注',{exact:true})).toHaveValue('Synthetic draft');
      await page.keyboard.press('Escape'); await expect(sheet).toHaveCount(0);
      if (kind !== 'totp') {
        await entries.getByRole('button',{name:'自定义字段',exact:true}).click();
        await sheet.getByRole('button',{name:'添加字段',exact:true}).click();
        await sheet.getByLabel('自定义字段 1 名称',{exact:true}).fill('Scope');
        await sheet.getByLabel('自定义字段 1 值',{exact:true}).fill('Synthetic value');
        await sheet.getByRole('button',{name:'完成',exact:true}).click();
      }
      if (kind==='api-token') {
        await page.getByLabel('名称 *',{exact:true}).fill('Synthetic API token');
        await page.getByLabel('服务商 *',{exact:true}).fill('github');
        await page.getByLabel('API 密钥 *',{exact:true}).fill('synthetic-token');
        await page.getByRole('button',{name:'加密保存',exact:true}).click();
        await expect(page.locator('#api-token-form')).toHaveCount(0);
        const items = await send(page,{type:'VAULT_LIST_ITEMS'});
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({kind:'api-token',token:'synthetic-token',notes:'Synthetic draft',customFields:[{name:'Scope',value:'Synthetic value',protected:true}]});
      } else {
        await page.getByRole('button',{name:'取消',exact:true}).click();
        expect(await send(page,{type:'VAULT_LIST_ITEMS'})).toHaveLength(0);
      }
    }
  } finally { await context.close(); }
});
