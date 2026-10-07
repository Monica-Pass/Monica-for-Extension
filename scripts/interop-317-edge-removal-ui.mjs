import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import { runRemovalRuntime, verifyRemovalRuntime } from './interop-317-edge-removal-runtime.mjs';
import { readItem } from './interop-315-edge-features.mjs';

const rpc = async (page, request) => {
  const result = await page.evaluate(request => chrome.runtime.sendMessage(request), request);
  assert.equal(result.ok, true, JSON.stringify(result)); return result.data;
};
async function watchRequests(page) {
  await page.evaluate(() => {
    if (window.__removalUiOriginalSend) return;
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__removalUiOriginalSend = original;
    window.__removalUiCalls = [];
    chrome.runtime.sendMessage = function(request, ...args) {
      const promise = original(request, ...args);
      if (request?.type === 'VAULT_PASSWORD_PROJECT_REMOVE') {
        const call = { input: structuredClone(request.input), confirmed: request.confirmed };
        window.__removalUiCalls.push(call);
        promise.then(result => { call.result = result; });
        if (window.__removalUiDropNext) {
          window.__removalUiDropNext = false;
          return promise.then(() => undefined);
        }
      }
      return promise;
    };
  });
}
async function editor(page, title) {
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.getByRole('button', { name: /^全部项目/ }).click();
  await page.getByLabel('搜索密码库', { exact: true }).fill(title);
  await page.getByLabel(`查看${title}详情`, { exact: true }).first().click();
  await page.locator('[role="dialog"][data-item-kind="login"]').getByRole('button',{name:'编辑',exact:true}).click();
  const dialog = page.locator('m3e-dialog.material-editor-dialog');
  await expect(dialog.locator('[data-project-credential-editor]').first()).toBeVisible();
  return dialog;
}
function primary(dialog, current) {
  const id = JSON.parse(current[0].customFields.find(field => field.name === 'monica.content.credential').value).groupId;
  return dialog.locator(`[data-credential-group="${id}"]`);
}
export async function runRemovalUi({ page, evidence, screenshot }) {
  evidence.removalUi = { status: 'running', checks: [] };
  await watchRequests(page);
  await runRemovalRuntime({page, evidence, ui: {
    async remove({page, mode, current}) {
      const title = current[0].title;
      let dialog = await editor(page, title);
      let before = await page.evaluate(() => window.__removalUiCalls.length);
      if (mode === 'complete') {
        const group = primary(dialog, current), remove = group.locator('[data-remove-password]').first();
        await remove.focus(); await remove.press('Enter');
        await expect(remove).toHaveAttribute('aria-label', '撤销移除密码 1');
        await expect(remove).toBeFocused();
        await remove.press('Enter');
        await expect(remove).toHaveAttribute('aria-label', '移除密码 1');
        for (const width of [1280, 420, 320]) {
          await page.setViewportSize({width,height:950});
          await group.scrollIntoViewIfNeeded();
          const dimensions = await group.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
          assert.ok(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
          for (const button of await group.locator('[data-remove-password]').all()) {
            const box = await button.boundingBox(); assert.ok(box.width >= 48 && box.height >= 48, JSON.stringify(box));
          }
          await screenshot(page, `member-removal-edit-${width}.png`);
        }
        await group.locator('[data-remove-group]').click();
        await expect(group.getByText('整组待移除，保存项目后生效。')).toBeVisible();
        await expect(dialog.locator('[data-remove-password]')).toHaveCount(1);
        await expect(dialog.locator('[data-remove-password]')).toBeDisabled();
        await dialog.getByRole('button', {name:'查看移除并保存',exact:true}).click();
        await expect(dialog.locator('[data-removal-review-title]')).toBeFocused();
        await screenshot(page, 'member-removal-confirm-320.png');
        assert.ok(!(await dialog.locator('[data-removal-review]').innerText()).includes(current[0].password));
        await dialog.getByRole('button',{name:'返回编辑',exact:true}).click();
        await expect(dialog.locator('[data-credential-save]')).toBeFocused();
        await group.locator('[data-remove-group]').click();
        await expect(group.locator('[data-password-row]')).toHaveCount(2);
        await dialog.getByRole('button',{name:'取消',exact:true}).click();
        await dialog.waitFor({state:'hidden'});
        for (const row of current) assert.deepEqual(await readItem(page,row.id),row);
        assert.equal(await page.evaluate(()=>window.__removalUiCalls.length),before);
        evidence.removalUi.checks.push('remove/undo stable password identity', 'whole-group draft selection', 'last password protected', 'cancel leaves exact original snapshot', '320/420/1280px and 48px targets', 'keyboard and confirmation focus');
        // A real concurrent edit invalidates the saved editor revisions. The UI
        // must retain this unsaved draft and its selection when staging rejects.
        dialog = await editor(page,title);
        await dialog.getByLabel('名称 *',{exact:true}).fill('Unsaved title survives rejected stage');
        await primary(dialog,current).locator('[data-remove-group]').click();
        await dialog.getByRole('button',{name:'查看移除并保存',exact:true}).click();
        const survivor = current[2];
        await rpc(page,{type:'VAULT_UPSERT_ITEM',item:{...survivor,password:survivor.password+'-concurrent'},expectedUpdatedAt:survivor.updatedAt});
        await dialog.getByRole('button',{name:'确认移除并保存',exact:true}).click();
        await page.waitForFunction(index=>window.__removalUiCalls[index]?.result !== undefined,before);
        const rejected = await page.evaluate(index=>window.__removalUiCalls[index],before);
        assert.equal(rejected.result.code,'password-project-removal-not-staged');
        await expect(dialog.getByLabel('名称 *',{exact:true})).toHaveValue('Unsaved title survives rejected stage');
        await expect(dialog.getByLabel('名称 *',{exact:true})).toBeVisible();
        await expect(dialog.locator('[data-removal-review]')).toHaveCount(0);
        assert.deepEqual(await rpc(page,{type:'VAULT_PASSWORD_PROJECT_REMOVALS',operationId:rejected.input.operationId}),[]);
        await dialog.getByRole('button',{name:'取消',exact:true}).click();
        await dialog.waitFor({state:'hidden'});
        const latest = await Promise.all(current.map(row=>readItem(page,row.id)));
        current.splice(0,current.length,...latest);
        before = await page.evaluate(()=>window.__removalUiCalls.length);
        evidence.removalUi.checks.push('concurrent update rejects before staging and retains unsaved editor draft');
        dialog = await editor(page, title);
        // Let the real backend commit, then discard only its response to this UI.
        await page.evaluate(()=>{window.__removalUiDropNext=true;});
      }
      await primary(dialog,current).locator('[data-remove-group]').click();
      await dialog.getByRole('button',{name:'查看移除并保存',exact:true}).click();
      assert.equal(await page.evaluate(()=>window.__removalUiCalls.length),before, 'Review must not write');
      await dialog.getByRole('button',{name:'确认移除并保存',exact:true}).click();
      await page.waitForFunction(index=>window.__removalUiCalls[index]?.result !== undefined,before,{timeout:60000});
      const call = await page.evaluate(index=>window.__removalUiCalls[index],before);
      assert.equal(call.confirmed,true); assert.deepEqual(call.input.items.map(row=>row.id).sort(),current.map(row=>row.id).sort());
      assert.deepEqual([...call.input.removedItemIds].sort(),current.slice(0,2).map(row=>row.id).sort());
      if (mode === 'complete') {
        await dialog.waitFor({state:'hidden'});
        assert.equal(await page.evaluate(()=>window.__removalUiCalls.length),before+1);
        evidence.removalUi.checks.push('lost successful response is resolved from durable receipt without duplicate removal');
      }
      else {
        await expect(dialog.getByRole('alert')).toBeVisible();
        await expect(dialog.getByRole('button',{name:'重试这次保存',exact:true})).toBeVisible();
        await dialog.getByRole('button',{name:'重试这次保存',exact:true}).click();
        await page.waitForFunction(index=>window.__removalUiCalls[index]?.result !== undefined,before+1);
        const retry = await page.evaluate(index=>window.__removalUiCalls[index],before+1);
        assert.deepEqual(retry.input,call.input,'Retry must preserve full original request and ID');
        await dialog.getByRole('button',{name:'查看待处理操作',exact:true}).click();
        await dialog.waitFor({state:'hidden'});
        const panel = page.locator(`[data-removal-operation="${call.input.operationId}"]`);
        await expect(panel).toBeVisible();
        await expect(panel.getByRole('button',{name:'解锁并设置',exact:true})).toBeVisible();
        await page.setViewportSize({width:320,height:950});
        await panel.scrollIntoViewIfNeeded(); await screenshot(page,`member-removal-pending-${mode}-320.png`);
        const dimensions = await panel.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
        assert.ok(dimensions.scroll<=dimensions.width+1);
        await page.setViewportSize({width:1280,height:950});
      }
      return {operationId:call.input.operationId,result:call.result};
    },
    async cancel(page, operationId) {
      const panel = page.locator(`[data-removal-operation="${operationId}"]`);
      await panel.getByRole('button',{name:'取消这次移除',exact:true}).click();
      await panel.waitFor({state:'hidden'});
      const receipt = await rpc(page,{type:'VAULT_PASSWORD_PROJECT_REMOVALS',operationId});
      assert.equal(receipt[0].status,'cancelled');
      evidence.removalUi.checks.push('pending preparation cancelled through UI while source locked', 'retries keep exact operation and rich draft');
    }
  }});
  await page.setViewportSize({width:1280,height:950});
  await page.getByRole('button',{name:/^全部项目/}).click();
  await page.getByLabel('搜索密码库',{exact:true}).fill('');
}

export async function verifyRemovalUi(page,evidence,screenshot) {
  await verifyRemovalRuntime(page,evidence,async (page,state,restart) => {
    await page.getByRole('button',{name:'密码源',exact:true}).click();
    const panel=page.locator(`[data-removal-operation="${restart.operationId}"]`);
    await expect(panel).toBeVisible();
    await screenshot(page,'member-removal-restarted-pending.png');
    await panel.getByRole('button',{name:'解锁并设置',exact:true}).click();
    const sourceDialog = page.locator('.mdbx2-dialog[role="dialog"]');
    await sourceDialog.getByLabel('保险库密码（可留空）',{exact:true}).fill('Synthetic transfer fixture password');
    await sourceDialog.getByRole('button',{name:'解锁本机副本',exact:true}).click();
    await sourceDialog.getByRole('button',{name:'解锁本机副本',exact:true}).waitFor({state:'hidden'});
    await sourceDialog.getByRole('button',{name:'取消',exact:true}).click();
    await sourceDialog.waitFor({state:'hidden'});
    await panel.locator('[data-removal-resume]').click();
    await panel.waitFor({state:'hidden',timeout:60000});
    evidence.removalUi.checks.push('real browser restart retains visible operation', 'pending panel opens actual source unlock dialog', 'pending panel resumes actual Native removal');
  });
  evidence.removalUi.status='passed';
}
