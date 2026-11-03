import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';

async function send(page: Page, input: unknown): Promise<any> {
  const result = await page.evaluate(input => chrome.runtime.sendMessage(input), input);
  expect(result.ok, JSON.stringify(result)).toBe(true); return result.data;
}
// A complete synthetic PNG, never a real user's card or attachment.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';

test('card gallery reads all Android-style local images across navigation, updates and lock', async ({}, info) => {
  test.setTimeout(120000);
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale:'zh-CN', viewport:{width:1800,height:1500},
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`] });
  try {
    const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page=await context.newPage(), url=`chrome-extension://${new URL(worker.url()).host}/index.html`;
    await page.goto(url);await send(page,{type:'VAULT_SETUP',masterPassword:''});
    const now=new Date().toISOString(),items=Array.from({length:12},(_,i)=>({id:`artwork-${i}`,kind:'card',title:`Synthetic card ${String(i).padStart(2,'0')}`,notes:'',favorite:false,providerRefs:[],createdAt:now,updatedAt:now,
      number:'00001234',cardholderName:'Synthetic',bankName:'Test bank',brand:'',expiryMonth:'',expiryYear:'',cvv:'',cardFace:{imageAttachmentName:'card.png',displayMode:'HIDDEN'}}));
    await send(page,{type:'VAULT_IMPORT_ITEMS',items});
    for (const [i,item] of items.entries()) {
      const upload=await send(page,{type:'PROVIDER_ATTACHMENT_UPLOAD_BEGIN',providerId:'local',itemId:item.id,fileName:'card.png',sizeBytes:Buffer.from(png,'base64').length,...(i<8?{mediaType:'image/png'}:{})});
      await send(page,{type:'PROVIDER_ATTACHMENT_UPLOAD_CHUNK',providerId:'local',transferId:upload.transferId,offset:0,dataBase64:png});
      await send(page,{type:'PROVIDER_ATTACHMENT_UPLOAD_FINISH',providerId:'local',itemId:item.id,transferId:upload.transferId});
      await send(page,{type:'PROVIDER_ATTACHMENT_UPLOAD_ABORT',providerId:'local',transferId:upload.transferId});
    }
    await page.reload();
    const wallet=async()=>{
      await expect(page.locator('#primary-navigation')).toBeAttached();
      const target=page.locator('#primary-navigation').getByRole('button',{name:/^钱包与身份/});
      if(!await target.isVisible())await page.getByRole('button',{name:'打开导航',exact:true}).click();
      await target.click();
    };
    const assertGallery=async()=>{
      await expect(page.locator('.wallet-card-face')).toHaveCount(12);
      await expect.poll(()=>page.locator('.wallet-card-face img').evaluateAll(images=>images.filter(img=>(img as HTMLImageElement).complete&&(img as HTMLImageElement).naturalWidth>0).length),{timeout:20000}).toBe(12);
      await expect(page.locator('.wallet-card-image-error')).toHaveCount(0);
    };
    await wallet();await assertGallery();
    await page.getByRole('button',{name:'查看Synthetic card 11详情',exact:true}).click();
    await expect.poll(()=>page.locator('.detail-card-face .wallet-card-face img').evaluateAll(images=>images.filter(img=>(img as HTMLImageElement).naturalWidth>0).length)).toBe(1);
    await page.getByRole('button',{name:'打开卡面图片',exact:true}).click();
    await expect.poll(()=>page.locator('.attachment-viewer img').evaluateAll(images=>images.filter(img=>(img as HTMLImageElement).naturalWidth>0).length)).toBe(1);
    await page.getByRole('button',{name:'关闭附件',exact:true}).click();await page.getByRole('button',{name:'关闭详情',exact:true}).click();
    await assertGallery();await page.screenshot({path:info.outputPath('synthetic-gallery.png')});
    const attachments=await send(page,{type:'PROVIDER_ATTACHMENT_LIST',providerId:'local',itemId:items[0].id});
    const held=[];
    for(let i=0;i<4;i++)held.push(await send(page,{type:'PROVIDER_ATTACHMENT_READ_BEGIN',providerId:'local',itemId:items[0].id,attachmentId:attachments.items[0].attachmentId}));
    await page.reload();await wallet();
    await expect(page.locator('.wallet-card-face[aria-busy="true"]').first()).toBeVisible();
    for(const read of held)await send(page,{type:'PROVIDER_ATTACHMENT_READ_RELEASE',providerId:'local',readHandle:read.readHandle});
    await assertGallery();
    for(let i=0;i<3;i++){await page.reload();await wallet();await assertGallery();}
    const updated=await send(page,{type:'VAULT_GET_ITEM',itemId:items[0].id});
    await send(page,{type:'VAULT_UPSERT_ITEM',item:{...updated,title:'Synthetic changed title'}});
    await expect(page.getByRole('button',{name:'查看Synthetic changed title详情',exact:true})).toBeVisible();await assertGallery();
    await send(page,{type:'VAULT_LOCK'});await page.reload();await expect(page.locator('.wallet-card-face img')).toHaveCount(0);
    await send(page,{type:'VAULT_UNLOCK',masterPassword:''});await page.reload();await wallet();await assertGallery();
  } finally {await context.close();}
});
