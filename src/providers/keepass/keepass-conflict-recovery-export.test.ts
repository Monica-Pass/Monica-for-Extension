import { expect, it } from 'vitest';
import * as kdbxweb from 'kdbxweb';
import type { ProviderAccount } from '../../core/model';
import { bytesToBase64 } from '../../security/encoding';
import { buildKeePassFixture, keePassCredentials } from './keepass-fixture';
import { openKeePassVault } from './keepass-vault';
import { createKeePassCacheEncryptionKey } from './keepass-receipt-crypto';
import { sealKeePassConflictRecovery } from './keepass-conflict-recovery';
import { exportKeePassConflictRecovery } from './keepass-conflict-recovery-export';

const exportPassword = 'Synthetic independent export password';
async function fixture(mode: 'password' | 'key-only' | 'passwordless' = 'password') {
  const password = mode === 'password' ? 'Synthetic original password' : '';
  const keyFile = mode === 'key-only' ? new Uint8Array(32).fill(7) : undefined;
  const source: ProviderAccount = { id: 'kp', kind: 'keepass', name: 'Private source name', enabled: true, isDefaultSaveTarget: false,
    config: { databasePassword: password, cacheEncryptionKey: createKeePassCacheEncryptionKey(), keyFile: keyFile && bytesToBase64(keyFile),
      webDavPassword: 'Never export cloud password', oneDriveConnection: { accessToken: 'Never export access token' } } };
  const files = {} as Record<'base' | 'working' | 'remote' | 'resolved', Uint8Array>;
  for (const part of ['base', 'working', 'remote', 'resolved'] as const) files[part] = await buildKeePassFixture({
    password: mode === 'key-only' ? null : password, keyFile, entries: [{ title: part, fields: { Notes: `Original ${part}` },
      protectedFields: { Password: `Inner secret ${part}` }, binaries: { 'payload.bin': Uint8Array.of(1, 3, 7) } }] });
  const capsule = await sealKeePassConflictRecovery(source, { operationId: 'operation', createdAt: '2026-10-06T00:00:00Z', reviewToken: 'a'.repeat(64),
    source, choices: [{ projectId: 'project', choice: 'local' }], files });
  return { source, files, capsule, keyFile, password };
}

it.each(['password', 'key-only', 'passwordless'] as const)('exports %s originals in an independently readable standard encrypted KDBX', async mode => {
  const f = await fixture(mode), before = structuredClone(f.capsule);
  const bytes = await exportKeePassConflictRecovery(f.source, f.capsule, f.capsule.intentTag, exportPassword);
  expect(f.capsule).toEqual(before);
  await expect(kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials('wrong export password'))).rejects.toThrow();
  // Independent library reader needs neither Monica's cache key nor provider.
  const db = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(exportPassword));
  expect(db.header.versionMajor).toBe(4);
  expect((db.header.kdfParameters!.get('M') as kdbxweb.Int64).value).toBe(64 * 1024 * 1024);
  const entries = db.getDefaultGroup().entries; expect(entries).toHaveLength(4);
  for (const entry of entries) {
    const part = String(entry.fields.get('MonicaRecoveryPart')) as keyof typeof f.files;
    const savedPassword = entry.fields.get('Password'); expect(savedPassword).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect((savedPassword as kdbxweb.ProtectedValue).getText()).toBe(f.password);
    const binary = entry.binaries.get(`${part}.kdbx`) as kdbxweb.KdbxBinaryWithHash;
    const original = binary.value instanceof kdbxweb.ProtectedValue ? binary.value.getBinary() : new Uint8Array(binary.value);
    expect(original).toEqual(f.files[part]);
    const vault = await openKeePassVault(original, { password: f.password, keyFile: f.keyFile, providerId: 'independent', databaseId: 7 });
    expect(vault.items[0].notes).toBe(`Original ${part}`);
    if (f.keyFile) {
      const attached = entry.binaries.get('original-key-file.key') as kdbxweb.KdbxBinaryWithHash;
      expect(attached.value instanceof kdbxweb.ProtectedValue ? attached.value.getBinary() : new Uint8Array(attached.value)).toEqual(f.keyFile);
    } else expect(entry.binaries.has('original-key-file.key')).toBe(false);
  }
  const xml = await db.saveXml();
  expect(xml).not.toContain('Never export'); expect(xml).not.toContain(String(f.source.config.cacheEncryptionKey));
  expect(xml).not.toContain('Private source name');
});

it('rejects stale selection, short export password and corrupted authenticated recovery', async () => {
  const f = await fixture();
  await expect(exportKeePassConflictRecovery(f.source, f.capsule, 'f'.repeat(64), exportPassword)).rejects.toThrow('已变化');
  await expect(exportKeePassConflictRecovery(f.source, f.capsule, f.capsule.intentTag, 'short')).rejects.toThrow('8');
  f.capsule.files.remote.ciphertext[0] ^= 1;
  await expect(exportKeePassConflictRecovery(f.source, f.capsule, f.capsule.intentTag, exportPassword)).rejects.toThrow();
});
