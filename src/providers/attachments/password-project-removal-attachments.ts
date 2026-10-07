import type { LoginItem, ProviderAccount } from '../../core/model';
import { readPasswordProjectRemovalJournal, type PasswordProjectRemovalProof, type PasswordProjectRemovalRecord } from '../../core/password-project-removal-journal';
import type { ProviderAttachmentPage, ProviderAttachmentSummary } from './attachment-contract';
import { hashProviderAttachment, ProviderAttachmentTransferCoordinator, type ProviderAttachmentTransferBackend } from './attachment-transfer';

export interface PasswordProjectAttachmentBackend extends ProviderAttachmentTransferBackend {
  listAttachments(providerId: string, itemId: string, cursor?: string): Promise<ProviderAttachmentPage>;
}

export interface PasswordProjectRemovalInspector {
  inspectPasswordProjectRemoval(operationId: string): Promise<{ record: PasswordProjectRemovalRecord; items: LoginItem[] }>;
}

const changed = () => new Error('项目附件已变化或校验失败，原密码尚未移除。');
const metadata = (attachment: ProviderAttachmentSummary) => JSON.stringify([
  attachment.attachmentId, attachment.providerKind, attachment.fileName, attachment.mediaType ?? null, attachment.sizeBytes, attachment.protected
]);

/** A proof is provisional. The deleting backend must recheck it in its own CAS transaction. */
export async function preparePasswordProjectRemovalAttachments(
  operationId: string, vault: PasswordProjectRemovalInspector, backend: PasswordProjectAttachmentBackend
): Promise<{ items: LoginItem[]; proofs: PasswordProjectRemovalProof[] }> {
  const initial = await vault.inspectPasswordProjectRemoval(operationId);
  const [record] = readPasswordProjectRemovalJournal([initial.record]);
  if (record.id !== operationId || record.status !== 'preparing') throw changed();
  const proofs: PasswordProjectRemovalProof[] = [];
  if (record.ownerTransfer) {
    for (const account of record.providerBindings.filter(provider => provider.kind !== 'local')) {
      const { sourceItemId, targetItemId } = record.ownerTransfer;
      const sources = await listAll(backend, account, sourceItemId);
      const proof: PasswordProjectRemovalProof = { providerId: account.id, sourceItemId, targetItemId, attachments: [] };
      const usedTargets = new Set<string>();
      for (const source of sources) {
        // Fail before uploading if the project was edited while a prior file was copied.
        await vault.inspectPasswordProjectRemoval(operationId);
        const digest = await hashProviderAttachment(backend, account.id, sourceItemId, source.attachmentId, source.fileName, source.sizeBytes);
        const targets = await listAll(backend, account, targetItemId);
        const collisions = targets.filter(target => target.fileName === source.fileName);
        let target: ProviderAttachmentSummary | undefined;
        for (const candidate of collisions.filter(candidate => !usedTargets.has(candidate.attachmentId)
          && candidate.sizeBytes === source.sizeBytes && candidate.mediaType === source.mediaType && candidate.protected === source.protected)) {
          if (await hashProviderAttachment(backend, account.id, targetItemId, candidate.attachmentId, source.fileName, source.sizeBytes) === digest) {
            target = candidate; break;
          }
        }
        if (!target) {
          // Never overwrite or rename a user's same-name file. A matching copy
          // found above also recovers an upload committed before a worker crash.
          if (collisions.length) throw new Error('保留密码存在内容不同或重复占用的同名附件，原密码尚未移除。');
          const copyId = await operationUuid([operationId, account.id, sourceItemId, targetItemId, source.attachmentId, digest]);
          const copied = await new ProviderAttachmentTransferCoordinator().execute({ operationId: copyId,
            sourceProviderId: account.id, sourceItemId, sourceAttachmentId: source.attachmentId,
            targetProviderId: account.id, targetItemId, mode: 'copy', confirmedMove: false }, backend);
          target = copied.attachment;
          if (usedTargets.has(target.attachmentId)) throw changed();
        }
        if (await hashProviderAttachment(backend, account.id, targetItemId, target.attachmentId, source.fileName, source.sizeBytes) !== digest) throw changed();
        usedTargets.add(target.attachmentId);
        proof.attachments.push({ sourceAttachmentId: source.attachmentId, targetAttachmentId: target.attachmentId,
          fileName: source.fileName, mediaType: source.mediaType, sizeBytes: source.sizeBytes, sha256: digest });
      }
      const refreshed = await listAll(backend, account, sourceItemId);
      if (JSON.stringify(sources.map(metadata)) !== JSON.stringify(refreshed.map(metadata))) throw changed();
      proofs.push(proof);
    }
  }
  await verifyPasswordProjectRemovalAttachments(record, proofs, backend);
  const final = await vault.inspectPasswordProjectRemoval(operationId);
  if (JSON.stringify(final.record) !== JSON.stringify(initial.record)) throw changed();
  return { items: final.items, proofs };
}

