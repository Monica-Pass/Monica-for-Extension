import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { fill } from './interop-315-edge-features.mjs';

export async function runSourceStatusUi({page,evidence,screenshot}) {
  const fixture=JSON.parse(await readFile(process.env.MONICA_315_SSO_EDGE_FIXTURES,'utf8')).keepass;
  assert.equal(new URL(fixture.baseUrl).hostname,'127.0.0.1');
  await page.getByRole('button',{name:'密码源',exact:true}).click();
  await page.locator('m3e-list-action').filter({hasText:'连接 KeePass'}).click();
  const dialog=page.getByRole('dialog',{name:'连接 KeePass',exact:true});
  await dialog.getByRole('radio',{name:'WebDAV 文件',exact:true}).click();
  await fill(dialog,{'显示名称':fixture.name,'WebDAV 地址':fixture.baseUrl,'用户名':fixture.username,'WebDAV 密码':fixture.password,'远端 .kdbx 位置':fixture.remotePath,'数据库密码（可留空）':fixture.databasePassword});
  await dialog.getByRole('button',{name:'连接并解锁',exact:true}).click();
  await dialog.waitFor({state:'hidden',timeout:60000});
  const card=page.locator('[data-home-provider-id]').filter({has:page.getByRole('heading',{name:fixture.name,exact:true})});
  const status=card.locator('.keepass-source-status');
  await expect(status.locator('dd')).toHaveText(['已解锁','可用','已同步']);
  const info=card.locator('summary').filter({hasText:'数据库信息'});
  await expect(card.locator('.provider-session-summary')).toBeHidden();
  await info.focus(); await info.press('Enter');
  await expect(card.locator('.provider-session-summary')).toBeVisible();
  await info.press('Enter');
  await expect(card.locator('.provider-session-summary')).toBeHidden();
  for(const width of [1280,420,320]) {
    await page.setViewportSize({width,height:920});
    await status.scrollIntoViewIfNeeded();
    const boxes=await status.locator('.keepass-source-status-row').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,width:r.width,height:r.height,right:r.right}}));
    assert.ok(boxes.every(box=>box.x>=0&&box.right<=width&&box.height>=64));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const insets=await card.evaluate(node=>{
      const outer=node.getBoundingClientRect();
      const content=node.querySelector('[slot="content"]').getBoundingClientRect();
      return {left:content.left-outer.left,right:outer.right-content.right};
    });
    assert.ok(Math.abs(insets.left-insets.right)<=1,`Source card insets must be balanced at ${width}px: ${JSON.stringify(insets)}`);
    if(width<=580) {
      const actions=await card.locator('.source-actions > :is(m3e-button,m3e-icon-button)').evaluateAll(nodes=>nodes.map(node=>{const box=node.getBoundingClientRect();return {width:box.width,height:box.height}}));
      assert.ok(actions.every(box=>box.width>=48&&box.height>=48),'Every portrait source action must have a 48px target: '+JSON.stringify(actions));
    }
    await card.evaluate(node=>window.scrollTo({top:scrollY+node.getBoundingClientRect().top-150,behavior:'instant'}));
    await screenshot(page,`source-status-${width}.png`);
  }
  await card.getByRole('button',{name:'锁定',exact:true}).click();
  await expect(status.locator('dd')).toHaveText(['可恢复','可用','已同步']);
  const restore=card.getByRole('button',{name:'恢复本机会话',exact:true});
  await restore.focus();await restore.press('Enter');
  await expect(status.locator('dd')).toHaveText(['已解锁','可用','已同步']);
  await status.scrollIntoViewIfNeeded();
  await screenshot(page,'source-status-restored-320.png');
  await page.setViewportSize({width:1280,height:920});
  await page.getByRole('button',{name:/^全部项目/}).click();
  evidence.sourceStatus={status:'passed',widths:[1280,420,320],actualApache:true,lockRestore:true,keyboard:true,disclosure:true,balancedInsets:true,portraitActionTargets:48};
}
