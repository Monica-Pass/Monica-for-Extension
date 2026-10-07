import type { PasswordProjectNativeDeletionIntent, PasswordProjectRemovalRecord } from './password-project-removal-journal';

/** Fixed tuple order keeps the durable identity independent of object key order. */
export async function passwordProjectNativeDeletionScope(record: Pick<PasswordProjectRemovalRecord, 'id' | 'requestHash'>,
  intent: Omit<PasswordProjectNativeDeletionIntent, 'operationScope'>): Promise<string> {
  const value = [intent.version, 'password-project-removal', record.id, record.requestHash, intent.providerId, intent.vaultHandle,
    intent.writeRevision.vaultId, intent.writeRevision.revisionSha256,
    intent.mutations.map(mutation => [mutation.kind, mutation.logicalObjectId, mutation.expectedHeadCommitId])];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function assertPasswordProjectNativeDeletionScope(record: PasswordProjectRemovalRecord): Promise<void> {
  const intent = record.nativeDeletion?.intent;
  if (!intent || intent.operationScope !== await passwordProjectNativeDeletionScope(record, intent))
    throw new Error('密码项目原生删除意图校验失败，恢复记录已保留。');
}
