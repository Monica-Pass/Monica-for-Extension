import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, type LoginItem, type TotpItem, type VaultItem, type ProviderKind } from '../core/model';
import { resolveLoginOtp, parametersFromItem, hotpUsageFromItem } from '../core/login-otp';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

const password = 'synthetic HOTP usage test password';
const secret = 'otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=0';
function login(): LoginItem { return { ...createLoginItem({ title: 'OTP', password: 'synthetic' }), totpSecret: secret }; }
async function fixture(rows: VaultItem[] = [login()]) {
  const storage = new MemoryVaultStorage();
  const service = new SecureVaultService(storage, new MemoryVaultSessionStore());
  await service.setup(password, rows);
  return { service, storage, rows: rows as LoginItem[] };
}

function projectRows(): LoginItem[] {
  return [0, 1, 2].map(index => ({ ...login(), passwordGroupId: 'project', password: `password-${index}`,
    customFields: [{ name: 'monica.content.credential', protected: true, value: JSON.stringify({
      version: 1, groupId: `00000000-0000-0000-0000-00000000000${index < 2 ? 1 : 2}`,
      passwordId: `00000000-0000-0000-0000-00000000001${index}`, primary: index < 2,
      label: 'Account', groupOrder: index < 2 ? 0 : 1, passwordOrder: index === 1 ? 1 : 0
    }) }, { name: 'unknown', value: '  preserve\r\n9007199254740993  ', protected: true }] }));
}

