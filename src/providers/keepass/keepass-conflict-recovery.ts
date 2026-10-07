import type { ProviderAccount } from '../../core/model';
import { base64ToBytes, randomBytes } from '../../security/encoding';
import type { KeePassProjectConflictChoice } from './keepass-remote-rebase';
import { KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG } from './keepass-receipt-crypto';
import { KEEPASS_REMOTE_MAX_DATABASE_BYTES } from './keepass-webdav-client';
import type { KeePassConflictRevision } from './keepass-conflict-review-token';

const parts = ['base', 'working', 'remote', 'resolved'] as const;
type Part = typeof parts[number];
interface EncryptedPart { iv: Uint8Array; ciphertext: Uint8Array }
export interface KeePassConflictRecoveryInput {
  operationId: string;
  createdAt: string;
  reviewToken: string;
  source: ProviderAccount;
  choices: KeePassProjectConflictChoice[];
  /** Required by the resolution transaction; absent only in standalone recovery capsules. */
  review?: KeePassConflictRevision;
  files: Record<Part, Uint8Array>;
}
export interface KeePassEncryptedConflictRecovery {
  version: 1;
  providerId: string;
  operationId: string;
  createdAt: string;
  reviewToken: string;
  intentTag: string;
  metadata: EncryptedPart;
  files: Record<Part, EncryptedPart>;
}

function invalid(): Error { return new Error('KeePass 冲突恢复副本无效。'); }
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const hash = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
function identity(value: { providerId: string; operationId: string; createdAt: string; reviewToken: string }) {
  if (![value.providerId, value.operationId].every(id => typeof id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(id))
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || !/^[a-f0-9]{64}$/.test(value.reviewToken)) throw invalid();
}
function validateChoices(choices: KeePassProjectConflictChoice[]) {
  if (!Array.isArray(choices) || !choices.length || choices.length > 1000 || new Set(choices.map(row => row?.projectId)).size !== choices.length
    || choices.some(row => !row || typeof row.projectId !== 'string' || row.projectId.length > 128 || !row.projectId || !['local', 'remote'].includes(row.choice))) throw invalid();
}
async function keys(account: ProviderAccount) {
  const raw = base64ToBytes(String(account.config[KEEPASS_CACHE_ENCRYPTION_KEY_CONFIG] || ''));
  try {
    if (raw.length !== 32) throw invalid();
    return { aes: await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']),
      hmac: await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']) };
  } finally { raw.fill(0); }
}
function aad(envelope: Omit<KeePassEncryptedConflictRecovery, 'metadata' | 'files'>, part: string) {
  return new TextEncoder().encode(JSON.stringify(['monica-keepass-conflict-recovery-v1', envelope.providerId,
    envelope.operationId, envelope.createdAt, envelope.reviewToken, envelope.intentTag, part]));
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, row) => row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
}

/** Four independent binary ciphertexts avoid base64-expanding large KDBX files.
 * Even passwordless KDBX inputs receive this device-cache encryption layer.
 */
export async function sealKeePassConflictRecovery(account: ProviderAccount, input: KeePassConflictRecoveryInput): Promise<KeePassEncryptedConflictRecovery> {
  const source = structuredClone(input.source), choices = structuredClone(input.choices);
  const outer = { version: 1 as const, providerId: account.id, operationId: input.operationId, createdAt: input.createdAt, reviewToken: input.reviewToken };
  identity(outer); validateChoices(choices);
  if (account.kind !== 'keepass' || source.kind !== 'keepass' || source.id !== account.id) throw invalid();
  const files = Object.fromEntries(parts.map(part => {
    const bytes = input.files[part];
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > KEEPASS_REMOTE_MAX_DATABASE_BYTES) throw invalid();
    return [part, bytes.slice()];
  })) as Record<Part, Uint8Array>;
  let plaintext: Uint8Array | undefined;
  try {
    const hashes = Object.fromEntries(await Promise.all(parts.map(async part => [part, await hash(files[part])])));
    const metadata = { source, choices, hashes, review: input.review && structuredClone(input.review) };
    plaintext = new TextEncoder().encode(canonical(metadata));
    if (plaintext.length > 1024 * 1024) throw invalid();
    const key = await keys(account);
    const intentTag = hex(await crypto.subtle.sign('HMAC', key.hmac, new TextEncoder().encode(canonical({ domain: 'conflict-recovery-intent-v1',
      providerId: account.id, operationId: input.operationId, reviewToken: input.reviewToken, metadata }))));
    const envelope = { ...outer, intentTag };
    const encrypt = async (bytes: Uint8Array, part: string): Promise<EncryptedPart> => {
      const iv = randomBytes(12);
      return { iv, ciphertext: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource,
        additionalData: aad(envelope, part) as BufferSource }, key.aes, bytes as BufferSource)) };
    };
    const encrypted: Partial<Record<Part, EncryptedPart>> = {};
    for (const part of parts) encrypted[part] = await encrypt(files[part], part);
    return { ...envelope, metadata: await encrypt(plaintext, 'metadata'), files: encrypted as Record<Part, EncryptedPart> };
  } finally { plaintext?.fill(0); for (const part of parts) files[part].fill(0); }
}

