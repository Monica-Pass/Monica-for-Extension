import type { PasswordProjectRemovalRequest, PasswordProjectRemovalStatus } from '../background/password-project-removal';
import type { KeePassProjectRemovalRequest, KeePassProjectRemovalStatus } from '../background/keepass-project-removal';

interface RemovalClient {
  removePasswordProjectMembers(input: PasswordProjectRemovalRequest, confirmed: true): Promise<PasswordProjectRemovalStatus>;
  listPasswordProjectRemovals(operationId?: string): Promise<PasswordProjectRemovalStatus[]>;
}

const isTerminal = (status: string) => status === 'completed' || status === 'cancelled';

/** A lost response may hide a committed removal; an absent receipt proves nothing. */
async function settleAfterResponseLoss<T extends { operationId: string; status: string }>(
  operationId: string, submit: () => Promise<T>, lookupReceipts: () => Promise<T[]>): Promise<T> {
  try { return await submit(); }
  catch (cause) {
    const rows = await lookupReceipts().catch(() => undefined);
    const receipt = rows?.find(row => row.operationId === operationId);
    if (receipt && isTerminal(receipt.status)) return receipt;
    throw cause;
  }
}

export function saveProjectRemoval(client: RemovalClient, request: PasswordProjectRemovalRequest): Promise<PasswordProjectRemovalStatus> {
  return settleAfterResponseLoss(request.operationId,
    () => client.removePasswordProjectMembers(request, true),
    () => client.listPasswordProjectRemovals(request.operationId));
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
  if (previous && isTerminal(previous.status)) return previous;
  return settleAfterResponseLoss(request.operationId,
    () => previous ? client.resumeKeePassProjectRemoval(request.operationId) : client.removeKeePassProjectMembers(request, true),
    () => client.listKeePassProjectRemovals(request.operationId));
}
