import { expect, it } from 'vitest';
import { createLoginItem } from '../core/model';
import type { KeePassProjectRemovalIntent } from '../core/keepass-project-removal-journal';
import { describeKeePassProjectRemovalStatus } from './keepass-project-removal';

const intent = (status: KeePassProjectRemovalIntent['status']): KeePassProjectRemovalIntent => ({
  version: 1, operationId: 'keepass-remove-1', status, createdAt: '2026-11-06T00:00:00Z',
  source: { id: 'kp', kind: 'keepass', name: 'Synthetic', enabled: true, isDefaultSaveTarget: false, config: {} },
  draft: { providerId: 'kp', anchorItemId: 'anchor', originals: [createLoginItem({ title: 'Project' })],
    items: [], removedItemIds: ['anchor'] }
});

it.each([
  ['staged', 'preparing'],
  ['writing', 'deleting'],
  ['completed', 'completed'],
  ['cancelled', 'cancelled']
] as const)('derives the generic UI phase %s for journal status %s', (status, phase) => {
  const row = describeKeePassProjectRemovalStatus(intent(status));
  expect(row.phase).toBe(phase);
  expect(row.status).toBe(status);
  expect(row.canCancel).toBe(status === 'staged');
  expect(row.localAdoptionCompleted).toBe(status === 'completed');
});
