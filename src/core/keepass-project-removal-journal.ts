import type { ProviderAccount } from './model';
import { planKeePassProjectRemoval, type KeePassProjectRemovalDraft } from './keepass-project-removal';
import { canonicalJson, sha256Hex } from './digest';

export interface KeePassProjectRemovalIntent {
  version: 1;
  operationId: string;
  status: 'staged' | 'writing' | 'completed' | 'cancelled';
  expectedWorkingSha256?: string;
  outputSha256?: string;
  createdAt: string;
  /** Encrypted local source snapshot, never returned to an untrusted surface. */
  source: ProviderAccount;
  draft: KeePassProjectRemovalDraft;
}
export function keePassRemovalRequestKey(source: ProviderAccount, draft: KeePassProjectRemovalDraft): string {
  return canonicalJson({ source, draft });
}
export async function keePassRemovalFileRequestHash(source: ProviderAccount, request: {
  operationId: string; expectedWorkingSha256: string; draft: KeePassProjectRemovalDraft;
}): Promise<string> {
  const keys = ['sourceMode', 'databaseId', 'webDavBaseUrl', 'webDavUsername', 'remotePath', 'oneDriveDriveId', 'oneDriveItemId',
    ...(source.config.sourceMode === 'local-file' ? ['localFileSourceSha256'] : [])];
  return sha256Hex(canonicalJson({ request, source: { id: source.id,
    config: Object.fromEntries(keys.map(key => [key, source.config[key]])),
    oneDriveConnectionId: (source.config.oneDriveConnection as { id?: unknown } | undefined)?.id } }));
}
export function readKeePassProjectRemovalIntents(value: unknown): KeePassProjectRemovalIntent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('KeePass 项目移除恢复记录无效。');
  const ids = new Set<string>();
  return value.map(row => {
    if (!row || row.version !== 1 || typeof row.operationId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.operationId)
      || ids.has(row.operationId) || !['staged', 'writing', 'completed', 'cancelled'].includes(row.status)
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
      || !row.source || !row.draft || !Array.isArray(row.draft.originals)) throw new Error('KeePass 项目移除恢复记录无效。');
    planKeePassProjectRemoval(row.draft, row.draft.originals, row.source);
    if ((row.status === 'writing' || row.status === 'completed') !== (typeof row.expectedWorkingSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.expectedWorkingSha256))
      || (row.status === 'completed') !== (typeof row.outputSha256 === 'string' && /^[a-f0-9]{64}$/.test(row.outputSha256))
      || row.status !== 'completed' && row.outputSha256 !== undefined
      || !['writing', 'completed'].includes(row.status) && row.expectedWorkingSha256 !== undefined) throw new Error('KeePass 项目移除恢复阶段无效。');
    ids.add(row.operationId);
    return structuredClone({ version: 1, operationId: row.operationId, status: row.status, createdAt: row.createdAt,
      source: row.source, draft: row.draft, expectedWorkingSha256: row.expectedWorkingSha256, outputSha256: row.outputSha256 }) as KeePassProjectRemovalIntent;
  });
}
