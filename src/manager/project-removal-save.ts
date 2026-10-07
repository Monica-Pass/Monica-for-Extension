import type { PasswordProjectRemovalRequest, PasswordProjectRemovalStatus } from '../background/password-project-removal';
import type { KeePassProjectRemovalRequest, KeePassProjectRemovalStatus } from '../background/keepass-project-removal';

interface RemovalClient {
  removePasswordProjectMembers(input: PasswordProjectRemovalRequest, confirmed: true): Promise<PasswordProjectRemovalStatus>;
  listPasswordProjectRemovals(operationId?: string): Promise<PasswordProjectRemovalStatus[]>;
}

/** A lost response may hide a committed removal; an absent receipt proves nothing. */
export async function saveProjectRemoval(client: RemovalClient, request: PasswordProjectRemovalRequest): Promise<PasswordProjectRemovalStatus> {
  try { return await client.removePasswordProjectMembers(request, true); }
  catch (cause) {
    const rows = await client.listPasswordProjectRemovals(request.operationId).catch(() => undefined);
    const receipt = rows?.find(row => row.operationId === request.operationId);
    if (receipt && ['completed', 'cancelled'].includes(receipt.status)) return receipt;
    throw cause;
  }
}

interface KeePassRemovalClient {
  removeKeePassProjectMembers(input: KeePassProjectRemovalRequest, confirmed: true): Promise<KeePassProjectRemovalStatus>;
  listKeePassProjectRemovals(operationId?: string): Promise<KeePassProjectRemovalStatus[]>;
  resumeKeePassProjectRemoval(operationId: string): Promise<KeePassProjectRemovalStatus>;
}

/** Existing operations resume by ID, so an expired editor token cannot cause a
 * second operation after unlock/restart. A failed lookup is not proof of absence.
 */
export async function saveKeePassProjectRemoval(client: KeePassRemovalClient, request: KeePassProjectRemovalRequest): Promise<KeePassProjectRemovalStatus> {
  const previous = (await client.listKeePassProjectRemovals(request.operationId)).find(row => row.operationId === request.operationId);
  if (previous && ['completed', 'cancelled'].includes(previous.status)) return previous;
  try {
    return previous ? await client.resumeKeePassProjectRemoval(request.operationId) : await client.removeKeePassProjectMembers(request, true);
  } catch (cause) {
    const rows = await client.listKeePassProjectRemovals(request.operationId).catch(() => undefined);
    const receipt = rows?.find(row => row.operationId === request.operationId);
    if (receipt && ['completed', 'cancelled'].includes(receipt.status)) return receipt;
    throw cause;
  }
}
