import { afterEach, describe, expect, it, vi } from "vitest";
import { version } from "../../package.json";
import { runtimeInfo } from './version';

type VaultClient = typeof import('./client')['vaultClient'];

const compatible = { ok: true, data: runtimeInfo };
const unsupported = { ok: false, error: "不支持的 Monica 运行时命令。" };

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

describe("UI and background compatibility", () => {
  it('recovers a temporarily missing receiver during shared startup without replaying a password', async () => {
    vi.useFakeTimers();
    let probes = 0;
    const sendMessage = vi.fn(async (request: { type: string }) => {
      if (request.type === 'RUNTIME_INFO') {
        if (++probes < 3) throw new Error('Could not establish connection. Receiving end does not exist.');
        return compatible;
      }
      return { ok: true, data: 'locked' };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { vaultClient } = await import('./client');
    const result = expect(Promise.all([vaultClient.status(), vaultClient.unlock('synthetic secret')])).resolves.toEqual(['locked', 'locked']);
    void result.catch(() => undefined);
    await vi.runAllTimersAsync();
    await result;
    expect(probes).toBe(3);
    expect(sendMessage.mock.calls.filter(([r]) => r.type === 'VAULT_UNLOCK')).toHaveLength(1);
  });

  it('bounds startup recovery and allows a later fresh attempt', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { vaultClient } = await import('./client');
    const result = expect(vaultClient.status()).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    await vi.runAllTimersAsync();
    await result;
    expect(sendMessage).toHaveBeenCalledTimes(6);
    expect(sendMessage.mock.calls.every(([r]) => r.type === 'RUNTIME_INFO')).toBe(true);
    sendMessage.mockResolvedValueOnce(compatible).mockResolvedValueOnce({ ok: true, data: 'locked' });
    await expect(vaultClient.status()).resolves.toBe('locked');
  });

  it('rechecks compatibility when a status read loses its receiver', async () => {
    let reads = 0;
    const sendMessage = vi.fn(async (request: { type: string }) => {
      if (request.type === 'RUNTIME_INFO') return compatible;
      if (++reads === 1) throw new Error('The message port closed before a response was received.');
      return { ok: true, data: 'locked' };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { vaultClient } = await import('./client');
    await expect(vaultClient.status()).resolves.toBe('locked');
    expect(sendMessage.mock.calls.map(([r]) => r.type)).toEqual(['RUNTIME_INFO', 'VAULT_STATUS', 'RUNTIME_INFO', 'VAULT_STATUS']);
  });

  it.each(['unlock', 'setup', 'lock'] as const)('does not replay %s when its response is lost', async method => {
    const sendMessage = vi.fn(async (request: { type: string }) => {
      if (request.type === 'RUNTIME_INFO') return compatible;
      throw new Error('The message port closed before a response was received.');
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { vaultClient } = await import('./client');
    await expect(vaultClient[method]('synthetic secret')).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('requires reload for an invalidated extension context without retrying', async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error('Extension context invalidated.'));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { vaultClient } = await import('./client');
    await expect(vaultClient.status()).rejects.toMatchObject({ code: 'RUNTIME_RELOAD_REQUIRED' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('never sends a password if the recovered worker has a different version', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.')).mockResolvedValue({ ok: true, data: { version: 'old', protocolVersion: 1 } });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { vaultClient } = await import('./client');
    const result = expect(vaultClient.unlock('synthetic secret')).rejects.toMatchObject({ code: 'RUNTIME_RELOAD_REQUIRED' });
    await vi.runAllTimersAsync();
    await result;
    expect(sendMessage.mock.calls.every(([r]) => r.type === 'RUNTIME_INFO')).toBe(true);
  });

  it("checks compatibility before sending a password to an older background", async () => {
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? unsupported : { ok: true, data: [] });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.unlock("synthetic secret")).rejects.toMatchObject({ code: "RUNTIME_RELOAD_REQUIRED" });
    expect(sendMessage.mock.calls.map(([request]) => request)).toEqual([{ type: "RUNTIME_INFO" }]);
  });

  it.each([
    { ...runtimeInfo, buildId: 'stale-same-version-build' },
    { version: "0.0.0", protocolVersion: 1 },
    { version, protocolVersion: 99 },
    null
  ])("rejects incompatible or malformed runtime information: %j", async data => {
    const sendMessage = vi.fn(async () => ({ ok: true, data }));
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.status()).rejects.toMatchObject({ code: "RUNTIME_RELOAD_REQUIRED" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("shares concurrent checks, then checks again immediately before unlocking", async () => {
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? compatible : { ok: true, data: request.type === "VAULT_STATUS" ? "locked" : [] });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await Promise.all([vaultClient.status(), vaultClient.listItems()]);
    expect(sendMessage.mock.calls.filter(([request]) => request.type === "RUNTIME_INFO")).toHaveLength(1);
    await vaultClient.unlock("synthetic password");
    expect(sendMessage.mock.calls.slice(-2).map(([request]) => request.type)).toEqual(["RUNTIME_INFO", "VAULT_UNLOCK"]);
  });

  it("retries a failed compatibility check after the background becomes available", async () => {
    let ready = false;
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? ready ? compatible : unsupported : { ok: true, data: "locked" });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.status()).rejects.toMatchObject({ code: "RUNTIME_RELOAD_REQUIRED" });
    ready = true;
    await expect(vaultClient.status()).resolves.toBe("locked");
  });

  it.each(['login', 'email', 'keepass'] as const)('rechecks the build before password/code action %s after a cached status check', async action => {
    let info = runtimeInfo;
    const sendMessage = vi.fn(async (request: { type: string }) => ({ ok: true, data: request.type === 'RUNTIME_INFO' ? info : 'locked' }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { vaultClient } = await import('./client');
    await vaultClient.status();
    info = { ...runtimeInfo, buildId: 'different-build-same-version' };
    const result = action === 'login'
      ? vaultClient.loginBitwarden({ name: 'Synthetic', vaultUrl: 'https://vault.bitwarden.com', email: 'synthetic@example.com', masterPassword: 'synthetic secret', newDeviceOtp: '654321' })
      : action === 'email' ? vaultClient.sendBitwardenEmailCode('https://vault.bitwarden.com', 'synthetic@example.com', 'synthetic secret')
      : vaultClient.openKeePass({ name: 'Synthetic', fileName: 'synthetic.kdbx', file: '', password: 'synthetic secret' });
    await expect(result).rejects.toMatchObject({ code: 'RUNTIME_RELOAD_REQUIRED' });
    expect(sendMessage.mock.calls.map(([request]) => request.type)).toEqual(['RUNTIME_INFO', 'VAULT_STATUS', 'RUNTIME_INFO']);
  });

  it.each([
    ['VAULT_CHANGE_MASTER_PASSWORD', (client: VaultClient) => client.changeMasterPassword('synthetic old', 'synthetic new')],
    ['VAULT_RESTORE_ENCRYPTED', (client: VaultClient) => client.restoreEncryptedBackup({} as never, 'synthetic secret')],
    ['VAULT_KEEPASS_PROJECT_RECOVERY_EXPORT_BEGIN', (client: VaultClient) => client.beginKeePassRecoveryExport('provider', 'operation', 'tag', 'synthetic secret', 'request')],
    ['STEAM_REVOKE_AUTHORIZED_DEVICE', (client: VaultClient) => client.revokeSteamAuthorizedDevice('item', { tokenId: 'token', accountName: 'account', password: 'synthetic secret' })],
    ['WEBDAV_TEST', (client: VaultClient) => client.testWebDav({ password: 'synthetic secret' } as never)],
    ['KEEPASS_WEBDAV_TEST', (client: VaultClient) => client.testKeePassWebDav({ webDavPassword: 'synthetic secret' } as never)],
    ['KEEPASS_WEBDAV_OPEN', (client: VaultClient) => client.openKeePassWebDav({ webDavPassword: 'synthetic secret', databasePassword: 'synthetic secret' } as never)],
    ['KEEPASS_ONEDRIVE_OPEN', (client: VaultClient) => client.openKeePassOneDrive({ databasePassword: 'synthetic secret' } as never)],
    ['MDBX2_VAULT_CREATE', (client: VaultClient) => client.createMdbx2Vault({ name: 'Synthetic', password: 'synthetic secret' })],
    ['MDBX2_VAULT_OPEN', (client: VaultClient) => client.openMdbx2Vault({ credential: { method: 'security-key', keyMaterialBase64: 'synthetic key' } } as never)],
    ['VAULT_IMPORT_ITEMS', (client: VaultClient) => client.importItems([{ password: 'synthetic secret' } as never])],
    ['VAULT_UNLOCK_HELLO', (client: VaultClient) => client.unlockWithWindowsHello()],
    ['PASSKEY_VERIFY_PASSWORD', (client: VaultClient) => client.verifyPasskeyPassword('synthetic-verification', 'synthetic secret')],
    ['PASSKEY_VERIFY_HELLO', (client: VaultClient) => client.verifyPasskeyHello('synthetic-verification')]
  ])('rechecks the build before the sensitive command %s after a cached status check', async (_command, action) => {
    let info = runtimeInfo;
    const sendMessage = vi.fn(async (request: { type: string }) => ({ ok: true, data: request.type === 'RUNTIME_INFO' ? info : 'locked' }));
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { vaultClient } = await import('./client');
    await vaultClient.status();
    info = { ...runtimeInfo, buildId: 'different-build-same-version' };
    await expect(action(vaultClient)).rejects.toMatchObject({ code: 'RUNTIME_RELOAD_REQUIRED' });
    expect(sendMessage.mock.calls.map(([request]) => request.type)).toEqual(['RUNTIME_INFO', 'VAULT_STATUS', 'RUNTIME_INFO']);
  });

  it('does not recheck before commands that carry no secret material', async () => {
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === 'RUNTIME_INFO' ? compatible : { ok: true, data: [] });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    const { vaultClient } = await import('./client');
    await vaultClient.status();
    await vaultClient.listItems();
    await vaultClient.getItem('synthetic-id');
    expect(sendMessage.mock.calls.filter(([request]) => request.type === 'RUNTIME_INFO')).toHaveLength(1);
  });

  it("preserves a real authentication failure instead of treating it as an upgrade", async () => {
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? compatible : { ok: false, error: "主密码错误。", code: "TEST_AUTHENTICATION_FAILURE" });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.unlock("wrong password")).rejects.toMatchObject({ message: "主密码错误。", code: "TEST_AUTHENTICATION_FAILURE" });
  });

  it("offers recovery if a supported command disappears after the initial check", async () => {
    const sendMessage = vi.fn(async (request: { type: string }) => request.type === "RUNTIME_INFO" ? compatible : unsupported);
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    const { vaultClient } = await import("./client");
    await expect(vaultClient.lockedAutofillIds()).rejects.toMatchObject({ code: "RUNTIME_RELOAD_REQUIRED" });
  });
});
