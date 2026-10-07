import { expect, it } from 'vitest';
import type { ProviderAccount } from '../../core/model';
import { createKeePassCacheEncryptionKey } from './keepass-receipt-crypto';
import { sealKeePassConflictRecovery, openKeePassConflictRecovery, type KeePassConflictRecoveryInput } from './keepass-conflict-recovery';
import { MemoryKeePassConflictRecoveryStorage, KEEPASS_CONFLICT_RECOVERY_LIMIT } from './keepass-conflict-recovery-store';
import { buildKeePassFixture } from './keepass-fixture';
import { openKeePassVault } from './keepass-vault';

async function fixture() {
  const source: ProviderAccount = { id: 'recovery-source', kind: 'keepass', name: 'Private source', enabled: true, isDefaultSaveTarget: false,
    config: { databasePassword: 'Private password', cacheEncryptionKey: createKeePassCacheEncryptionKey() } };
  const bytes = await buildKeePassFixture({ password: 'Private password', entries: [{ title: 'Private entry', fields: { Notes: 'Private note' } }] });
  const input: KeePassConflictRecoveryInput = { operationId: 'resolve-1', createdAt: '2026-10-06T00:00:00Z', reviewToken: 'a'.repeat(64), source,
    choices: [{ projectId: 'project', choice: 'local' }], files: { base: bytes, working: bytes.slice(), remote: bytes.slice(), resolved: bytes.slice() } };
  return { source, input };
}

it('retains exact source credentials and four independently authenticated native files without plaintext metadata', async () => {
  const { source, input } = await fixture(), original = structuredClone(input);
  const sealed = await sealKeePassConflictRecovery(source, input);
  expect(input).toEqual(original);
  expect(JSON.stringify(sealed)).not.toContain('Private'); expect(JSON.stringify(sealed)).not.toContain(source.config.cacheEncryptionKey);
  const opened = await openKeePassConflictRecovery(source, sealed);
  expect(opened).toEqual(input);
  for (const bytes of Object.values(opened.files)) {
    const vault = await openKeePassVault(bytes, { password: 'Private password', providerId: source.id, databaseId: 1 });
    expect(vault.items[0].notes).toBe('Private note');
  }
});

it.each(['operation', 'provider', 'time', 'review', 'metadata', 'file', 'swap', 'key'] as const)('rejects %s tampering', async mode => {
  const { source, input } = await fixture(), sealed = await sealKeePassConflictRecovery(source, input);
  if (mode === 'operation') sealed.operationId = 'resolve-other';
  if (mode === 'provider') sealed.providerId = 'other';
  if (mode === 'time') sealed.createdAt = '2026-10-07T00:00:00Z';
  if (mode === 'review') sealed.reviewToken = 'b'.repeat(64);
  if (mode === 'metadata') sealed.metadata.ciphertext[0] ^= 1;
  if (mode === 'file') sealed.files.working.ciphertext[0] ^= 1;
  if (mode === 'swap') [sealed.files.base, sealed.files.resolved] = [sealed.files.resolved, sealed.files.base];
  if (mode === 'key') source.config.cacheEncryptionKey = createKeePassCacheEncryptionKey();
  await expect(openKeePassConflictRecovery(source, sealed)).rejects.toThrow();
});

it('recovers immutable create after response loss, rejects changed intent, and retains all copies when full', async () => {
  const { source, input } = await fixture(), records = new Map(), store = new MemoryKeePassConflictRecoveryStorage(records);
  const sealed = await sealKeePassConflictRecovery(source, input);
  await store.create(sealed); // durable commit; caller's acknowledgement may be lost
  const restarted = new MemoryKeePassConflictRecoveryStorage(records);
  const retry = await sealKeePassConflictRecovery(source, { ...input, createdAt: '2026-10-07T00:00:00Z' });
  expect(retry.intentTag).toBe(sealed.intentTag);
  expect(await restarted.create(retry)).toEqual(sealed);
  const different = await sealKeePassConflictRecovery(source, { ...input, choices: [{ projectId: 'project', choice: 'remote' }] });
  await expect(restarted.create(different)).rejects.toThrow('标识');
  for (let n = 1; n < KEEPASS_CONFLICT_RECOVERY_LIMIT; n++) await restarted.create(await sealKeePassConflictRecovery(source, { ...input, operationId: `resolve-${n + 1}` }));
  await expect(restarted.create(await sealKeePassConflictRecovery(source, { ...input, operationId: 'overflow' }))).rejects.toThrow('上限');
  expect(await restarted.list(source.id)).toHaveLength(KEEPASS_CONFLICT_RECOVERY_LIMIT);
  const read = (await restarted.read(source.id, input.operationId))!; read.files.base.ciphertext.fill(0);
  expect(await restarted.read(source.id, input.operationId)).toEqual(sealed);
  expect(await restarted.read('other', input.operationId)).toBeUndefined();
});
