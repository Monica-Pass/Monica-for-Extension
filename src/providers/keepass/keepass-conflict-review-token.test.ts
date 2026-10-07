import { expect, it } from 'vitest';
import type { ProviderAccount } from '../../core/model';
import { createKeePassCacheEncryptionKey } from './keepass-receipt-crypto';
import { keePassConflictReviewToken, type KeePassConflictRevision } from './keepass-conflict-review-token';

function fixture() {
  const account: ProviderAccount = { id: 'kp', kind: 'keepass', enabled: true, name: 'Synthetic', isDefaultSaveTarget: false,
    config: { sourceMode: 'webdav', databaseId: 1, webDavBaseUrl: 'https://example.com', remotePath: '/vault.kdbx',
      databasePassword: 'Secret password', cacheEncryptionKey: createKeePassCacheEncryptionKey() } };
  const version: KeePassConflictRevision = { revision: 3, baseSha256: 'a'.repeat(64), workingSha256: 'b'.repeat(64), remoteSha256: 'c'.repeat(64), remoteEtag: '"v2"' };
  return { account, version };
}

it.each(['baseSha256', 'workingSha256', 'remoteSha256', 'revision', 'remoteEtag'] as const)('binds the review to %s', async key => {
  const { account, version } = fixture(), original = await keePassConflictReviewToken(account, version);
  const updated = { ...version, [key]: key === 'revision' ? 4 : key === 'remoteEtag' ? '"v3"' : 'd'.repeat(64) };
  expect(original).toMatch(/^[a-f0-9]{64}$/);
  expect(await keePassConflictReviewToken(account, updated)).not.toBe(original);
});

it.each(['databaseId', 'remotePath', 'databasePassword', 'keyFile', 'webDavUsername', 'webDavPassword', 'cacheEncryptionKey', 'oneDriveItemId'])('invalidates the review after source %s changes', async key => {
  const { account, version } = fixture(), original = await keePassConflictReviewToken(account, version);
  account.config[key] = key === 'cacheEncryptionKey' ? createKeePassCacheEncryptionKey() : key === 'databaseId' ? 2 : 'changed';
  expect(await keePassConflictReviewToken(account, version)).not.toBe(original);
});

it('keeps sync bookkeeping and token refresh out of binding, but includes OneDrive account identity', async () => {
  const { account, version } = fixture();
  account.config.sourceMode = 'onedrive';
  account.config.oneDriveConnection = { id: 'connection', clientId: 'app', profile: { id: 'user' }, accessToken: 'old' };
  const original = await keePassConflictReviewToken(account, version);
  account.lastSyncAt = new Date().toISOString(); account.config.workingCopyRevision = 99;
  account.config.oneDriveConnection = { id: 'connection', clientId: 'app', profile: { id: 'user' }, accessToken: 'new' };
  expect(await keePassConflictReviewToken(account, version)).toBe(original);
  account.config.oneDriveConnection = { id: 'connection', clientId: 'app', profile: { id: 'other-user' }, accessToken: 'new' };
  expect(await keePassConflictReviewToken(account, version)).not.toBe(original);
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid revision %s', async revision => {
  const { account, version } = fixture();
  await expect(keePassConflictReviewToken(account, { ...version, revision })).rejects.toThrow();
});
