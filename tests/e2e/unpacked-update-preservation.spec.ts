import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchEdgeContext } from './fixtures/edge';
import { createEmptyVaultState, createLoginItem } from '../../src/core/model';
import { decryptVaultState, deriveVaultKey, encryptVaultState } from '../../src/security/vault-crypto';

async function send(page: Page, message: object) {
  const response = await page.evaluate(input => chrome.runtime.sendMessage(input), message);
  expect(response.ok, response.error).toBe(true); return response.data;
}
async function fingerprint(page: Page) {
  return page.evaluate(async () => {
    const envelope = await new Promise((resolve, reject) => {
      const open = indexedDB.open('monica-extension-secure-vault', 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, request = db.transaction('vault').objectStore('vault').get('primary');
        request.onsuccess = () => { resolve(request.result); db.close(); };
        request.onerror = () => { reject(request.error); db.close(); };
      };
    });
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(envelope))))].map(n => n.toString(16).padStart(2, '0')).join('');
  });
}

test('real stable files can be overwritten and relocated without resetting the vault or Bitwarden connection', async ({}, info) => {
  test.setTimeout(180_000);
  const stable = process.env.MONICA_UPDATE_STABLE_DIR;
  test.skip(!stable, 'Set MONICA_UPDATE_STABLE_DIR to a checksum-verified stable extension package');
  const root = path.resolve('.tmp'); await mkdir(root, { recursive: true });
  const fixture = await mkdtemp(path.join(root, 'unpacked-update-'));
  const original = path.join(fixture, 'original'), relocated = path.join(fixture, 'relocated');
  let context: BrowserContext | undefined;
  const profile = info.outputPath('profile');
  const options = (extension: string) => ({ locale: 'zh-CN', reducedMotion: 'reduce' as const,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const password = 'synthetic unchanged upgrade password';
  const state = createEmptyVaultState();
  const provider = { id: 'upgrade-bw', kind: 'bitwarden' as const, name: 'Bitwarden retained', enabled: false, isDefaultSaveTarget: false,
    config: { authenticated: true, email: 'upgrade@example.test', deviceIdentifier: 'synthetic-fixed-device',
      accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', vaultKey: 'synthetic-vault-key' } };
  state.providers.push(provider);
  state.items.push(createLoginItem({ title: 'Retained login', username: 'synthetic-user', password: 'synthetic-login-secret', providerRefs: [{ providerId: provider.id, remoteId: 'synthetic-cipher' }] }));
  const { key, kdf } = await deriveVaultKey(password);
  const backup = { magic: 'MONICA_EXTENSION_BACKUP', version: 1, exportedAt: new Date().toISOString(), envelope: await encryptVaultState(state, key, kdf) };
  try {
    await cp(path.resolve(stable!), original, { recursive: true });
    context = await launchEdgeContext(profile, options(original));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host, base = `chrome-extension://${id}`;
    const extensions = await context.newPage(); await extensions.goto('chrome://extensions/');
    await extensions.evaluate(() => (chrome as unknown as { developerPrivate: {
      updateProfileConfiguration: (config: { inDeveloperMode: boolean }) => Promise<void>;
    } }).developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
    const page = await context.newPage(); await page.goto(`${base}/index.html`);
    await send(page, { type: 'VAULT_RESTORE_ENCRYPTED', backup, backupPassword: password });
    const before = await fingerprint(page), oldRuntime = await send(page, { type: 'RUNTIME_INFO' });
    // Deliberately leave the already-running old worker alive during file replacement.
    await cp(path.resolve('dist'), original, { recursive: true, force: true });
    const updated = await context.newPage(); await updated.goto(`${base}/index.html`);
    const oldWorkerStillRunning = (await send(updated, { type: 'RUNTIME_INFO' })).buildId === oldRuntime.buildId;
    if (oldWorkerStillRunning) {
      const reload = updated.getByRole('button', { name: '重新加载扩展', exact: true });
      await expect(reload).toBeVisible();
      await reload.click().catch(error => { if (!updated.isClosed()) throw error; });
    }
    const reopened = await context.newPage();
    await expect(async () => {
      await reopened.goto(`${base}/index.html`);
      expect((await send(reopened, { type: 'RUNTIME_INFO' })).buildId).not.toBe(oldRuntime.buildId);
    }).toPass({ timeout: 20_000 });
    expect(await fingerprint(reopened)).toBe(before);
    await send(reopened, { type: 'VAULT_UNLOCK', masterPassword: password });
    const exported = await send(reopened, { type: 'VAULT_AUTHENTICATED_EXPORT', input: { format: 'encrypted', masterPassword: password, backupPassword: password, confirmed: true } });
    const { key: exportKey } = await deriveVaultKey(password, exported.backup.envelope.kdf);
    const after = await decryptVaultState(exported.backup.envelope, exportKey);
    expect(after.providers.find(value => value.id === provider.id)).toEqual(provider);
    expect(after.items).toEqual(state.items);
    await context.close(); context = undefined;
    await cp(path.resolve('dist'), relocated, { recursive: true });
    await writeFile(path.join(relocated, 'synthetic-location.txt'), 'relocated');
    context = await launchEdgeContext(profile, options(relocated));
    const moved = await context.newPage(); await moved.goto(`${base}/index.html`);
    expect(await moved.evaluate(() => chrome.runtime.id)).toBe(id);
    expect(await moved.evaluate(() => fetch(chrome.runtime.getURL('synthetic-location.txt')).then(r => r.text()))).toBe('relocated');
    expect(await fingerprint(moved)).toBe(before);
    await send(moved, { type: 'VAULT_UNLOCK', masterPassword: password });
    expect(await send(moved, { type: 'VAULT_LIST_ITEMS' })).toEqual(state.items);
    const evidencePath = info.outputPath('upgrade-results.json');
    await writeFile(evidencePath, JSON.stringify({
      extensionId: id, stableBuildId: oldRuntime.buildId,
      currentBuildId: (await send(moved, { type: 'RUNTIME_INFO' })).buildId,
      oldWorkerStillRunning, sameDirectoryPreserved: true, relocatedPreserved: true,
      bitwardenConnectionPreserved: true, providerLoginPerformedAfterUpdate: false
    }, null, 2) + '\n');
    await info.attach('upgrade-results', { contentType: 'application/json', path: evidencePath });
  } finally {
    await context?.close();
    const resolved = await realpath(fixture);
    if (path.dirname(resolved).toLowerCase() !== (await realpath(root)).toLowerCase() || !path.basename(resolved).startsWith('unpacked-update-')) throw new Error('Unexpected fixture path');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
});
