import type { VaultItem } from './model';
import type { PasswordProjectRemovalRecord } from './password-project-removal-journal';
import { canonicalJson, sha256Hex } from './digest';

export interface BitwardenProjectLocalChild {
  itemId: string;
  kind: 'passkey' | 'totp';
  cipherId: string;
  remoteId: string;
  snapshotSha256: string;
  /** Version-1 journals without this field retain their strict full snapshot. */
  usageIndependentSha256?: string;
}

export class BitwardenProjectLocalChange extends Error {
  constructor() { super('Bitwarden 移除期间本地项目或关联凭据已变化，正在恢复原密码并保留冲突版本。'); }
}

export function sameBitwardenProjectChild(saved: BitwardenProjectLocalChild, current: BitwardenProjectLocalChild): boolean {
  return saved.itemId === current.itemId && saved.kind === current.kind && saved.cipherId === current.cipherId
    && saved.remoteId === current.remoteId && (saved.snapshotSha256 === current.snapshotSha256
      || saved.kind === 'passkey' && Boolean(saved.usageIndependentSha256) && saved.usageIndependentSha256 === current.usageIndependentSha256);
}

export function sameBitwardenProjectChildren(saved: BitwardenProjectLocalChild[], current: BitwardenProjectLocalChild[]): boolean {
  return saved.length === current.length && saved.every(row => current.some(other => sameBitwardenProjectChild(row, other)));
}

export function bitwardenProjectCipherId(remoteId: string): string {
  return remoteId.replace(/#(?:fido2:.*|totp)$/, '');
}

/** Separate local usage statistics from credential content. Signing counters,
 * their high-water marks, keys, policy flags and references remain in both hashes.
 */
export async function snapshotBitwardenProjectChildren(record: PasswordProjectRemovalRecord, items: VaultItem[]): Promise<BitwardenProjectLocalChild[]> {
  const provider = record.providerBindings.find(row => row.kind === 'bitwarden');
  if (!provider) throw new Error('Bitwarden 项目缺少来源绑定。');
  const ciphers = new Set([...record.retained, ...record.removed].map(row => row.providerRefs.find(ref => ref.providerId === provider.id)!.remoteId));
  const children: BitwardenProjectLocalChild[] = [];
  for (const row of items) {
    const ref = row.providerRefs.find(ref => ref.providerId === provider.id);
    if (!ref?.remoteId || !ciphers.has(bitwardenProjectCipherId(ref.remoteId)) || row.kind === 'login') continue;
    if (row.kind !== 'passkey' && row.kind !== 'totp') throw new Error('Bitwarden 项目包含不支持的关联记录，原始内容已保留。');
    const { useCount: _useCount, lastUsedAt: _lastUsedAt, ...content } = row.kind === 'passkey' ? row : { ...row, useCount: undefined, lastUsedAt: undefined };
    children.push({ itemId: row.id, kind: row.kind, cipherId: bitwardenProjectCipherId(ref.remoteId), remoteId: ref.remoteId,
      snapshotSha256: await bitwardenProjectLocalSha256(row),
      ...(row.kind === 'passkey' ? {usageIndependentSha256: await bitwardenProjectLocalSha256(content)} : {}) });
  }
  return children.sort((a, b) => a.itemId.localeCompare(b.itemId));
}

export async function bitwardenProjectLocalSha256(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
