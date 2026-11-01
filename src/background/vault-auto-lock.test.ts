import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVaultRuntime } from './vault-runtime';
import { SecureVaultService } from '../security/secure-vault-service';
import { MemoryVaultStorage } from '../security/vault-storage';
import { MemoryVaultSessionStore } from '../security/vault-session';
import type { ExtensionRequest } from '../runtime/messages';

const root = 'chrome-extension://synthetic/';
beforeEach(() => vi.stubGlobal('chrome', { runtime: { id: 'synthetic', getURL: (path: string) => root + path } }));
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  await service.setup('');
  // These two handlers only use the real service; other command dependencies
  // intentionally remain absent so unexpected cross-domain effects fail.
  const runtime = createVaultRuntime({ service } as unknown as Parameters<typeof createVaultRuntime>[0]);
  return { service, runtime };
}

describe('manager-only auto-lock commands', () => {
  it('routes get and set to the real encrypted setting', async () => {
    const { runtime } = await fixture(), sender = { id: 'synthetic', url: root + 'index.html' };
    expect(await runtime.handlers.VAULT_AUTO_LOCK_GET({ type: 'VAULT_AUTO_LOCK_GET' }, sender, false)).toBe(15);
    expect(await runtime.handlers.VAULT_AUTO_LOCK_SET({ type: 'VAULT_AUTO_LOCK_SET', minutes: 42 }, sender, false)).toBe(42);
    expect(await runtime.handlers.VAULT_AUTO_LOCK_GET({ type: 'VAULT_AUTO_LOCK_GET' }, sender, false)).toBe(42);
  });
  it.each(['https://example.test/', root + 'popup.html', root + 'index.html/evil', 'chrome-extension://other/index.html'])('denies read and write from %s before touching the setting', async url => {
    const { service, runtime } = await fixture(), get = vi.spyOn(service, 'getAutoLockMinutes'), set = vi.spyOn(service, 'setAutoLockMinutes');
    const sender = { id: 'synthetic', url };
    await expect(runtime.handlers.VAULT_AUTO_LOCK_GET({ type: 'VAULT_AUTO_LOCK_GET' }, sender, false)).rejects.toThrow();
    await expect(runtime.handlers.VAULT_AUTO_LOCK_SET({ type: 'VAULT_AUTO_LOCK_SET', minutes: 1440 }, sender, false)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });
  it('keeps backend validation when a manager bypasses the form', async () => {
    const { service, runtime } = await fixture();
    const request = { type: 'VAULT_AUTO_LOCK_SET', minutes: '1440' } as unknown as Extract<ExtensionRequest, { type: 'VAULT_AUTO_LOCK_SET' }>;
    await expect(runtime.handlers.VAULT_AUTO_LOCK_SET(request, { id: 'synthetic', url: root + 'index.html' }, false)).rejects.toThrow();
    expect(await service.getAutoLockMinutes()).toBe(15);
  });
});
