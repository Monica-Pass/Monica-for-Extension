import { expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { ProviderAccount } from '../../core/model';
import { createPasskey } from '../../passkey/webauthn-core';
import { MonicaWebDavProvider } from './monica-webdav-provider';
import { encryptAndroidBackup, type AndroidBackupEncryptionFormat } from './android-backup-crypto';
import { listAndroidPortableAttachments, readAndroidPortableAttachment } from './android-backup-codec';

const name = 'monica_backup_snapshot.enc.zip', baseUrl = 'https://example.test/dav';
const account: ProviderAccount = { id: 'dav', kind: 'monica-webdav', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false,
  config: { baseUrl, username: 'synthetic', password: 'synthetic', backupPassword: 'synthetic backup', lastFileName: name, lastEtag: '"v1"' } };
const sha = async (value: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-256', value as BufferSource)).toString('hex');
async function fixture(mode = '', format: AndroidBackupEncryptionFormat = 'v1') {
  const key = await createPasskey({ origin: 'https://example.test', challenge: Buffer.alloc(32, 1).toString('base64url'), rpName: 'Synthetic',
    userId: 'dXNlcg', userName: 'user', userDisplayName: 'User', algorithms: [-7], excludeCredentialIds: [] });
  const attachment = Uint8Array.of(1, 2, 3, 4);
  const zip = zipSync({
    'passwords/password_42.json': strToU8(JSON.stringify({ id: 42, title: 'Synthetic', password: 'synthetic', createdAt: 1, updatedAt: 2 })),
    'passkeys/passkey_43.json': strToU8(JSON.stringify({ credentialId: key.credentialId, rpId: 'example.test', rpName: 'Synthetic',
      userId: 'dXNlcg', userName: 'user', publicKeyAlgorithm: -7, publicKey: key.publicKeySpki, privateKeyAlias: key.privateKeyPkcs8, signCount: 0, createdAt: 1 })),
    'attachments_portable/attachments_portable.json': strToU8(JSON.stringify({ version: 2, entries: [{ parentPasswordId: 42,
      payloadPath: 'attachments_portable/test.bin', fileName: 'recovery.txt', sizeBytes: attachment.length, sha256Hex: await sha(attachment) }] })),
    'attachments_portable/test.bin': attachment
  }, { level: 0 }); // Stored ZIP entries must also outlive the cleared archive buffer.
  let remote = mode === 'plaintext' ? zip : await encryptAndroidBackup(zip, 'synthetic backup', undefined, undefined, format), lists = 0;
  const controller = new AbortController();
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === 'PROPFIND') {
      if (mode === 'missing') return new Response(null, { status: 404 });
      const changed = ++lists > 1;
      const file = changed && mode === 'latest' ? 'monica_backup_new.enc.zip' : name;
      const etag = changed && mode === 'etag' ? '"v2"' : mode === 'weak' ? 'W/"v1"' : '"v1"';
      const size = remote.length + (changed && mode === 'size' ? 1 : 0);
      return new Response(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Monica_Backups/${file}</d:href><d:propstat><d:prop>
        <d:getetag>${etag}</d:getetag><d:getcontentlength>${size}</d:getcontentlength>
        <d:getlastmodified>${changed && mode === 'modified' ? 'Tue, 13 Oct 2026 00:00:00 GMT' : 'Mon, 12 Oct 2026 00:00:00 GMT'}</d:getlastmodified>
        </d:prop></d:propstat></d:response></d:multistatus>`, { status: 207 });
    }
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('If-Match')).toBe(mode === 'weak' ? null : '"v1"');
    if (mode === 'abort') controller.abort();
    return new Response(Uint8Array.from(remote), { headers: { etag: mode === 'response-etag' ? '"v2"' : '"v1"' } });
  });
  const provider = new MonicaWebDavProvider(fetcher);
  return { key, attachment, fetcher, controller, provider, hash: () => sha(remote),
    replace: async () => { remote = await encryptAndroidBackup(zip, 'synthetic backup', undefined, undefined, format); lists = 0; } };
}

it.each([['strong', 'v1'], ['weak', 'v1'], ['strong', 'v2'], ['weak', 'v2']] as const)('returns an intact encrypted snapshot with %s ETags and %s encryption with no writes', async (mode, format) => {
  const f = await fixture(mode, format), snapshot = await f.provider.readTransferSnapshot(account);
  expect(snapshot.sha256).toBe(await f.hash());
  expect(snapshot.document.items.find(item => item.kind === 'passkey')).toMatchObject({ privateKeyPkcs8: f.key.privateKeyPkcs8, credentialId: f.key.credentialId, signCount: 0 });
  const login = snapshot.document.items.find(item => item.kind === 'login')!;
  const files = listAndroidPortableAttachments(snapshot.document, login);
  expect(files).toHaveLength(1); expect(await readAndroidPortableAttachment(snapshot.document, files[0])).toEqual(f.attachment);
  expect(f.fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['PROPFIND', 'GET', 'PROPFIND']);
  await f.replace();
  expect((await f.provider.readTransferSnapshot(account)).sha256).not.toBe(snapshot.sha256);
});

it.each(['latest', 'etag', 'size', 'modified', 'response-etag', 'abort']
  .flatMap(mode => (['v1', 'v2'] as const).map(format => [mode, format] as const)))('refuses %s changes during %s snapshot reading', async (mode, format) => {
  const f = await fixture(mode, format); await expect(f.provider.readTransferSnapshot(account, f.controller.signal)).rejects.toThrow();
  expect(f.fetcher.mock.calls.every(([, init]) => ['GET', 'PROPFIND'].includes(init!.method!))).toBe(true);
});

it('does not create a missing source folder or download an unreviewed backup', async () => {
  const missing = await fixture('missing'); await expect(missing.provider.readTransferSnapshot(account)).rejects.toThrow('尚未同步');
  expect(missing.fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['PROPFIND']);
  const stale = await fixture(); await expect(stale.provider.readTransferSnapshot({ ...account, config: { ...account.config, lastEtag: '"old"' } })).rejects.toThrow('先同步');
  expect(stale.fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['PROPFIND']);
});

it('does not authorize plaintext portable keys or attachments based on the encrypted filename', async () => {
  const f = await fixture('plaintext'), snapshot = await f.provider.readTransferSnapshot(account);
  expect(snapshot.document.portableAttachmentsAllowed).toBe(false);
  expect(snapshot.document.items.find(item => item.kind === 'passkey')).not.toHaveProperty('privateKeyPkcs8');
});