describe('HOTP successful-use acknowledgement', () => {
  it('preserves edits made while the code is being copied or filled', async () => {
    const { service, rows } = await fixture();
    const otp = await resolveLoginOtp(rows[0], rows);
    await service.upsertItem({ ...rows[0], notes: 'edited while page was responding', password: 'new password' });
    await service.consumeHotp(otp!.usage!);
    const current = await service.getItem(rows[0].id) as LoginItem;
    expect(current).toMatchObject({ notes: 'edited while page was responding', password: 'new password' });
    expect(parametersFromItem(current).counter).toBe(1);
  });

  it('does not roll back a counter advanced by a newer use', async () => {
    const { service, rows } = await fixture();
    const otp = await resolveLoginOtp(rows[0], rows);
    await service.upsertItem({ ...rows[0], totpSecret: secret.replace('counter=0', 'counter=5') });
    await service.consumeHotp(otp!.usage!);
    expect(parametersFromItem(await service.getItem(rows[0].id) as LoginItem).counter).toBe(5);
  });

  it('never resurrects an item deleted while the page was responding', async () => {
    const { service, rows, storage } = await fixture();
    const otp = await resolveLoginOtp(rows[0], rows);
    await service.deleteItem(rows[0].id);
    const before = JSON.stringify(storage.envelope);
    await expect(service.consumeHotp(otp!.usage!)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it.each([
    ['secret', { totpSecret: secret.replace('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 'JBSWY3DPEHPK3PXP') }],
    ['algorithm', { totpSecret: `${secret}&algorithm=SHA256` }],
    ['digits', { totpSecret: `${secret}&digits=8` }],
    ['binding', { boundTotpItemId: 'another-authenticator' }],
    ['group', { passwordGroupId: 'moved-project' }],
    ['database', { keepassDatabaseId: 99 }],
    ['archived', { archivedAt: new Date().toISOString() }]
  ] as const)('refuses a replaced %s without writing', async (_, patch) => {
    const { service, rows, storage } = await fixture();
    const usage = await hotpUsageFromItem(rows[0]);
    await service.upsertItem({ ...rows[0], ...patch });
    const before = JSON.stringify(storage.envelope);
    await expect(service.consumeHotp(usage!)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it('serializes duplicate acknowledgements and keeps later counters after restart', async () => {
    const { service, rows, storage } = await fixture();
    const usage = await hotpUsageFromItem(rows[0]);
    expect(await Promise.all([service.consumeHotp(usage!), service.consumeHotp(usage!)])).toEqual([true, false]);
    const current = await service.getItem(rows[0].id) as LoginItem;
    expect(await service.consumeHotp((await hotpUsageFromItem(current))!)).toBe(true);
    await service.lock();
    const reopened = new SecureVaultService(storage, new MemoryVaultSessionStore());
    await reopened.unlock(password);
    const before = JSON.stringify(storage.envelope);
    expect(await reopened.consumeHotp(usage!)).toBe(false);
    expect(JSON.stringify(storage.envelope)).toBe(before);
    expect(parametersFromItem(await reopened.getItem(current.id) as LoginItem).counter).toBe(2);
  });

  it.each(['local', 'mdbx2', 'monica-webdav', 'bitwarden', 'keepass'] satisfies ProviderKind[])(
    'updates only the explicit Android credential group and queues %s writes atomically', async kind => {
      const rows = projectRows().map(row => ({ ...row, providerRefs: [{ providerId: 'source', remoteId: row.id, revision: 'old' }] }));
      const independent = { ...rows[0], id: 'same-group-another-database', keepassDatabaseId: 100 };
      const { service, storage } = await fixture([...rows, independent]);
      await service.upsertProvider({ id: 'source', kind, name: 'Test source', enabled: true, isDefaultSaveTarget: false, config: {} });
      const usage = await hotpUsageFromItem(rows[0]);
      const latest = await service.upsertItem({ ...rows[0], notes: 'new note', password: 'new password' });
      const write = vi.spyOn(storage, 'write'); write.mockClear();
      expect(await service.consumeHotp(usage!)).toBe(true);
      expect(write).toHaveBeenCalledTimes(1);
      const state = await service.readState();
      for (const row of rows.slice(0, 2)) {
        const current = state.items.find(item => item.id === row.id) as LoginItem;
        expect(parametersFromItem(current).counter).toBe(1);
        expect({ ...current, totpSecret: row.totpSecret, updatedAt: row.updatedAt }).toEqual({ ...(row.id === latest.id ? latest : row), updatedAt: row.updatedAt });
      }
      expect(state.items.find(item => item.id === rows[2].id)).toEqual(rows[2]);
      expect(state.items.find(item => item.id === independent.id)).toEqual(independent);
      expect(state.mutationQueue.map(row => row.itemId).sort()).toEqual(kind === 'local' ? [] : rows.slice(0, 2).map(row => row.id).sort());
    });

  it('preserves the whole group and queue when encrypted persistence fails, then retries once', async () => {
    const { service, storage, rows } = await fixture(projectRows());
    const usage = await hotpUsageFromItem(rows[0]);
    const before = JSON.stringify(storage.envelope);
    vi.spyOn(storage, 'write').mockRejectedValueOnce(new Error('Synthetic storage failure'));
    await expect(service.consumeHotp(usage!)).rejects.toThrow('Synthetic storage failure');
    expect(JSON.stringify(storage.envelope)).toBe(before);
    expect((await service.readState()).items).toEqual(rows);
    expect(await service.consumeHotp(usage!)).toBe(true);
    expect(await service.consumeHotp(usage!)).toBe(false);
  });

  it('refuses an inconsistent shared counter without partially updating the project', async () => {
    const rows = projectRows(); rows[1].totpSecret = secret.replace('counter=0', 'counter=4');
    const { service, storage } = await fixture(rows);
    const before = JSON.stringify(storage.envelope);
    await expect(service.consumeHotp((await hotpUsageFromItem(rows[0]))!)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it('refuses usage while another credential group has a pending project removal', async () => {
    const { service, storage, rows } = await fixture(projectRows().map(row => ({ ...row,
      providerRefs: [{ providerId: 'source', remoteId: row.id }] })));
    await service.upsertProvider({ id: 'source', kind: 'monica-webdav', name: 'Test', enabled: true, isDefaultSaveTarget: false, config: {} });
    const usage = await hotpUsageFromItem(rows[0]);
    const staged = await service.stagePasswordProjectRemoval({ operationId: crypto.randomUUID(), items: rows,
      expected: Object.fromEntries(rows.map(row => [row.id, row.updatedAt])), removedItemIds: [rows[2].id] });
    expect(staged.removal).toBeDefined();
    expect(staged.removal!.status).not.toBe('completed');
    const before = JSON.stringify(storage.envelope);
    await expect(service.consumeHotp(usage!)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it('refuses unresolved provider conflicts without consuming the code', async () => {
    const item = { ...login(), providerRefs: [{ providerId: 'source', remoteId: 'remote-id' }] };
    const { service, storage } = await fixture([item]);
    await service.upsertProvider({ id: 'source', kind: 'monica-webdav', name: 'Test', enabled: true, isDefaultSaveTarget: false, config: {} });
    const usage = await hotpUsageFromItem(item);
    await service.applyProviderSync('source', [item], undefined, [{ itemId: item.id, reason: 'Synthetic conflict', local: item, remote: { ...item, notes: 'remote edit' } }]);
    expect(await service.getItem(item.id)).toEqual(item);
    expect(await service.listProviderConflicts()).toHaveLength(1);
    const before = JSON.stringify(storage.envelope);
    await expect(service.consumeHotp(usage!)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it('updates linked standalone authenticators without replacing their later notes or binding', async () => {
    const linked: TotpItem = { ...login(), id: 'standalone', kind: 'totp', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      algorithm: 'SHA1', digits: 6, period: 30, otpType: 'HOTP', counter: '9007199254740993' };
    const item = { ...login(), boundTotpItemId: linked.id };
    const { service, storage } = await fixture([item, linked]);
    const resolution = await resolveLoginOtp(item, [item, linked]);
    await service.upsertItem({ ...linked, notes: 'later note' });
    expect(await service.consumeHotp(resolution!.usage!)).toBe(true);
    expect(await service.getItem(linked.id)).toMatchObject({ notes: 'later note', counter: '9007199254740994' });
    const next = await resolveLoginOtp(item, (await service.readState()).items);
    await service.upsertItem({ ...item, boundTotpItemId: '' });
    const before = JSON.stringify(storage.envelope);
    await expect(service.consumeHotp(next!.usage!)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
  });

  it('rejects locked use, counters ahead of the current source and exhausted counters', async () => {
    const { service, storage, rows } = await fixture();
    const usage = (await hotpUsageFromItem(rows[0]))!;
    const before = JSON.stringify(storage.envelope);
    await expect(service.consumeHotp({ ...usage, counter: 1 })).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(before);
    await service.lock();
    await expect(service.consumeHotp(usage)).rejects.toThrow();
    await service.unlock(password);
    const exhausted = { ...rows[0], totpSecret: secret.replace('counter=0', 'counter=9223372036854775807') };
    await service.upsertItem(exhausted);
    const atLimit = JSON.stringify(storage.envelope);
    await expect(resolveLoginOtp(exhausted, [exhausted])).rejects.toThrow();
    await expect(service.consumeHotp((await hotpUsageFromItem(exhausted))!)).rejects.toThrow();
    expect(JSON.stringify(storage.envelope)).toBe(atLimit);
  });
});
