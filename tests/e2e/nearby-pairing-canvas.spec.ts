import {test,expect} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {launchEdgeContext} from './fixtures/edge';
test('local pairing Canvas uses QR and links without manual addresses',async({},info)=>{
  const run=info.outputPath('isolated');await mkdir(run,{recursive:true});
  const context=await launchEdgeContext(path.join(run,'profile'),{viewport:{width:1880,height:1100}});
  try{const page=await context.newPage();await page.goto((await readFile('docs/design/nearby-pairing-320.md','utf8')).match(/\((http:\/\/127[^)]+)\)/)![1]);
    await expect(page.getByText('配置本机通信组件',{exact:true}).first()).toBeVisible();
    await expect(page.getByText('改为输入配对链接',{exact:true}).first()).toBeVisible();
    await expect(page.getByText('本机处理 3 项',{exact:true}).first()).toBeVisible();
    await page.getByTitle('Fit',{exact:true}).first().click();
    await page.screenshot({path:path.join(run,'canvas.png'),fullPage:true});
  }finally{await context.close();}
});