/** Fresh source manifest + both byte streams. This alone cannot authorize a later sync deletion. */
export async function verifyPasswordProjectRemovalAttachments(
  record: PasswordProjectRemovalRecord, proofs: PasswordProjectRemovalProof[], backend: PasswordProjectAttachmentBackend
): Promise<void> {
  readPasswordProjectRemovalJournal([{ ...record, status: 'deleting', proofs }]);
  for (const proof of proofs) {
    const account = record.providerBindings.find(provider => provider.id === proof.providerId)!;
    const sources = await listAll(backend, account, proof.sourceItemId);
    const targets = await listAll(backend, account, proof.targetItemId);
    if (sources.length !== proof.attachments.length) throw changed();
    for (const entry of proof.attachments) {
      const source = sources.find(attachment => attachment.attachmentId === entry.sourceAttachmentId);
      const target = targets.find(attachment => attachment.attachmentId === entry.targetAttachmentId);
      if (!source || !target || [source, target].some(attachment => attachment.fileName !== entry.fileName
        || attachment.sizeBytes !== entry.sizeBytes || attachment.mediaType !== entry.mediaType) || source.protected !== target.protected) throw changed();
      for (const [itemId, attachmentId] of [[proof.sourceItemId, entry.sourceAttachmentId], [proof.targetItemId, entry.targetAttachmentId]]) {
        if (await hashProviderAttachment(backend, account.id, itemId, attachmentId, entry.fileName, entry.sizeBytes) !== entry.sha256) throw changed();
      }
    }
    const refreshed = await listAll(backend, account, proof.sourceItemId);
    if (JSON.stringify(sources.map(metadata)) !== JSON.stringify(refreshed.map(metadata))) throw changed();
  }
}

async function listAll(backend: PasswordProjectAttachmentBackend, account: ProviderAccount, itemId: string): Promise<ProviderAttachmentSummary[]> {
  const result: ProviderAttachmentSummary[] = [], seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await backend.listAttachments(account.id, itemId, cursor);
    if (!page || !Array.isArray(page.items) || result.length + page.items.length > 512) throw changed();
    for (const entry of page.items) {
      if (!entry || typeof entry.attachmentId !== 'string' || !entry.attachmentId || entry.attachmentId.length > 512 || seen.has(entry.attachmentId)
        || entry.providerKind !== account.kind || typeof entry.fileName !== 'string' || !entry.fileName || entry.fileName.length > 1024
        || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || entry.sizeBytes > 64 * 1024 * 1024
        || typeof entry.protected !== 'boolean' || entry.mediaType !== undefined && typeof entry.mediaType !== 'string') throw changed();
      seen.add(entry.attachmentId); result.push({ ...entry });
    }
    cursor = page.nextCursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || cursors.has(cursor) || cursors.size >= 512)) throw changed();
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return result.sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
}

async function operationUuid(parts: string[]): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
