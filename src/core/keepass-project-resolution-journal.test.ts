import { expect, it } from 'vitest';
import { readKeePassProjectResolutionIntents } from './keepass-project-resolution-journal';

const valid = () => ({ version: 1, status: 'writing', createdAt: '2026-10-06T00:00:00Z',
  source: { id: 'kp', kind: 'keepass', config: { sourceMode: 'webdav' } },
  request: { operationId: 'resolve-1', reviewToken: 'a'.repeat(64), choices: [{ projectId: 'project', choice: 'remote' }] },
  originals: [{ id: 'entry', providerRefs: [{ providerId: 'kp', remoteId: 'native' }] }] });

it.each([
  (row: any) => { row.source.config = null; },
  (row: any) => { row.source.config.sourceMode = 'local-file'; },
  (row: any) => { row.request.operationId = 123; },
  (row: any) => { row.request.reviewToken = { toString: () => 'a'.repeat(64) }; },
  (row: any) => { row.request.choices[0].projectId = 123; },
  (row: any) => { row.request.choices = Array.from({ length: 1001 }, (_, n) => ({ projectId: String(n), choice: 'remote' })); },
  (row: any) => { row.originals[0].providerRefs = {}; },
  (row: any) => { row.originals[0].providerRefs = [null]; },
  (row: any) => { row.originals[0].id = {}; },
  (row: any) => { row.request.choices.push(row.request.choices[0]); }
])('rejects malformed encrypted journal before source or snapshot processing', mutate => {
  const row = valid(); mutate(row);
  expect(() => readKeePassProjectResolutionIntents([row])).toThrow('冲突解决记录无效');
});

it('returns an independent validated snapshot and allows no original members', () => {
  const row = valid();
  const copy = readKeePassProjectResolutionIntents([row]);
  copy[0].request.choices[0].choice = 'local';
  expect(row.request.choices[0].choice).toBe('remote');
  expect(readKeePassProjectResolutionIntents([{ ...row, originals: [] }])).toHaveLength(1);
});
