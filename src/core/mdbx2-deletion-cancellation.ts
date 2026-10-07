import { readMdbx2RestoreBatchRequest, type Mdbx2RestoreBatchRequest } from './mdbx2-restore-batch-journal';

/** Terminal receipt saved atomically with undoing the local deletion; no remote write occurs. */
export interface Mdbx2DeletionCancellation {
  version: 1;
  request: Mdbx2RestoreBatchRequest;
  title: string;
  completedAt: string;
}

export function readMdbx2DeletionCancellations(value: unknown): Mdbx2DeletionCancellation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('MDBX 删除撤销记录无效。');
  const ids = new Set<string>();
  const result = value.map((row: Mdbx2DeletionCancellation) => {
    if (!row || row.version !== 1 || typeof row.title !== 'string' || typeof row.completedAt !== 'string'
      || row.completedAt.length > 128 || !Number.isFinite(Date.parse(row.completedAt))) throw new Error('MDBX 删除撤销记录无效。');
    const request = readMdbx2RestoreBatchRequest(row.request);
    if (ids.has(request.operationId)) throw new Error('MDBX 删除撤销操作标识重复。');
    ids.add(request.operationId);
    return { version: 1 as const, request, title: row.title, completedAt: row.completedAt };
  });
  return structuredClone(result);
}
