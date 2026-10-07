import { expect, it } from 'vitest';
import { vaultRowDomId } from './dom-id';
it('produces distinct CSS-safe DOM IDs for native, Unicode and adversarial item identifiers', () => {
  const inputs = ['mdbx2:a:b', 'mdbx2-a-b', 'a]#x', '用户🔑', ''];
  const ids = inputs.map(vaultRowDomId);
  for (const id of ids) expect(id).toMatch(/^vault-row-[0-9a-f]*$/);
  expect(new Set(ids).size).toBe(inputs.length);
});
