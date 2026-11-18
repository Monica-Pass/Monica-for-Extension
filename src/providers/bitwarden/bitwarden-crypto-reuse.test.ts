import { afterEach, expect, it, vi } from 'vitest';
import { decryptBitwardenString, encryptBitwardenString, reuseBitwardenCryptoKey } from './bitwarden-crypto';
afterEach(() => vi.restoreAllMocks());
const newKey = () => ({ encKey: new Uint8Array(32).fill(7), macKey: new Uint8Array(32).fill(9) });

it('reuses two non-exportable keys across a batch without changing ciphertext compatibility', async () => {
  const key = newKey(), ciphertext = await encryptBitwardenString('synthetic text', key);
  reuseBitwardenCryptoKey(key);
  const imports = vi.spyOn(crypto.subtle, 'importKey');
  for (let i = 0; i < 8; i++) await expect(decryptBitwardenString(ciphertext, key)).resolves.toBe('synthetic text');
  expect(imports).toHaveBeenCalledTimes(2);
  expect(imports.mock.calls.every(call => call[3] === false)).toBe(true);
});

it('mutating key bytes cannot reuse a stale imported key', async () => {
  const key = reuseBitwardenCryptoKey(newKey()), old = await encryptBitwardenString('old', key);
  await decryptBitwardenString(old, key);
  key.encKey.fill(11); key.macKey.fill(13);
  const changed = await encryptBitwardenString('new', key);
  await expect(decryptBitwardenString(changed, key)).resolves.toBe('new');
  await expect(decryptBitwardenString(old, key)).rejects.toThrow('MAC');
});

it('MAC failure still prevents AES decryption with a prepared key', async () => {
  const key = reuseBitwardenCryptoKey(newKey()), cipher = await encryptBitwardenString('synthetic text', key);
  const decrypt = vi.spyOn(crypto.subtle, 'decrypt');
  const parts = cipher.split('|'); parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  await expect(decryptBitwardenString(parts.join('|'), key)).rejects.toThrow('MAC'); expect(decrypt).not.toHaveBeenCalled();
});
