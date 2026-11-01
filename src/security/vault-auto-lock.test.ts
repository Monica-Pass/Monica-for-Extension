import { describe, expect, it } from 'vitest';
import { SecureVaultService, VaultLockedError } from './secure-vault-service';
import { MemoryVaultSessionStore } from './vault-session';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultDeviceKeyStore } from './vault-device-key';
import { createLoginItem } from '../core/model';

async function fixture(password = '', sessions = new MemoryVaultSessionStore(), storage = new MemoryVaultStorage()) {
  let now = Date.now();
  const keys = new MemoryVaultDeviceKeyStore();
  const service = new SecureVaultService(storage, sessions, () => now, keys);
  await service.setup(password);
  return { service, sessions, storage, keys, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('custom inactivity lock duration', () => {
  it('reads the existing default without extending the session', async () => {
    const f = await fixture(); const before = await f.sessions.read();
    f.advance(120_000);
    expect(await f.service.getAutoLockMinutes()).toBe(15);
    expect(await f.sessions.read()).toEqual(before);
  });

  it.each(['', 'synthetic custom lock master password'])('persists across lock and a recreated service (%s)', async password => {
    const f = await fixture(password);
    const item = createLoginItem({ title: 'Preserved', password: 'synthetic-secret', uris: ['https://example.test'] });
    await f.service.upsertItem(item);
    await f.service.setAutoLockMinutes(37);
    await f.service.lock();
    const reopened = new SecureVaultService(f.storage, f.sessions, f.now, f.keys);
    await reopened.unlock(password);
    expect(await reopened.getAutoLockMinutes()).toBe(37);
    expect(await reopened.getItem(item.id)).toMatchObject({ password: 'synthetic-secret' });
    expect((await f.sessions.read())!.expiresAt).toBe(f.now() + 37 * 60_000);
  });

  it.each([1, 1440])('applies %i minutes from save time and locks at expiry', async minutes => {
    const f = await fixture(); f.advance(120_000);
    expect(await f.service.setAutoLockMinutes(minutes)).toBe(minutes);
    expect((await f.sessions.read())!.expiresAt).toBe(f.now() + minutes * 60_000);
    f.advance(minutes * 60_000 - 1);
    expect(await f.service.getAutoLockMinutes()).toBe(minutes);
    f.advance(1);
    await expect(f.service.getAutoLockMinutes()).rejects.toBeInstanceOf(VaultLockedError);
  });

  it.each([0, -1, 1441, 1.5, NaN, Infinity, '5', null, undefined, true])('rejects invalid duration %s without changing storage or expiry', async value => {
    const f = await fixture(); const envelope = await f.storage.read(), session = await f.sessions.read();
    await expect(f.service.setAutoLockMinutes(value as number)).rejects.toThrow();
    expect(await f.storage.read()).toEqual(envelope); expect(await f.sessions.read()).toEqual(session);
  });

  it('cannot read or change the setting after lock or expiry', async () => {
    const f = await fixture(); await f.service.lock();
    await expect(f.service.getAutoLockMinutes()).rejects.toBeInstanceOf(VaultLockedError);
    await expect(f.service.setAutoLockMinutes(5)).rejects.toBeInstanceOf(VaultLockedError);
    await f.service.unlock(''); f.advance(15 * 60_000);
    await expect(f.service.setAutoLockMinutes(1440)).rejects.toBeInstanceOf(VaultLockedError);
    await f.service.unlock(''); expect(await f.service.getAutoLockMinutes()).toBe(15);
  });

  it('retains the previous setting and expiry if the encrypted write fails', async () => {
    class Storage extends MemoryVaultStorage {
      fail = false;
      override async write(envelope: Parameters<MemoryVaultStorage['write']>[0]) {
        if (this.fail) throw new Error('synthetic write failure');
        await super.write(envelope);
      }
    }
    const storage = new Storage(), f = await fixture('', new MemoryVaultSessionStore(), storage);
    const before = await f.sessions.read(); storage.fail = true;
    await expect(f.service.setAutoLockMinutes(1)).rejects.toThrow('synthetic write failure');
    expect(await f.service.getAutoLockMinutes()).toBe(15); expect(await f.sessions.read()).toEqual(before);
  });

  it('locks if a shorter duration is durable but the session write fails', async () => {
    class Sessions extends MemoryVaultSessionStore {
      fail = false;
      override async write(session: Parameters<MemoryVaultSessionStore['write']>[0]) {
        if (this.fail) throw new Error('synthetic session failure');
        await super.write(session);
      }
    }
    const sessions = new Sessions(), f = await fixture('', sessions); sessions.fail = true;
    await expect(f.service.setAutoLockMinutes(1)).rejects.toBeInstanceOf(VaultLockedError);
    expect(await sessions.read()).toBeNull(); expect(await f.service.status()).toBe('locked');
    sessions.fail = false; await f.service.unlock(''); expect(await f.service.getAutoLockMinutes()).toBe(1);
  });

  it('cannot revive a session that expires during the durable write', async () => {
    class Storage extends MemoryVaultStorage {
      duringWrite?: () => void;
      override async write(envelope: Parameters<MemoryVaultStorage['write']>[0]) {
        await super.write(envelope); this.duringWrite?.();
      }
    }
    const storage = new Storage(), f = await fixture('', new MemoryVaultSessionStore(), storage);
    storage.duringWrite = () => f.advance(15 * 60_000);
    await expect(f.service.setAutoLockMinutes(1440)).rejects.toBeInstanceOf(VaultLockedError);
    expect(await f.sessions.read()).toBeNull(); expect(await f.service.status()).toBe('locked');
    storage.duringWrite = undefined;
    await f.service.unlock(''); expect(await f.service.getAutoLockMinutes()).toBe(1440);
  });
});
