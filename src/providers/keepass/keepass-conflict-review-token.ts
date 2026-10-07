import type { ProviderAccount } from '../../core/model';
import { base64ToBytes } from '../../security/encoding';
import { KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG } from './keepass-receipt-crypto';

export interface KeePassConflictRevision {
  revision: number;
  baseSha256: string;
  workingSha256: string;
  remoteSha256: string;
  remoteEtag: string;
}

/** Source credentials are covered by HMAC, never returned as review metadata. */
export async function keePassConflictReviewToken(account: ProviderAccount, version: KeePassConflictRevision): Promise<string> {
  if (account.kind !== 'keepass' || !account.enabled || !['webdav', 'onedrive'].includes(String(account.config.sourceMode))
    || !Number.isSafeInteger(version.revision) || version.revision < 1 || !version.remoteEtag
    || [version.baseSha256, version.workingSha256, version.remoteSha256].some(value => !/^[a-f0-9]{64}$/.test(value)))
    throw new Error('KeePass 冲突预览版本无效。');
  const encoded = account.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG];
  if (typeof encoded !== 'string') throw new Error('KeePass 冲突预览密钥不可用。');
  const bytes = base64ToBytes(encoded);
  try {
    if (bytes.length !== 32) throw new Error('KeePass 冲突预览密钥无效。');
    const keys = ['sourceMode', 'databaseId', 'webDavBaseUrl', 'webDavUsername', 'webDavPassword', 'remotePath',
      'databasePassword', 'keyFile', 'oneDriveDriveId', 'oneDriveItemId'];
    const connection = account.config.oneDriveConnection as { id?: string; clientId?: string; profile?: { id?: string } } | undefined;
    const input = new TextEncoder().encode(JSON.stringify({ domain: 'monica-keepass-project-conflict-review-v1', providerId: account.id,
      source: keys.map(key => [key, account.config[key]]), connection: [connection?.id, connection?.clientId, connection?.profile?.id],
      revision: version.revision, base: version.baseSha256, working: version.workingSha256, remote: version.remoteSha256, etag: version.remoteEtag }));
    try {
      const key = await crypto.subtle.importKey('raw', bytes as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = await crypto.subtle.sign('HMAC', key, input as BufferSource);
      return [...new Uint8Array(signature)].map(value => value.toString(16).padStart(2, '0')).join('');
    } finally { input.fill(0); }
  } finally { bytes.fill(0); }
}
