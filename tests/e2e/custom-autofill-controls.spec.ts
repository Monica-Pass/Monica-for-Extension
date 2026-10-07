import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { createLoginItem, type LoginItem } from '../../src/core/model';
import { generateOtpWithParameters, parseTotpParameters } from '../../src/core/totp';

const masterPassword = 'Synthetic control acceptance vault';
const url = 'https://custom-controls.example.test/login';
async function send<T = unknown>(page: Page, message: Record<string, unknown>): Promise<T> {
  const response = await page.evaluate(request => chrome.runtime.sendMessage(request), message);
  expect(response.ok, response.error).toBe(true); return response.data as T;
}
async function launch(info: TestInfo, setup: boolean) {
  const extension = path.resolve('dist');
  const context = await launchEdgeContext(info.outputPath('profile'), { locale: 'zh-CN', viewport: { width: 980, height: 840 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const manager = await context.newPage(); await manager.goto(`chrome-extension://${id}/index.html`);
  await send(manager, { type: setup ? 'VAULT_SETUP' : 'VAULT_UNLOCK', masterPassword });
  return { context, manager, id };
}
const customFields: LoginItem['customFields'] = [
  { name: 'remember', value: 'true', fieldType: 'BOOLEAN', protected: false },
  { name: 'notifications', value: 'false', type: 'boolean', protected: false },
  { name: 'Recovery note', value: 'line 1\r\n历史 line 2', fieldType: 'HIDDEN', protected: true },
  { name: 'tenant', value: 'Team A', protected: false },
  { name: 'upload', value: 'not a file path', protected: true },
  { name: 'new', value: 'must not enter new password', protected: true },
  { name: 'monica.content.credential', value: 'internal fixture carrier', protected: true },
];
function html(mutate = false, hotp = false) {
  const form = '<form id="login"><label>Account<input autocomplete="username" id="username"></label><label>Current password<input type="password" autocomplete="current-password" id="password"></label>'
    + (hotp ? '<label>One-time code<input id="otp" autocomplete="one-time-code"></label>' : '')
    + '<label><input type="checkbox" name="remember" value="server-token"> Remember</label><label><input type="checkbox" name="notifications" value="enabled" checked> Notifications</label>'
    + '<label>Recovery note<textarea aria-label="Recovery note"></textarea></label><label>Tenant<select name="tenant"><option value="">Choose</option><option value="team-id">Team A</option></select></label>'
    + '<label>Upload<input name="upload" type="file"></label><label>New password<input name="new" type="password" autocomplete="new-password"></label><textarea name="monica.content.credential" aria-label="Internal carrier"></textarea></form>';
  return `<!doctype html><meta charset="utf-8"><title>Custom control acceptance</title><style>body{font:16px sans-serif;max-width:700px;margin:24px auto}input,select,textarea{font:inherit}#other{margin-bottom:16px}</style>
    <form id="other"><label>Unrelated form<input name="username"></label><input name="remember" type="checkbox"></form><div id="host"></div><script>
    const shadow=document.querySelector('#host').attachShadow({mode:'open'});
    shadow.innerHTML=${JSON.stringify('<style>label{display:block;margin:12px 0}input:not([type=checkbox]),select,textarea{display:block;width:90%;padding:8px}textarea{height:58px}</style>' + form)};
    window.events=[];window.clicked=0;shadow.querySelector('[name=remember]').addEventListener('click',()=>window.clicked++);
    for(const control of shadow.querySelectorAll('input,textarea,select'))for(const name of ['input','change'])control.addEventListener(name,()=>events.push([control.name||control.id||control.tagName,name]));
    ${mutate ? `shadow.querySelector('#username').addEventListener('input',()=>{shadow.querySelector('option[value=team-id]').label='Changed tenant'},{once:true});` : ''}
    ${hotp ? `shadow.querySelector('#otp').addEventListener('input',()=>{shadow.querySelector('option[value=team-id]').label='Changed after code'},{once:true});` : ''}
    </script>`;
}
async function fill(app: Awaited<ReturnType<typeof launch>>, body: string) {
  await app.context.route('https://custom-controls.example.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
  const page = await app.context.newPage(); await page.goto(url); await page.locator('#host #username').focus();
  const popup = await app.context.newPage(); await page.bringToFront(); await popup.goto(`chrome-extension://${app.id}/popup.html`);
  await popup.getByRole('button', { name: /Custom control account/ }).click();
  return { page, popup };
}

test('real Edge fills typed custom controls in the selected shadow form and after full restart', async ({}, info) => {
  const item = { ...createLoginItem({ title: 'Custom control account', username: 'control-user', password: 'control-secret', uris: [url] }), customFields };
  let app = await launch(info, true);
  try {
    await send(app.manager, { type: 'VAULT_UPSERT_ITEM', item });
    for (const phase of ['initial', 'restart']) {
      if (phase === 'restart') { await app.context.close(); app = await launch(info, false); }
      const { page } = await fill(app, html());
      await expect(page.locator('#host [name=remember]')).toBeChecked({ timeout: 2500 });
      await expect(page.locator('#host [name=notifications]')).not.toBeChecked();
      await expect(page.locator('#host [name=remember]')).toHaveValue('server-token');
      await expect(page.locator('#host textarea[aria-label="Recovery note"]')).toHaveValue('line 1\n历史 line 2');
      await expect(page.locator('#host [name=tenant]')).toHaveValue('team-id');
      await expect(page.locator('#host #password')).toHaveValue('control-secret');
      await expect(page.locator('#host [name=upload]')).toHaveValue('');
      await expect(page.locator('#host [name=new]')).toHaveValue('');
      await expect(page.locator('#host [name="monica.content.credential"]')).toHaveValue('');
      await expect(page.locator('#other [name=username]')).toHaveValue('');
      await expect(page.locator('#other [name=remember]')).not.toBeChecked();
      expect(await page.evaluate(() => (window as any).clicked)).toBe(0);
      const events = await page.evaluate(() => (window as any).events as string[][]);
      expect(events.filter(row => row[0] === 'remember')).toEqual([['remember','input'],['remember','change']]);
      expect((await send<LoginItem[]>(app.manager, { type: 'VAULT_LIST_ITEMS' }))[0].customFields).toEqual(customFields);
      await page.screenshot({ path: info.outputPath(`${phase}-controls.png`), animations: 'disabled', fullPage: true });
    }
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ passed: true, actualEdge: true, restart: true,
      checks: ['typed-checkbox-true-false', 'textarea-native-newlines', 'select-label-to-value', 'native-events-without-click', 'shadow-form-scope', 'new-password-file-and-internal-exclusion', 'unchanged-stored-fields'] }, null, 2));
  } finally { await app.context.close(); }
});

test('a later custom-control failure still consumes the HOTP actually filled before an explicit retry', async ({}, info) => {
  const app = await launch(info, true);
  const totpSecret = 'otpauth://hotp/Controls?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=7';
  try {
    await send(app.manager, { type: 'VAULT_UPSERT_ITEM', item: { ...createLoginItem({ title: 'Custom control account', username: 'control-user', password: 'control-secret', uris: [url] }),
      totpSecret, customFields: [{ name: 'tenant', value: 'team-id', protected: false }] } });
    const { page, popup } = await fill(app, html(false, true));
    await expect(popup.getByText('页面字段已变化，请重新选择输入框后填写。', { exact: true })).toBeVisible();
    await expect(page.locator('#host #otp')).toHaveValue(await generateOtpWithParameters(parseTotpParameters(totpSecret)));
    await expect(page.locator('#host [name=tenant]')).toHaveValue('');
    const stored = (await send<LoginItem[]>(app.manager, { type: 'VAULT_LIST_ITEMS' }))[0];
    expect(parseTotpParameters(stored.totpSecret!).counter).toBe(8);
    await page.locator('#host #password').focus(); await page.bringToFront(); await popup.reload();
    await popup.getByRole('button', { name: /Custom control account/ }).click();
    await expect(page.locator('#host #otp')).toHaveValue(await generateOtpWithParameters(parseTotpParameters(stored.totpSecret!)));
    await expect(page.locator('#host [name=tenant]')).toHaveValue('team-id');
    expect(parseTotpParameters((await send<LoginItem[]>(app.manager, { type: 'VAULT_LIST_ITEMS' }))[0].totpSecret!).counter).toBe(9);
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ passed: true, actualEdge: true, partialFillAcknowledged: true, counters: [7, 8, 9], explicitRetry: true }, null, 2));
  } finally { await app.context.close(); }
});

test('real Edge refuses changed dropdown choices and retries from the current form', async ({}, info) => {
  const app = await launch(info, true);
  try {
    await send(app.manager, { type: 'VAULT_UPSERT_ITEM', item: { ...createLoginItem({ title: 'Custom control account', username: 'control-user', password: 'control-secret', uris: [url] }),
      customFields: [{ name: 'tenant', value: 'team-id', protected: false }] } });
    const { page, popup } = await fill(app, html(true));
    await expect(popup.getByText('页面字段已变化，请重新选择输入框后填写。', { exact: true })).toBeVisible();
    await expect(page.locator('#host [name=tenant]')).toHaveValue('');
    await page.locator('#host #password').focus(); await page.bringToFront(); await popup.reload();
    await popup.getByRole('button', { name: /Custom control account/ }).click();
    await expect(page.locator('#host [name=tenant]')).toHaveValue('team-id');
    await writeFile(info.outputPath('evidence.json'), JSON.stringify({ passed: true, actualEdge: true, changedOptionsRejected: true, explicitRetry: true }, null, 2));
  } finally { await app.context.close(); }
});
