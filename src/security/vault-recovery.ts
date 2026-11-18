import type { VaultEnvelope } from './vault-crypto';
import type { StoredHead } from './vault-records';

export interface VaultRecoveryCopy { id: string; createdAt: string; envelope: VaultEnvelope }
export interface VaultRecoverySummary { id: string; createdAt: string; bytes: number }
export interface VaultStorageOverview { bytes: number; limit: number; copies: VaultRecoverySummary[] }
export const VAULT_STORAGE_LIMIT = 64 * 1024 * 1024;
const RECOVERY_INTERVAL = 15 * 60_000;
export function vaultCiphertextBytes(envelope: StoredHead): number {
  if (envelope.version === 2) return envelope.bytes;
  return Math.floor(envelope.ciphertext.length * 3 / 4) - (envelope.ciphertext.endsWith('==') ? 2 : envelope.ciphertext.endsWith('=') ? 1 : 0);
}
/** Three recent encrypted checkpoints, at most 64 MiB together. A new protection key invalidates all old checkpoints. */
export function nextRecoveryCopies(previous: VaultEnvelope | undefined, next: StoredHead, copies: VaultRecoveryCopy[], now = Date.now()): VaultRecoveryCopy[] {
  if (!previous || JSON.stringify(previous.kdf) !== JSON.stringify(next.kdf)) return [];
  const sameProtection = copies.filter(copy => JSON.stringify(copy.envelope.kdf) === JSON.stringify(next.kdf));
  if (previous.ciphertext === next.ciphertext) return sameProtection;
  const candidate = { id: crypto.randomUUID(), createdAt: new Date(now).toISOString(), envelope: previous };
  const rows = sameProtection.length && now - Date.parse(sameProtection[0].createdAt) < RECOVERY_INTERVAL ? sameProtection : [candidate, ...sameProtection];
  let bytes = 0;
  return rows.slice(0, 3).filter(copy => { bytes += vaultCiphertextBytes(copy.envelope); return bytes <= VAULT_STORAGE_LIMIT; });
}
export function recoveryOverview(envelope: StoredHead | null, copies: VaultRecoveryCopy[]): VaultStorageOverview {
  return { bytes: envelope ? vaultCiphertextBytes(envelope) : 0, limit: VAULT_STORAGE_LIMIT,
    copies: copies.map(({ id, createdAt, envelope }) => ({ id, createdAt, bytes: vaultCiphertextBytes(envelope) })) };
}
