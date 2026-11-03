import { expect as baseExpect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { temporaryNativeHost } from './fixtures/native-host';
const expect = baseExpect.configure({timeout:30000});

test('CLI integration defaults off, persists opt-in and closes an active view when disabled', async ({}, info) => {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('cli-opt-in-profile'), {
    locale: 'zh-CN', viewport: { width: 1200, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    // A local protocol stub observes connections without touching a user's CLI.
    await context.addInitScript(() => {
      if (!globalThis.chrome?.runtime?.connectNative) return;
      const probe = { connections: 0, disconnections: 0 };
      Object.assign(window, { cliOptInProbe: probe });
      chrome.runtime.connectNative = (() => {
        probe.connections++;
        const listeners = new Set<(value: unknown) => void>();
        return {
          onMessage: { addListener: (fn: (value: unknown) => void) => listeners.add(fn), removeListener: (fn: (value: unknown) => void) => listeners.delete(fn) },
          onDisconnect: { addListener() {}, removeListener() {} },
          postMessage: (request: { id: number }) => queueMicrotask(() => listeners.forEach(fn => fn({ id: request.id, ok: true, data: { protocol: 2, version:'1.0.101',integration_revision:2,capabilities:['snapshots','mutation_receipts'],databases: [] } }))),
          disconnect: () => { probe.disconnections++; }
        } as unknown as chrome.runtime.Port;
      }) as typeof chrome.runtime.connectNative;
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = `chrome-extension://${new URL(worker.url()).host}/index.html`;
    const page = await context.newPage();
    await page.goto(url);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: 'VAULT_SETUP', masterPassword: 'Synthetic CLI preference password' }))).toMatchObject({ ok: true });
    await page.reload();
    const settings = page.locator('#primary-navigation').getByRole('button', { name: '设置与备份', exact: true });
    const cli = page.locator('#primary-navigation').getByRole('button', { name: 'CLI 内容管理 不完善', exact: true });
    await settings.click();
    await expect(cli).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { cliOptInProbe: { connections: number } }).cliOptInProbe.connections)).toBe(0);
    const toggle = page.getByRole('switch', { name: 'CLI 联动 不完善', exact: true });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.focus(); await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(cli).toBeVisible();
    await page.reload();
    await expect(cli).toBeVisible();
    await page.screenshot({ path: info.outputPath('cli-opt-in-enabled.png'), animations: 'disabled' });
    await cli.click();
    await expect(page.locator('[data-cli-management]')).toBeVisible();
    await expect(page.getByText('CLI 尚无数据库，请先运行 monica 初始化或打开数据库。', { exact: true })).toBeVisible();
    await worker.evaluate(() => chrome.storage.local.set({ 'monica.cli.integration.enabled': false }));
    await expect(cli).toHaveCount(0);
    await expect(page.locator('[data-cli-management]')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => (window as unknown as { cliOptInProbe: { disconnections: number } }).cliOptInProbe.disconnections)).toBe(1);
    await toggle.click();
    await expect(cli).toBeVisible();
    const other = await context.newPage(); await other.goto(url);
    await expect(other.locator('#primary-navigation').getByRole('button', { name: 'CLI 内容管理 不完善', exact: true })).toBeVisible();
    await page.bringToFront(); await toggle.click();
    await expect(other.locator('#primary-navigation').getByRole('button', { name: 'CLI 内容管理 不完善', exact: true })).toHaveCount(0);
    await page.reload(); await settings.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.screenshot({ path: info.outputPath('cli-opt-in-settings.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 360, height: 880 });
    await expect.poll(async () => (await page.getByRole('heading', { name: '设置与备份', exact: true }).boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0);
    await expect(toggle).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('cli-opt-in-360.png'), fullPage: true, animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: info.outputPath('cli-opt-in-360-dark.png'), fullPage: true, animations: 'disabled' });
  } finally { await context.close(); }
});

