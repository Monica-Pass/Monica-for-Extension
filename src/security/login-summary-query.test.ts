import { afterEach, expect, it, vi } from 'vitest';
import { createLoginItem } from '../core/model';
import { createAutofillRuntime } from '../background/autofill-runtime';
import { SecureVaultService } from './secure-vault-service';
import { MemoryVaultStorage } from './vault-storage';
import { MemoryVaultSessionStore } from './vault-session';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  vi.stubGlobal('chrome', { runtime: { id: 'synthetic', getURL: (name: string) => `chrome-extension://synthetic/${name}` } });
  const storage = new MemoryVaultStorage(), sessions = new MemoryVaultSessionStore();
  const vault = new SecureVaultService(storage, sessions);
  await vault.setup('');
  const items = Array.from({ length: 61 }, (_, i) => ({ ...createLoginItem({ title: `Café work ${String(i).padStart(3, '0')}`,
    username: `alice-${i}`, password: 'secret-must-stay-in-worker', notes: 'private-note-no-search',
    uris: [i === 0 ? 'https://login.example.test' : 'https://unrelated.invalid'] }), id: `row-${i}`,
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }));
  await vault.importItems(items);
  const runtime = createAutofillRuntime({ service: vault } as unknown as Parameters<typeof createAutofillRuntime>[0]);
  const sender = { id: 'synthetic', url: 'chrome-extension://synthetic/popup.html', origin: 'chrome-extension://synthetic' };
  const query = (params: Record<string, unknown>, source = sender) => runtime.handlers.VAULT_LIST_LOGIN_SUMMARIES(
    { type: 'VAULT_LIST_LOGIN_SUMMARIES', query: params } as any, source, false) as Promise<any>;
  return { storage, sessions, vault, items, query };
}

it('returns only the requested summary page and searches the whole vault across fields', async () => {
  const f = await fixture();
  const fullRead = vi.spyOn(f.vault, 'listItems');
  const page = await f.query({ page: 2, text: '', passwordLabel: 'Password {0}', excludeMatchingUrl: 'https://login.example.test' });
  expect(page).toMatchObject({ page: 2, total: 60 });
  expect(page.items).toHaveLength(20);
  expect(JSON.stringify(page)).not.toMatch(/secret-must|private-note/);
  expect(fullRead).not.toHaveBeenCalled();
  const found = await f.query({ page: 1, text: 'alice-7 cafe', passwordLabel: 'Password {0}' });
  expect(found.items.map((row: any) => row.id)).toEqual(['row-7']);
  expect((await f.query({ page: 99, text: '' })).page).toBe(4);
  expect((await f.query({ page: 1, text: 'private-note-no-search' })).total).toBe(0);
  await f.vault.lock();
});

it('rejects website callers and locked queries, including a previously warm result', async () => {
  const f = await fixture();
  await f.query({ page: 1, text: '' });
  await expect(f.query({ page: 1 }, { id: 'synthetic', url: 'https://login.example.test', origin: 'https://login.example.test' })).rejects.toThrow();
  await f.vault.lock();
  await expect(f.query({ page: 1, text: '' })).rejects.toThrow();
});

it('does not hide matching entries from browse/search when their website is blocked for autofill', async () => {
  const f = await fixture();
  await f.vault.setAutofillSitePolicy({ blockedHosts: ['example.test'], saveBlockedHosts: [] });
  const page = await f.query({ page: 1, text: 'alice-0', excludeMatchingUrl: 'https://login.example.test' });
  expect(page.items.map((row: any) => row.id)).toEqual(['row-0']);
  await f.vault.lock();
});

it('projects before copying, isolates returned rows, and sees later edits without retaining a search cache', async () => {
  const f = await fixture();
  await f.query({ page: 1, text: '' });
  const clone = vi.spyOn(globalThis, 'structuredClone');
  const first = await f.query({ page: 1, text: 'alice-7' });
  expect(clone.mock.calls.some(([value]) => JSON.stringify(value).includes('secret-must-stay-in-worker'))).toBe(false);
  first.items[0].title = 'caller mutation';
  first.items[0].uris.push('https://injected.invalid');
  expect((await f.query({ page: 1, text: 'alice-7' })).items[0].title).not.toBe('caller mutation');
  const item = await f.vault.getItem('row-7');
  await f.vault.upsertItem({ ...item!, title: 'Changed after search' });
  expect((await f.query({ page: 1, text: 'Changed alice-7' })).items).toHaveLength(1);
  await f.vault.lock();
});

it('computes credential numbering before search and excludes archived/deleted entries', async () => {
  const f = await fixture();
  for (const index of [1, 2]) await f.vault.upsertItem({ ...f.items[index], username: 'shared',
    passwordGroupId: '00000000-0000-4000-8000-000000000001' });
  const all = await f.query({ page: 1, text: 'shared' });
  const second = all.items.find((row: any) => row.credentialIdentity?.passwordNumber === 2);
  expect(second).toBeDefined();
  const selected = await f.query({ page: 1, text: `${second.title} Password 2`, passwordLabel: 'Password {0}' });
  expect(selected.items.map((row: any) => row.id)).toEqual([second.id]);
  await f.vault.upsertItem({ ...f.items[3], archivedAt: '2026-11-12T00:00:00.000Z' });
  await f.vault.upsertItem({ ...f.items[4], deletedAt: '2026-11-12T00:00:00.000Z' });
  expect((await f.query({ page: 1, text: 'alice-3' })).items.some((row: any) => row.id === 'row-3')).toBe(false);
  expect((await f.query({ page: 1, text: 'alice-4' })).items.some((row: any) => row.id === 'row-4')).toBe(false);
  await f.vault.lock();
});

it.each([{ page: -1 }, { page: 1.5 }, { page: Infinity }, { text: 'a'.repeat(1025) }, { passwordLabel: 'x'.repeat(161) }, { excludeMatchingUrl: 4 }, { excludeIds: Array(101).fill('id') }, { excludeIds: [1] }])(
  'rejects malformed or unbounded query input %j', async input => {
    const f = await fixture();
    await expect(f.query(input)).rejects.toThrow();
    await f.vault.lock();
  }
);