export function validateKeePassConflictRecovery(value: KeePassEncryptedConflictRecovery): KeePassEncryptedConflictRecovery {
  if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.intentTag)) throw invalid();
  identity(value);
  for (const [name, row] of [['metadata', value.metadata], ...parts.map(part => [part, value.files?.[part]])] as Array<[string, EncryptedPart]>) {
    if (!row || !(row.iv instanceof Uint8Array) || row.iv.length !== 12 || !(row.ciphertext instanceof Uint8Array)
      || row.ciphertext.length <= 16 || row.ciphertext.length > (name === 'metadata' ? 1024 * 1024 : KEEPASS_REMOTE_MAX_DATABASE_BYTES) + 16) throw invalid();
  }
  return structuredClone({ version: 1, providerId: value.providerId, operationId: value.operationId, createdAt: value.createdAt,
    reviewToken: value.reviewToken, intentTag: value.intentTag, metadata: value.metadata,
    files: Object.fromEntries(parts.map(part => [part, value.files[part]])) }) as KeePassEncryptedConflictRecovery;
}

export async function openKeePassConflictRecovery(account: ProviderAccount, input: KeePassEncryptedConflictRecovery): Promise<KeePassConflictRecoveryInput> {
  const envelope = validateKeePassConflictRecovery(input);
  if (account.id !== envelope.providerId || account.kind !== 'keepass') throw invalid();
  const key = await keys(account), files: Partial<Record<Part, Uint8Array>> = {};
  let metadataBytes: Uint8Array | undefined;
  const decrypt = async (value: EncryptedPart, part: string) => new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM',
    iv: value.iv as BufferSource, additionalData: aad(envelope, part) as BufferSource }, key.aes, value.ciphertext as BufferSource));
  try {
    metadataBytes = await decrypt(envelope.metadata, 'metadata');
    const metadata = JSON.parse(new TextDecoder().decode(metadataBytes)) as { source: ProviderAccount; choices: KeePassProjectConflictChoice[]; hashes: Record<Part, string>; review?: KeePassConflictRevision };
    if (!metadata.source || metadata.source.kind !== 'keepass' || metadata.source.id !== account.id) throw invalid();
    validateChoices(metadata.choices);
    const tag = hex(await crypto.subtle.sign('HMAC', key.hmac, new TextEncoder().encode(canonical({ domain: 'conflict-recovery-intent-v1',
      providerId: account.id, operationId: envelope.operationId, reviewToken: envelope.reviewToken, metadata }))));
    if (tag !== envelope.intentTag) throw invalid();
    for (const part of parts) {
      files[part] = await decrypt(envelope.files[part], part);
      if (await hash(files[part]!) !== metadata.hashes[part]) throw invalid();
    }
    return { operationId: envelope.operationId, createdAt: envelope.createdAt, reviewToken: envelope.reviewToken,
      source: metadata.source, choices: metadata.choices, ...(metadata.review ? { review: metadata.review } : {}), files: files as Record<Part, Uint8Array> };
  } catch { for (const bytes of Object.values(files)) bytes?.fill(0); throw invalid(); }
  finally { metadataBytes?.fill(0); }
}
