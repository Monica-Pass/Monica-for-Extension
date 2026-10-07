import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createHash, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { createPasskey } from '../../src/passkey/webauthn-core';

const rp = 'unlock-passkey.example.test';
const password = 'Synthetic request-scoped unlock password';
const challenge = Buffer.alloc(32, 31).toString('base64url');
const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>Passkey unlock RP</title><button id="register">Register</button><button id="login">Sign in</button><output id="result"></output><script>
window.credentialId='';window.timeoutMs=60000;window.messages=[];
addEventListener('message',e=>{if(e.source===window)messages.push(e.data)});
register.onclick=async()=>{result.textContent='waiting';window.controller=new AbortController();try{const c=await navigator.credentials.create({signal:controller.signal,publicKey:PublicKeyCredential.parseCreationOptionsFromJSON({challenge:'${challenge}',rp:{id:'${rp}',name:'Synthetic unlock'},user:{id:'dXNlcg',name:'synthetic',displayName:'Synthetic'},pubKeyCredParams:[{type:'public-key',alg:-257}],authenticatorSelection:{residentKey:'required',userVerification:'required'},timeout:timeoutMs})});window.credentialId=c.id;window.registration=c.toJSON();result.textContent='registered';}catch(e){result.textContent='error:'+e.name;}};
login.onclick=async()=>{result.textContent='waiting';window.controller=new AbortController();try{const c=await navigator.credentials.get({signal:controller.signal,publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',allowCredentials:[{type:'public-key',id:credentialId}],userVerification:'required',timeout:timeoutMs})});window.assertion=c.toJSON();result.textContent='authenticated';}catch(e){result.textContent='error:'+e.name;}};
</script>`;

async function send(page: Page, input: Record<string, unknown>) {
  const result = await page.evaluate(value => chrome.runtime.sendMessage(value), input);
  expect(result.ok, result.error).toBe(true);
  return result.data;
}

async function setup(context: BrowserContext) {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const manager = await context.newPage();
  await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
  await send(manager, { type: 'VAULT_SETUP', masterPassword: password });
  await manager.evaluate(() => chrome.storage.local.set({ 'monica.sync.preferences.v1': { enabled: false } }));
  await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: 'text/html', body: html }));
  const page = await context.newPage();
  await page.goto(`https://${rp}/`);
  return { manager, page };
}

async function focusedPrompt(page: Page) {
  await expect(page.locator('#monica-passkey-prompt-host')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('monica-passkey-prompt-host');
}

async function unlockWindow(context: BrowserContext, page: Page) {
  await focusedPrompt(page);
  const opened = context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const security = await opened;
  await expect(security.getByRole('heading', { name: '解锁 Monica 以继续' })).toBeVisible();
  return security;
}

async function unlock(security: Page) {
  await security.getByLabel('Monica 主密码', { exact: true }).fill(password);
  await security.getByRole('button', { name: '解锁并继续', exact: true }).click();
  await expect.poll(() => security.isClosed()).toBe(true);
}

async function confirm(page: Page, operation: 'create' | 'get') {
  await focusedPrompt(page);
  if (operation === 'get') { await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); }
  await page.keyboard.press('Enter');
}

const browserOptions = () => ({ locale: 'zh-CN', args: [`--disable-extensions-except=${path.resolve('dist')}`, `--load-extension=${path.resolve('dist')}`] });

test('locked RSA registration and login resume with one scoped password verification, including browser restart', async ({}, info) => {
  test.setTimeout(120_000);
  const profile = info.outputPath('unlock');
  let context = await launchEdgeContext(profile, browserOptions());
  try {
    let { manager, page } = await setup(context);
    await page.setViewportSize({ width: 320, height: 760 });
    let registrations = 0;
    context.on('page', opened => { opened.waitForURL('**/passkey-verify.html?*').then(() => registrations++).catch(() => undefined); });
    await send(manager, { type: 'VAULT_LOCK' });
    await page.locator('#register').click();
    await focusedPrompt(page);
    await page.screenshot({ path: info.outputPath('locked-320.png'), animations: 'disabled' });
    const security = await unlockWindow(context, page);
    await security.setViewportSize({ width: 320, height: 650 });
    await security.getByLabel('Monica 主密码', { exact: true }).fill('wrong synthetic password');
    await security.getByRole('button', { name: '解锁并继续', exact: true }).click();
    await expect(security.getByRole('alert')).toContainText('主密码错误');
    expect(await send(manager, { type: 'VAULT_STATUS' })).toBe('locked');
    await security.screenshot({ path: info.outputPath('unlock-error-320.png') });
    expect(await security.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await unlock(security);
    await focusedPrompt(page);
    expect(await send(manager, { type: 'VAULT_LIST_ITEMS' })).toHaveLength(0);
    await expect(page.locator('#result')).toHaveText('waiting');
    await page.screenshot({ path: info.outputPath('unlocked-create-320.png'), animations: 'disabled' });
    await confirm(page, 'create');
    await expect(page.locator('#result')).toHaveText('registered');
    expect(registrations).toBe(1);
    const registration = await page.evaluate(() => (window as any).registration);
    const publicKey = createPublicKey({ format: 'der', type: 'spki', key: Buffer.from(registration.response.publicKey, 'base64url') });
    expect(Buffer.from(registration.response.authenticatorData, 'base64url')[32] & 4).toBe(4);
    const credentialId = registration.id;

    await context.close(); context = await launchEdgeContext(profile, browserOptions());
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    manager = await context.newPage(); await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
    expect(await send(manager, { type: 'VAULT_STATUS' })).toBe('locked');
    await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: 'text/html', body: html }));
    page = await context.newPage(); await page.goto(`https://${rp}/`);
    await page.evaluate(id => { (window as any).credentialId = id; }, credentialId);
    await page.locator('#login').click();
    const loginSecurity = await unlockWindow(context, page);
    await unlock(loginSecurity);
    await confirm(page, 'get');
    await expect(page.locator('#result')).toHaveText('authenticated');
    const assertion = await page.evaluate(() => (window as any).assertion);
    const auth = Buffer.from(assertion.response.authenticatorData, 'base64url');
    const client = Buffer.from(assertion.response.clientDataJSON, 'base64url');
    expect(JSON.parse(client.toString())).toMatchObject({ type: 'webauthn.get', challenge, origin: `https://${rp}` });
    expect(auth.subarray(0,32)).toEqual(createHash('sha256').update(rp).digest());
    expect(auth[32] & 4).toBe(4);
    expect(verify('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), publicKey, Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);
    const items = await send(manager, { type: 'VAULT_LIST_ITEMS' });
    expect(items[0]).toMatchObject({ credentialId, useCount: 1 });
    const websiteMessages = JSON.stringify(await page.evaluate(() => (window as any).messages));
    expect(websiteMessages).not.toContain(password);
    expect(websiteMessages).not.toContain(items[0].privateKeyPkcs8);
    expect(websiteMessages).not.toContain('unlockSessionId');
  } finally { await context.close(); }
});

test('locked requests cancel on Escape, abort, navigation, timeout and explicit relock without signing', async ({}, info) => {
  test.setTimeout(150_000);
  const context = await launchEdgeContext(info.outputPath('cancel'), browserOptions());
  try {
    const { manager, page } = await setup(context);
    const seed = await createPasskey({ origin: `https://${rp}`, rpId: rp, rpName: 'Synthetic', challenge, userId: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic', algorithms: [-7], excludeCredentialIds: [] });
    const now = new Date().toISOString();
    await send(manager, { type: 'VAULT_UPSERT_ITEM', item: { id: 'synthetic-cancel-key', kind: 'passkey', title: 'Synthetic', notes: '', favorite: false, providerRefs: [], createdAt: now, updatedAt: now, credentialId: seed.credentialId, rpId: rp, userName: 'synthetic', userDisplayName: 'Synthetic', userHandle: 'dXNlcg', algorithm: -7, privateKeyPkcs8: seed.privateKeyPkcs8, publicKey: seed.publicKeySpki, discoverable: true, userVerificationRequired: true, signCount: 0, useCount: 0, sourceMode: 'browser-local' } });
    for (const action of ['escape', 'abort', 'navigation', 'timeout', 'relock', 'after-unlock-relock'] as const) {
      await send(manager, { type: 'VAULT_LOCK' });
      await page.goto(`https://${rp}/`);
      await page.evaluate(({ id, timeout }) => { (window as any).credentialId = id; (window as any).timeoutMs = timeout; }, { id: seed.credentialId, timeout: action === 'timeout' ? 3000 : 60000 });
      await page.locator('#login').click();
      const security = await unlockWindow(context, page);
      if (action === 'escape') await security.keyboard.press('Escape');
      if (action === 'abort') await page.evaluate(() => (window as any).controller.abort());
      if (action === 'navigation') await page.goto(`https://${rp}/next`);
      if (action === 'relock') await send(manager, { type: 'VAULT_LOCK' });
      if (action === 'after-unlock-relock') { await unlock(security); await focusedPrompt(page); await send(manager, { type: 'VAULT_LOCK' }); }
      await expect.poll(() => security.isClosed(), { timeout: 10_000 }).toBe(true);
      if (action !== 'navigation') await expect(page.locator('#result')).toHaveText(action === 'abort' ? 'error:AbortError' : 'error:NotAllowedError');
      await expect(page.locator('#monica-passkey-prompt-host')).toHaveCount(0);
      expect(await send(manager, { type: 'VAULT_STATUS' }), action).toBe('locked');
      await send(manager, { type: 'VAULT_UNLOCK', masterPassword: password });
      expect((await send(manager, { type: 'VAULT_LIST_ITEMS' }))[0]).toMatchObject({ credentialId: seed.credentialId, useCount: 0 });
    }
  } finally { await context.close(); }
});