test('Edge graphically manages an actual CLI database through Native Messaging',async({},info)=>{
  test.skip(process.env.MONICA_CLI_INTEROP!=='1','Opt in with MONICA_CLI_INTEROP=1 after building both CLI binaries.');
  test.setTimeout(480000);
  const root=await mkdtemp(path.join(os.tmpdir(),'monica-cli-edge-'));
  const bin=path.resolve(process.env.MONICA_CLI_BIN || '../monica-pass-cli/target/debug');
  const helper=path.join(root,'monica-browser-host.exe');
  await copyFile(path.join(bin,'monica-browser-host.exe'),helper);
  await writeFile(path.join(root,'monica-pass.portable'),'');
  await mkdir(path.join(root,'data'));
  const config=path.join(root,'data/gateway.json');
  const password='Synthetic CLI browser password only!';
  const cli=(args:string[],secrets?:Record<string,string>)=>{
    const output=execFileSync(path.join(bin,'monica-pass.exe'),['-C',config,'--json',...args,...(secrets?['--secrets-stdin']:[])],{input:secrets?JSON.stringify(secrets):undefined,encoding:'utf8',windowsHide:true});
    expect(output).not.toContain(password);return JSON.parse(output);
  };
  cli(['init'],{password});
  const extensionPath=path.resolve('dist');
  const context=await launchEdgeContext(info.outputPath('cli-profile'),{locale:'zh-CN',args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]});
  let native:Awaited<ReturnType<typeof temporaryNativeHost>>|undefined;
  try {
    await context.addInitScript(() => {
      const original=chrome.runtime.connectNative.bind(chrome.runtime);
      const probe={dropNext:'',dropped:0,writes:[] as {op:string;identity:string}[],navigation:[] as string[]};
      Object.assign(window,{cliRecoveryProbe:probe});
      chrome.runtime.connectNative=((name:string)=>{
        if(name!=='app.monica.cli')return original(name);
        const native=original(name),listeners=new Set<(value:unknown)=>void>();
        let dropId:number|undefined;
        native.onMessage.addListener((reply:{id:number})=>{
          if(reply.id===dropId){probe.dropped++;native.disconnect();queueMicrotask(()=>disconnects.forEach(fn=>fn()));return;}
          listeners.forEach(fn=>fn(reply));
        });
        const disconnects=new Set<()=>void>();
        native.onDisconnect.addListener(()=>disconnects.forEach(fn=>fn()));
        return {
          onMessage:{addListener:(fn:(v:unknown)=>void)=>listeners.add(fn),removeListener:(fn:(v:unknown)=>void)=>listeners.delete(fn)},
          onDisconnect:{addListener:(fn:()=>void)=>disconnects.add(fn),removeListener:(fn:()=>void)=>disconnects.delete(fn)},
          postMessage:(message:{id:number;op:string;operation_id?:string})=>{
            if(message.operation_id)probe.writes.push({op:message.op,identity:message.operation_id});
            if(message.op===probe.dropNext){dropId=message.id;probe.dropNext='';}
            native.postMessage(message);
          },disconnect:()=>native.disconnect()
        } as unknown as chrome.runtime.Port;
      }) as typeof chrome.runtime.connectNative;
      // Public navigation state only; no input values or vault contents.
      new MutationObserver(()=>{
        const active=document.querySelector('#primary-navigation [aria-current="page"]')?.textContent?.trim()||'';
        if(probe.navigation.at(-1)!==active)probe.navigation.push(active);
      }).observe(document,{subtree:true,attributes:true,attributeFilter:['aria-current']});
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    const id=new URL(worker.url()).host;
    native=await temporaryNativeHost(id,root,{hostName:'app.monica.cli',executable:helper});
    const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(`chrome-extension://${id}/index.html`);
    const setup=await page.evaluate(async value=>chrome.runtime.sendMessage({type:'VAULT_SETUP',masterPassword:value}),password);
    expect(setup.ok).toBe(true);await page.reload();
    await page.locator('#primary-navigation').getByRole('button',{name:'设置与备份',exact:true}).click();
    await page.getByRole('switch',{name:'CLI 联动 不完善',exact:true}).click();
    const cliNavigation=page.locator('#primary-navigation').getByRole('button',{name:'CLI 内容管理 不完善',exact:true});
    await cliNavigation.click();
    await expect(cliNavigation).toHaveAttribute('aria-current','page');
    await expect(page.getByRole('searchbox',{name:'搜索密码库'})).toHaveCount(0);
    const scope=page.locator('[data-cli-management]');
    await expect(scope.getByLabel('CLI 主密码',{exact:true})).toBeVisible();
    await scope.getByLabel('CLI 主密码',{exact:true}).fill('incorrect');
    await scope.getByRole('button',{name:'解锁 CLI',exact:true}).click();
    await expect(scope.getByRole('alert')).toContainText('密码');
    const unlock=async()=>{await page.bringToFront();await scope.getByLabel('CLI 主密码',{exact:true}).fill(password);await scope.getByRole('button',{name:'解锁 CLI',exact:true}).click();await expect(scope.getByRole('button',{name:'锁定 CLI',exact:true})).toBeVisible({timeout:30000});};
    await unlock();
    const modal=page.getByRole('dialog');
    const save=async()=>{await modal.getByRole('button',{name:'保存',exact:true}).click();await expect(modal).not.toBeVisible();await expect(scope.getByRole('button',{name:'刷新',exact:true})).toBeEnabled();};
    // Deliver to the real host, then discard the committed success reply.
    await page.evaluate(()=>{(window as any).cliRecoveryProbe.dropNext='create_category';});
    await scope.getByRole('button',{name:'新建目录',exact:true}).click();
    await modal.getByLabel('标题',{exact:true}).fill('Lost reply category');
    await modal.getByRole('button',{name:'保存',exact:true}).click();
    await expect(modal).not.toBeVisible();
    await expect(scope.getByRole('button',{name:'解锁 CLI',exact:true})).toBeVisible();
    await expect(scope.locator('[data-cli-recovery]')).toBeVisible();
    await unlock();
    await expect(scope.locator('[data-cli-recovery]')).toHaveCount(0);
    await expect(scope.locator('.cli-folder').filter({hasText:'Lost reply category'})).toHaveCount(1);
    expect(await page.evaluate(()=>(window as any).cliRecoveryProbe.writes.filter((w:any)=>w.op==='create_category').length)).toBe(1);
    await scope.getByRole('button',{name:'新建目录',exact:true}).click();await modal.getByLabel('标题',{exact:true}).fill('CLI Edge 测试');await save();
    await scope.locator('.cli-folder').filter({hasText:'CLI Edge 测试'}).click();
    await scope.getByRole('button',{name:'新增 CLI 密码',exact:true}).click();
    await modal.getByLabel('标题',{exact:true}).fill('图形管理账户');await modal.getByLabel('用户名',{exact:true}).fill('synthetic-user');
    await modal.getByLabel('密码',{exact:true}).fill('  Synthetic secret\n不可见  ');await modal.getByLabel('备注',{exact:true}).fill('Preserve this private note');await save();
    let row=scope.locator('[data-cli-entry]').filter({hasText:'图形管理账户'});await expect(row).toHaveCount(1);
    const entry=await row.getAttribute('data-cli-entry');
    await row.getByRole('button',{name:'编辑密码',exact:true}).click();
    await expect(modal.getByLabel('标题',{exact:true})).toHaveValue('图形管理账户');
    await expect(modal.getByLabel('密码',{exact:true})).toHaveCount(0);
    await modal.getByLabel('标题',{exact:true}).fill('改名后账户');await modal.getByLabel('替换网址',{exact:true}).check();await modal.getByLabel('网址',{exact:true}).fill('https://example.test');await save();
    row=scope.locator(`[data-cli-entry="${entry}"]`);await expect(row).toContainText('改名后账户');
    await scope.getByRole('button',{name:'新增 CLI 连接',exact:true}).click();await modal.getByLabel('标题',{exact:true}).fill('Synthetic GitHub');await modal.getByLabel('连接名称（英文标识）',{exact:true}).fill('edge-work');await modal.getByLabel('Token',{exact:true}).fill('synthetic-cli-edge-token');await save();
    await scope.getByRole('button',{name:'锁定 CLI',exact:true}).click();
    cli(['grant','edge-agent','--connection','edge-work','--repo','example/project'],{password});
    await unlock();
    await scope.getByRole('button',{name:'连接与 AI 授权',exact:true}).click();await expect(scope.getByText('edge-agent · edge-work',{exact:true})).toBeVisible();
    await scope.getByRole('button',{name:'撤销 AI 授权',exact:true}).click();await modal.getByRole('button',{name:'确认',exact:true}).click();await expect(modal).not.toBeVisible();
    await expect(scope.getByText('没有 AI 授权。',{exact:true})).toBeVisible();
    await scope.getByRole('button',{name:'创建 AI 授权',exact:true}).click();
    await modal.getByLabel('授权名称',{exact:true}).fill('graphical-agent');
    await modal.getByLabel('连接',{exact:true}).selectOption('edge-work');
    await modal.getByLabel('仓库范围（每行一个）',{exact:true}).fill('example/project');
    await modal.getByLabel('总调用次数（0 为不限次数，仍会到期）',{exact:true}).fill('3');
    await modal.getByLabel('重新输入 CLI 主密码',{exact:true}).fill(password);await save();
    const beforeRenew=JSON.parse(await readFile(config,'utf8')).grants[0];
    expect(beforeRenew.operations).toEqual(['list_issues','get_issue']);
    expect(beforeRenew.max_calls).toBe(3);expect(beforeRenew.approval).toBe('write');
    await scope.getByRole('button',{name:'续期 AI 授权',exact:true}).click();
    await modal.getByLabel('重新输入 CLI 主密码',{exact:true}).fill(password);await save();
    const afterRenew=JSON.parse(await readFile(config,'utf8')).grants[0];
    expect(afterRenew.capability_hash).not.toBe(beforeRenew.capability_hash);
    expect(afterRenew.repositories).toEqual(beforeRenew.repositories);expect(afterRenew.max_calls).toBe(3);
    await scope.getByRole('button',{name:'SSH / GPG 密钥',exact:true}).click();
    await scope.getByRole('button',{name:'生成 SSH 密钥',exact:true}).click();
    await modal.getByLabel('标题',{exact:true}).fill('Graphical SSH');
    await modal.getByLabel('重新输入 CLI 主密码',{exact:true}).fill(password);await save();
    await expect(scope.getByText('Graphical SSH',{exact:true})).toBeVisible();
    await scope.getByRole('button',{name:'导入 SSH / GPG',exact:true}).click();
    await modal.getByLabel('标题',{exact:true}).fill('Graphical GPG');
    await modal.getByLabel('密钥格式',{exact:true}).selectOption('openpgp');
    await modal.getByLabel('导入密钥内容（最多 32 KiB）',{exact:true}).fill(await readFile(path.join(bin,'../../tests/fixtures/gpg/ed25519-secret.asc'),'utf8'));
    await modal.getByLabel('重新输入 CLI 主密码',{exact:true}).fill(password);await save();
    await expect(scope.getByText('Graphical GPG',{exact:true})).toBeVisible();
    expect(await scope.innerText()).not.toContain('PRIVATE KEY');
    await scope.getByRole('button',{name:'内容',exact:true}).click();
    await expect(scope.locator('[data-cli-entry]')).toHaveCount(4);
    // A second trusted CLI edit makes the open browser form stale.
    await scope.locator(`[data-cli-entry="${entry}"]`).getByRole('button',{name:'编辑密码',exact:true}).click();
    const metadata=cli(['passwords','info',entry!],{password}).data;
    cli(['passwords','edit',entry!,'--expected-head',metadata.head_commit_id,'--title','Changed in terminal'],{password,fields:'{}'});
    await modal.getByLabel('标题',{exact:true}).fill('Stale browser title');await modal.getByRole('button',{name:'保存',exact:true}).click();
    await expect(scope.getByRole('alert')).toContainText('内容已经改变');await expect(scope.getByRole('button',{name:'解锁 CLI',exact:true})).toBeVisible();
    await unlock();await expect(scope.locator(`[data-cli-entry="${entry}"]`)).toContainText('Changed in terminal');
    await expect(scope.locator('[data-cli-recovery]')).toContainText('操作已开始，但完成结果尚未确认。');
    await scope.getByRole('button',{name:'我已检查数据库内容',exact:true}).click();
    await expect(scope.locator('[data-cli-recovery]')).toHaveCount(0);
    await page.screenshot({path:path.join(root,'cli-manager-edge.png'),fullPage:true});
    // Leaving manager destroys its native session, rather than caching a password.
    await page.locator('#primary-navigation').getByRole('button',{name:'设置与备份',exact:true}).click();await cliNavigation.click();await expect(scope.getByLabel('CLI 主密码',{exact:true})).toHaveValue('');
    await unlock();const other=await context.newPage();await other.goto('about:blank');await other.bringToFront();
    await expect(scope.getByRole('button',{name:'解锁 CLI',exact:true})).toBeVisible();
    await page.bringToFront();
    // Repeated manual locks and page navigation exercise the historical return
    // to settings symptom. Record transitions without inventing a root cause.
    for(let cycle=0;cycle<12;cycle++){
      await unlock();await expect(cliNavigation).toHaveAttribute('aria-current','page');
      await scope.getByRole('button',{name:'锁定 CLI',exact:true}).click();
      if(cycle%3===0){await page.locator('#primary-navigation').getByRole('button',{name:'设置与备份',exact:true}).click();await cliNavigation.click();}
    }
    const probe=await page.evaluate(()=>(window as any).cliRecoveryProbe);
    expect(probe.dropped).toBe(1);
    expect(new Set(probe.writes.map((w:any)=>w.identity)).size).toBe(probe.writes.length);
    await writeFile(path.join(root,'public-navigation.json'),JSON.stringify(probe,null,2));
    // Inspect while the original connection/grant still exists, before the
    // second synthetic database resets configuration.
    const configBytes=await readFile(config,'utf8');expect(configBytes).not.toContain('synthetic-cli-edge-token');expect(configBytes).not.toContain(password);
    // A different synthetic vault exercises binary key-file factors and a
    // fresh-auth action without weakening the existing blur lock.
    const keyPath=path.join(root,'synthetic-factor.bin');await writeFile(keyPath,Buffer.alloc(64,7));
    cli(['--key-file',keyPath,'init','--vault',path.join(root,'factor-vault.mdbx')],{password});
    await scope.getByRole('button',{name:'重新连接 CLI',exact:true}).click();
    await scope.getByLabel('CLI 主密码',{exact:true}).fill(password);
    await scope.getByRole('button',{name:'解锁 CLI',exact:true}).click();
    await expect(scope.getByRole('alert')).toContainText('密码');
    await scope.locator('input[type=file]').setInputFiles(keyPath);await unlock();
    await scope.getByRole('button',{name:'SSH / GPG 密钥',exact:true}).click();
    await scope.getByRole('button',{name:'生成 SSH 密钥',exact:true}).click();
    await modal.getByLabel('标题',{exact:true}).fill('Factor protected SSH');
    await modal.getByLabel('重新输入 CLI 主密码',{exact:true}).fill(password);await save();
    await expect(scope.getByText('Factor protected SSH',{exact:true})).toBeVisible();
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await expect(scope.getByLabel('CLI 主密码',{exact:true})).toHaveValue('');
    await expect(scope.locator('input[type=file]')).toHaveValue('');
    expect(errors).toEqual([]);
    await writeFile(path.join(root,'result.json'),JSON.stringify({entry,passed:true,errors,native:native.evidence},null,2));
    console.log(`CLI Edge evidence: ${root}`);
  } finally {
    try {await context.close();} finally {
      try {await native?.restore();} finally {await unlink(helper);}
    }
  }
});
