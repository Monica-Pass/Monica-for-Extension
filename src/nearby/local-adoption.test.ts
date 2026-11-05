import { describe, expect, it } from 'vitest';
import { createEmptyVaultState, createLoginItem } from '../core/model';
import { captureNearbyLocalSnapshot, nearbyLocalSourceHash } from './local-adoption';

describe('nearby local adoption removal-journal contention', () => {
  // Pending-looking but structurally damaged: an empty retained snapshot fails
  // the journal reader, while the old raw status check saw "pending" yet no
  // overlapping item and silently allowed the adoption to continue.
  it('treats a damaged removal journal as invalid instead of silently adopting past it', async () => {
    const state = createEmptyVaultState();
    state.items = [createLoginItem({ title: 'Local project' })];
    state.passwordProjectRemovals = [{
      version: 1, id: 'damaged-operation', requestHash: '0'.repeat(64), createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z', status: 'preparing', retained: [], removed: [], providerBindings: []
    }];
    await expect(nearbyLocalSourceHash(state)).rejects.toThrow('密码项目移除恢复记录无效');
    await expect(captureNearbyLocalSnapshot(state)).rejects.toThrow('密码项目移除恢复记录无效');
  });
});
