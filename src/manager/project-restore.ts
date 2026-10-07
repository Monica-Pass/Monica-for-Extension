import type { LoginItem, ProviderAccount, VaultItem } from '../core/model';
import { passwordGroupKey } from '../core/password-groups';
import type { Mdbx2RestoreBatchRequest } from '../core/mdbx2-restore-batch-journal';
import type { PasswordProjectRestoreStatus, PasswordProjectRestoreRequest } from '../background/password-project-restore';
import { keePassRestoreProject, readKeePassProjectRestoreRequest } from '../core/keepass-project-restore';

export function deletedPasswordCohort(anchor: VaultItem, items: VaultItem[], providers: ProviderAccount[]): LoginItem[] {
  const keepass = keePassRestoreProject(anchor, items, providers);
  if (keepass.length) return keepass.length <= 100 ? keepass.filter(row => row.deletedAt) : [];
  if (anchor.kind !== 'login' || !anchor.passwordGroupId || !anchor.deletedAt || anchor.providerRefs.length !== 1) return [];
  if (!providers.some(row => row.id === anchor.providerRefs[0].providerId && row.kind === 'mdbx2')) return [];
  return items.filter((item): item is LoginItem => item.kind === 'login' && item.deletedAt === anchor.deletedAt
    && passwordGroupKey(item) === passwordGroupKey(anchor)).sort((a, b) => a.id.localeCompare(b.id));
}

export function projectRestoreRequest(items: LoginItem[], anchorItemId: string): Mdbx2RestoreBatchRequest;
export function projectRestoreRequest(items: LoginItem[], anchorItemId: string, keepass: true, project: LoginItem[]): PasswordProjectRestoreRequest;
export function projectRestoreRequest(items: LoginItem[], anchorItemId: string, keepass?: true, project?: LoginItem[]): PasswordProjectRestoreRequest {
  if (keepass) return readKeePassProjectRestoreRequest({ backend: 'keepass', operationId: crypto.randomUUID(), anchorItemId,
    providerId: items[0].providerRefs[0].providerId, expected: Object.fromEntries(project!.map(item => [item.id, item.updatedAt])), restoreIds: items.map(item => item.id) });
  return { operationId: crypto.randomUUID(), anchorItemId, providerId: items[0].providerRefs[0].providerId, deletedAt: items[0].deletedAt!,
    expected: Object.fromEntries(items.map(item => [item.id, item.updatedAt])) };
}

interface RestoreClient {
  restorePasswordProject(input: PasswordProjectRestoreRequest, confirmed: true): Promise<PasswordProjectRestoreStatus>;
  listPasswordProjectRestores(operationId?: string): Promise<PasswordProjectRestoreStatus[]>;
}
/** A terminal receipt settles response loss. Missing status never authorizes a new request. */
export async function saveProjectRestore(client: RestoreClient, request: PasswordProjectRestoreRequest): Promise<PasswordProjectRestoreStatus> {
  try { return await client.restorePasswordProject(request, true); }
  catch (cause) {
    const receipts = await client.listPasswordProjectRestores(request.operationId).catch(() => undefined);
    const completed = receipts?.find(row => row.operationId === request.operationId && row.status === 'completed');
    if (completed) return completed;
    throw cause;
  }
}
