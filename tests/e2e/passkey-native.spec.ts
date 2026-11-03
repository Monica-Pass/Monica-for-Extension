import { expect, test, type Page } from '@playwright/test';
import { createPublicKey, verify } from 'node:crypto';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { createPasskey } from '../../src/passkey/webauthn-core';

const rp = 'native-passkey.example.test';
const challenge = Buffer.alloc(32, 43).toString('base64url');

async function send(page: Page, input: Record<string, unknown>) {
  const response = await page.evaluate(value => chrome.runtime.sendMessage(value), input);
  expect(response.ok, response.error).toBe(true);
  return response.data;
}

for (const locked of [false, true]) {
  test(`native Passkey handoff preserves browser authentication and cancellation, locked=${locked}`, async ({}, testInfo) => {
    const extensionPath = path.resolve('dist');
    const context = await launchEdgeContext(testInfo.outputPath('native-profile'), {
      locale: 'zh-CN', args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
    });
    try {
      const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      const manager = await context.newPage();
      await manager.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`);
      const password = 'Synthetic native handoff password';
      await send(manager, { type: 'VAULT_SETUP', masterPassword: password });
      const seed = await createPasskey({ origin: `https://${rp}`, challenge, rpId: rp, rpName: 'Native test', userId: 'dXNlcg', userName: 'synthetic', userDisplayName: 'Synthetic', algorithms: [-7], excludeCredentialIds: [], userVerified: true });
      const now = new Date().toISOString();
      await send(manager, { type: 'VAULT_UPSERT_ITEM', item: { id: 'native-test-monica', kind: 'passkey', title: 'Synthetic Monica credential', notes: '', favorite: false, providerRefs: [], createdAt: now, updatedAt: now, credentialId: seed.credentialId, rpId: rp, userName: 'synthetic', userDisplayName: 'Synthetic', userHandle: 'dXNlcg', algorithm: -7, privateKeyPkcs8: seed.privateKeyPkcs8, publicKey: seed.publicKeySpki, discoverable: true, userVerificationRequired: true, signCount: 0, useCount: 0, sourceMode: 'browser-local' } });
      if (locked) await send(manager, { type: 'VAULT_LOCK' });
      await context.route(`https://${rp}/**`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta name="viewport" content="width=device-width"><button id="login">Sign in</button><output id="result"></output><script>
        window.handoffs=0; addEventListener('message',e=>{if(e.source===window&&e.data.source==='monica-passkey-extension'&&e.data.name==='NotSupportedError')handoffs++});
        login.onclick=async()=>{result.textContent='waiting';window.controller=new AbortController();try{const credential=await navigator.credentials.get({signal:controller.signal,publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:'${challenge}',rpId:'${rp}',allowCredentials:[{type:'public-key',id:'${seed.credentialId}',transports:['internal','hybrid']}],userVerification:'required',timeout:60000})});window.assertion=credential.toJSON();result.textContent='authenticated';}catch(e){result.textContent='error:'+e.name;}};
      </script>` }));
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: Buffer.from(seed.credentialId, 'base64url').toString('base64'), isResidentCredential: true, rpId: rp, privateKey: Buffer.from(seed.privateKeyPkcs8, 'base64url').toString('base64'), userHandle: Buffer.from('user').toString('base64'), signCount: 0 } });
      let nativeAssertions = 0;
      cdp.on('WebAuthn.credentialAsserted', () => nativeAssertions++);
      await page.goto(`https://${rp}/`);
      const start = async () => {
        await page.locator('#login').click();
        await expect(page.locator('#monica-passkey-prompt-host')).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('monica-passkey-prompt-host');
      };
      const chooseNative = async () => {
        // Closed root: navigate using the real keyboard from the focused account/confirm.
        for (let i = 0; i < (locked ? 1 : 3); i++) await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
      };
      await start(); await page.keyboard.press('Escape');
      await expect(page.locator('#result')).toHaveText('error:NotAllowedError');
      expect(nativeAssertions).toBe(0);
      expect(await page.evaluate(() => (window as any).handoffs)).toBe(0);
      await start();
      await page.evaluate(() => (window as any).controller.abort());
      await expect(page.locator('#result')).toHaveText('error:AbortError');
      expect(nativeAssertions).toBe(0);
      expect(await page.evaluate(() => (window as any).handoffs)).toBe(0);
      await start();
      await page.screenshot({ path: path.resolve(`docs/design/passkey-native-edge-${locked ? 'locked' : 'unlocked'}.png`) });
      await chooseNative();
      await expect(page.locator('#result')).toHaveText('authenticated');
      await expect(page.locator('#monica-passkey-prompt-host')).toHaveCount(0);
      expect(nativeAssertions).toBe(1);
      expect(await page.evaluate(() => (window as any).handoffs)).toBe(1);
      const assertion = await page.evaluate(() => (window as any).assertion);
      expect(assertion.id).toBe(seed.credentialId);
      const clientData = Buffer.from(assertion.response.clientDataJSON, 'base64url');
      expect(JSON.parse(clientData.toString())).toMatchObject({ type: 'webauthn.get', challenge, origin: `https://${rp}` });
      const authData = Buffer.from(assertion.response.authenticatorData, 'base64url');
      expect(authData[32] & 5).toBe(5); // Native authenticator provided UP and required UV.
      const { createHash } = await import('node:crypto');
      expect(verify('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), createPublicKey({ key: Buffer.from(seed.publicKeySpki, 'base64url'), format: 'der', type: 'spki' }), Buffer.from(assertion.response.signature, 'base64url'))).toBe(true);

      // Keep native waiting, then abort the original site's signal after handoff.
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
      await start(); await chooseNative();
      await expect.poll(() => page.evaluate(() => (window as any).handoffs)).toBe(2);
      await page.evaluate(() => (window as any).controller.abort());
      await expect(page.locator('#result')).toHaveText('error:AbortError');
      expect(nativeAssertions).toBe(1);
      expect(await send(manager, { type: 'VAULT_STATUS' })).toBe(locked ? 'locked' : 'unlocked');
      expect(context.pages().filter(p => p.url().includes('passkey-verify.html'))).toHaveLength(0);
      if (locked) await send(manager, { type: 'VAULT_UNLOCK', masterPassword: password });
      const items = await send(manager, { type: 'VAULT_LIST_ITEMS' });
      expect(items).toEqual([expect.objectContaining({ id: 'native-test-monica', useCount: 0, signCount: 0 })]);
      expect(items[0].lastUsedAt).toBeUndefined();
    } finally { await context.close(); }
  });
}
