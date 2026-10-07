import { expect, it, vi } from 'vitest';
import { PasswordProjectRestoreWorkflow } from './password-project-restore';
import { ProviderOperationQueue } from './provider-operation-queue';
import type { SecureVaultService } from '../security/secure-vault-service';
import type { Mdbx2RestoreBatchRecord, Mdbx2RestoreBatchRequest } from '../core/mdbx2-restore-batch-journal';
import type { Mdbx2DeletionCancellation } from '../core/mdbx2-deletion-cancellation';

const request: Mdbx2RestoreBatchRequest = { operationId: 'restore-operation', anchorItemId: 'one', providerId: 'native',
  deletedAt: '2026-10-01T00:00:00.000Z', expected: { one: '2026-10-01T00:00:00.000Z', two: '2026-10-01T00:00:00.000Z' } };
function fixture() {
  let records: Mdbx2RestoreBatchRecord[] = [];
  let cancellations:Mdbx2DeletionCancellation[]=[];
  const record = { version: 1, id: request.operationId, status: 'prepared', members: ['one', 'two'].map(id => ({
    source: { id, title: 'Synthetic project', password: 'never in summary' }, provider: { id: request.providerId, config: { password: 'never in summary' } },
  })) } as unknown as Mdbx2RestoreBatchRecord;
  const read = vi.fn(async () => structuredClone(records));
  const service = { readMdbx2RestoreBatches: read, readKeePassProjectRestores: async () => [], readMdbx2DeletionCancellations: async()=>structuredClone(cancellations) } as unknown as SecureVaultService;
  const restore = { restoreProject: vi.fn(async () => { records = [{ ...record, status: 'completed' }]; return []; }),
    resume: vi.fn(async () => { records = records.map(row => ({ ...row, status: 'completed' as const })); return []; }) };
  const queue = new ProviderOperationQueue(), changed = vi.fn(), workflow = new PasswordProjectRestoreWorkflow(service, restore, queue, changed);
  return { workflow, restore, queue, changed, read, stage: () => { records = [record]; }, cancel:()=>{records=[];cancellations=[{version:1,request,title:'Synthetic project',completedAt:request.deletedAt}];} };
}

it('exposes a completed local cancellation after a lost response without reporting it as unstaged',async()=>{
  const f=fixture(),cause=new Error('Response lost after atomic cancellation');
  f.restore.restoreProject.mockImplementation(async()=>{f.cancel();throw cause;});
  await expect(f.workflow.start(request)).rejects.toBe(cause);
  expect(await f.workflow.pending()).toEqual([]);
  expect(await f.workflow.pending(request.operationId)).toEqual([{operationId:request.operationId,providerId:request.providerId,title:'Synthetic project',memberIds:['one','two'],status:'completed'}]);
  expect((await f.workflow.resume(request.operationId)).status).toBe('completed');
});

it('passes a canonical fixed request and exposes only redacted terminal or pending summaries', async () => {
  const f = fixture();
  const result = await f.workflow.start(request);
  expect(f.restore.restoreProject).toHaveBeenCalledExactlyOnceWith(request.anchorItemId, request);
  expect(result).toEqual({ operationId: request.operationId, providerId: 'native', title: 'Synthetic project', memberIds: ['one', 'two'], status: 'completed' });
  expect(JSON.stringify(result)).not.toContain('never in summary');
  expect(await f.workflow.pending()).toEqual([]);
  expect(await f.workflow.pending(request.operationId)).toEqual([result]);
  f.stage(); expect((await f.workflow.pending())[0].status).toBe('prepared');
  expect((await f.workflow.resume(request.operationId)).status).toBe('completed');
  expect(f.changed).toHaveBeenCalledTimes(2);
});

it('describes the whole mixed cohort when only one member needs native restoration', async () => {
  const f = fixture();
  f.read.mockResolvedValue([{ version: 1, id: request.operationId, status: 'prepared',
    members: [{ source: { id: 'one', title: 'Mixed project' }, provider: { id: 'native' } }],
    cancellation: { sources: ['one','two','new'].map(id => ({ id, password: 'private secret' })), pendingDeletions: [] },
  } as unknown as Mdbx2RestoreBatchRecord]);
  expect(await f.workflow.pending()).toEqual([{operationId:request.operationId,providerId:'native',title:'Mixed project',
    memberIds:['one','two','new'],status:'prepared'}]);
});

it('waits for the same source queue before dispatching a restoration', async () => {
  const f = fixture(); let release!: () => void;
  const barrier = f.queue.run('native', () => new Promise<void>(resolve => { release = resolve; }));
  const result = f.workflow.start(request); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.restore.restoreProject).not.toHaveBeenCalled(); release(); await barrier; await result;
  expect(f.restore.restoreProject).toHaveBeenCalledOnce();
});

it.each(['absent', 'prepared', 'read-failed'] as const)('distinguishes safely rejected staging from unknown results: %s', async mode => {
  const f = fixture();
  if (mode === 'prepared') f.stage();
  if (mode === 'read-failed') f.read.mockRejectedValue(new Error('Read failed'));
  const cause = new Error('Native unavailable');
  f.restore.restoreProject.mockRejectedValue(cause);
  if (mode === 'absent') await expect(f.workflow.start(request)).rejects.toMatchObject({ code: 'password-project-restore-not-staged', message: 'Native unavailable' });
  else await expect(f.workflow.start(request)).rejects.toBe(cause);
});

it('rejects malformed membership and operation IDs before dispatch', async () => {
  const f = fixture();
  await expect(f.workflow.start({ ...request, expected: {} })).rejects.toThrow();
  await expect(f.workflow.start({ ...request, anchorItemId: 'other' })).rejects.toThrow();
  await expect(f.workflow.start({ ...request, deletedAt: 0 as unknown as string })).rejects.toThrow();
  await expect(f.workflow.start({ ...request, deletedAt: request.deletedAt + ' '.repeat(129) })).rejects.toThrow();
  await expect(f.workflow.start({ ...request, expected: { one: request.deletedAt + ' '.repeat(129) } })).rejects.toThrow();
  await expect(f.workflow.pending('')).rejects.toThrow(); await expect(f.workflow.resume('')).rejects.toThrow();
  expect(f.restore.restoreProject).not.toHaveBeenCalled(); expect(f.restore.resume).not.toHaveBeenCalled();
});
