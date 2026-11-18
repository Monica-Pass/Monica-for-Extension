import { base64ToBytes, bytesToBase64, randomBytes } from './encoding';
import { validateKdfParameters, type VaultEnvelope, type VaultKdfParameters } from './vault-crypto';
import { VAULT_STORAGE_LIMIT } from './vault-recovery';

export interface RecordHead extends Omit<VaultEnvelope, 'version'> { version: 2; vaultId: string; bytes: number }
export type StoredHead = VaultEnvelope | RecordHead;
interface Box { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }
type Block = Box | { parts: Box[] };
export type Blocks = Map<string, Block>;
type Reader = (ids: string[]) => Promise<Blocks>;
interface Leaf { id: string; size: number; value: unknown }
interface Field { name: string; array: boolean; leaves: Leaf[]; pages: string[] }
export interface RecordIndex { head: RecordHead; fields: Field[] }
export interface RecordWrite extends RecordIndex { puts: Blocks; removes: string[] }
const text = new TextEncoder(), decode = new TextDecoder('utf-8', { fatal: true });
const pageSize = 64, idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(): never { throw new Error('Encrypted vault records are incomplete or invalid'); }
export class VaultRecordIntegrityError extends Error {
  constructor() { super('密码库记录校验失败，原数据已保留。请使用独立加密备份在新配置中恢复。'); }
}
function headerAAD(h: RecordHead) { return JSON.stringify(['head', h.vaultId, h.kdf, h.updatedAt, h.bytes]); }
function aad(label: string) { return text.encode('monica-record-v2:' + label); }
async function seal(key: CryptoKey, label: string, bytes: Uint8Array<ArrayBuffer>): Promise<Box> {
  const iv = randomBytes(12) as Uint8Array<ArrayBuffer>;
  try { return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(label) }, key, bytes) }; }
  finally { bytes.fill(0); }
}
async function open(key: CryptoKey, label: string, box?: Box): Promise<unknown> {
  if (!box || box.iv?.byteLength !== 12 || !(box.data instanceof ArrayBuffer) || box.data.byteLength < 16 || box.data.byteLength > VAULT_STORAGE_LIMIT) invalid();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv, additionalData: aad(label) }, key, box.data);
  try { return JSON.parse(decode.decode(plain)); } finally { new Uint8Array(plain).fill(0); }
}
function sameValue(old: Leaf | undefined, value: unknown, json: string) {
  return old && (old.value === value || JSON.stringify(old.value) === json);
}
const chunkSize = 256 * 1024;
async function sealRow(key: CryptoKey, label: string, bytes: Uint8Array<ArrayBuffer>): Promise<Block> {
  if (bytes.length <= chunkSize) return seal(key, label, bytes);
  const parts: Box[] = [], count = Math.ceil(bytes.length / chunkSize);
  try {
    for (let i = 0; i < count; i++) parts.push(await seal(key, label + ':' + count + ':' + i, bytes.subarray(i*chunkSize,(i+1)*chunkSize)));
    return { parts };
  } finally { bytes.fill(0); }
}
async function openRow(key: CryptoKey, label: string, block: Block, budget: number): Promise<{value:unknown; size:number}> {
  if (!('parts' in block)) {
    const size = block.data.byteLength - 16;
    if (size < 1 || size > Math.min(chunkSize,budget)) invalid();
    return { size, value: await open(key,label,block) };
  }
  const parts = block.parts;
  if (!Array.isArray(parts) || parts.length < 2 || parts.length > Math.ceil(VAULT_STORAGE_LIMIT/chunkSize)) invalid();
  let size = 0;
  for (const [i,p] of parts.entries()) {
    const n = p.data.byteLength - 16;
    if (p.iv.byteLength !== 12 || n < 1 || n > chunkSize || (i < parts.length-1 && n !== chunkSize) || (size += n) > budget) invalid();
  }
  const bytes = new Uint8Array(size);
  try {
    for (const [i,p] of parts.entries()) {
      const data = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:p.iv,additionalData:aad(label+':'+parts.length+':'+i)},key,p.data));
      try { bytes.set(data,i*chunkSize); } finally { data.fill(0); }
    }
    return {size,value:JSON.parse(decode.decode(bytes))};
  } finally { bytes.fill(0); }
}
function identity(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (typeof row.id === 'string') return row.id;
  if (typeof row.remoteId === 'string') return JSON.stringify([row.providerId, row.remoteId]);
}
function byteCount(fields: Field[]) {
  return 2 + Math.max(0, fields.length - 1) + fields.reduce((n, f) => n + text.encode(JSON.stringify(f.name)).length + 1
    + (f.array ? 2 + Math.max(0, f.leaves.length - 1) : 0) + f.leaves.reduce((sum, l) => sum + l.size, 0), 0);
}
export async function prepareRecords(payload: object, key: CryptoKey, kdf: VaultKdfParameters, updatedAt: string, prior?: RecordIndex, unchangedView?: Record<string,unknown>): Promise<RecordWrite> {
  const vaultId = prior?.head.vaultId ?? crypto.randomUUID(), puts: Blocks = new Map(), fields: Field[] = [];
  const retired = new Set<string>();
  function retire(f: Field) { for (const l of f.leaves) retired.add(l.id); for (const id of f.pages) retired.add(id); }
  for (const f of prior?.fields || []) if (!Object.prototype.hasOwnProperty.call(payload, f.name) || Reflect.get(payload, f.name) === undefined) retire(f);
  for (const [name, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    const array = Array.isArray(value), values: unknown[] = array ? value : [value];
    const old = prior?.fields.find(f => f.name === name && f.array === array);
    if (!old) { const replaced = prior?.fields.find(f => f.name === name); if (replaced) retire(replaced); }
    const before = unchangedView?.[name];
    if (old && unchangedView && value === before) { fields.push(old); continue; }
    if (old) retire(old);
    let lookup: Map<string | undefined, Leaf> | undefined;
    const leaves: Leaf[] = [], pages: string[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i] ?? null;
      let prev = old?.leaves[i];
      if (prev && prev.value !== v && identity(prev.value) !== identity(v) && identity(v) !== undefined) {
        lookup ??= new Map(old!.leaves.map(l => [identity(l.value), l]));
        prev = lookup.get(identity(v));
      }
      let json: string | undefined;
      if (prev && retired.has(prev.id) && ((name === 'items' && Array.isArray(before) && before.length === old?.leaves.length && before[i] === v && prev === old.leaves[i])
        || prev.value === v || sameValue(prev, v, json = JSON.stringify(v)))) {
        leaves.push(prev); retired.delete(prev.id); continue;
      }
      json ??= JSON.stringify(v);
      const bytes = text.encode(json), id = crypto.randomUUID(), size = bytes.length;
      if (size + 16 > VAULT_STORAGE_LIMIT) throw new Error('Vault exceeds 64 MiB storage limit');
      puts.set(id, await sealRow(key, vaultId + ':row:' + id, bytes));
      // Never retain caller-owned mutable records in the authenticated index.
      leaves.push({ id, size, value: JSON.parse(json) });
    }
    for (let i = 0; i < leaves.length; i += pageSize) {
      const group = leaves.slice(i, i + pageSize), p = Math.floor(i / pageSize);
      if (old?.pages[p] && group.length === Math.min(pageSize, old.leaves.length - i) && group.every((l,j) => old.leaves[i+j] === l)) {
        pages.push(old.pages[p]); retired.delete(old.pages[p]); continue;
      }
      const id = crypto.randomUUID(); pages.push(id);
      puts.set(id, await seal(key, vaultId + ':page:' + id, text.encode(JSON.stringify(group.map(l => l.id)))));
    }
    fields.push({ name, array, leaves, pages });
  }
  const bytes = byteCount(fields) + 16;
  if (bytes > VAULT_STORAGE_LIMIT) throw new Error('Vault exceeds 64 MiB storage limit');
  const head: RecordHead = { version: 2, vaultId, cipher: 'AES-256-GCM', kdf, updatedAt, bytes, iv:'', ciphertext:'' };
  const box = await seal(key, headerAAD(head), text.encode(JSON.stringify(fields.map(f => [f.name, f.array, f.pages]))));
  head.iv = bytesToBase64(box.iv); head.ciphertext = bytesToBase64(new Uint8Array(box.data));
  return { head, fields, puts, removes: [...retired] };
}
export function indexPayload(index: RecordIndex): Record<string, unknown> {
  return Object.fromEntries(index.fields.map(f => [f.name, f.array ? f.leaves.map(l => l.value) : f.leaves[0].value]));
}
export async function readRecords(head: RecordHead, key: CryptoKey, read: Reader): Promise<RecordIndex> {
  validateKdfParameters(head.kdf);
  if (head.version !== 2 || head.cipher !== 'AES-256-GCM' || !idPattern.test(head.vaultId) || !Number.isSafeInteger(head.bytes)
    || head.bytes < 18 || head.bytes > VAULT_STORAGE_LIMIT || head.iv.length !== 16 || head.ciphertext.length > VAULT_STORAGE_LIMIT * 2) invalid();
  const data = new Uint8Array(base64ToBytes(head.ciphertext));
  const dirs = await open(key, headerAAD(head), { iv: new Uint8Array(base64ToBytes(head.iv)), data: data.buffer });
  // A valid head proves the key before distinguishing unavailable or damaged rows.
  try { return await readDirectory(head, key, read, dirs); }
  catch { throw new VaultRecordIntegrityError(); }
}
async function readDirectory(head: RecordHead, key: CryptoKey, read: Reader, dirs: unknown): Promise<RecordIndex> {
  if (!Array.isArray(dirs)) invalid();
  const seen = new Set<string>(), names = new Set<string>();
  function checkIds(value: unknown): string[] {
    if (!Array.isArray(value)) invalid();
    for (const id of value) { if (typeof id !== 'string' || !idPattern.test(id) || seen.has(id)) invalid(); seen.add(id); }
    return value;
  }
  const fields: Field[] = dirs.map(dir => {
    if (!Array.isArray(dir) || dir.length !== 3 || typeof dir[0] !== 'string' || names.has(dir[0]) || typeof dir[1] !== 'boolean') invalid();
    names.add(dir[0]); return { name: dir[0], array: dir[1], pages: checkIds(dir[2]), leaves: [] };
  });
  let total = 0;
  for (const f of fields) {
    if (!f.pages.length) { if (!f.array) invalid(); continue; }
    const pages = await read(f.pages);
    for (let p = 0; p < f.pages.length; p++) {
      const id = f.pages[p], page = pages.get(id);
      if (!page || 'parts' in page || page.data.byteLength > pageSize*40+32) invalid();
      const ids = checkIds(await open(key, head.vaultId + ':page:' + id, page));
      if (!ids.length || ids.length > pageSize || (p < f.pages.length - 1 && ids.length !== pageSize)) invalid();
      const boxes = await read(ids);
      const rows = await Promise.all(ids.map(async rowId => {
        const box = boxes.get(rowId);
        if (!box) invalid();
        const size = 'parts' in box ? box.parts.reduce((n,p)=>n+p.data.byteLength-16,0) : box.data.byteLength-16;
        if (size < 1 || (total += size) > head.bytes) invalid();
        return { id: rowId, ...await openRow(key, head.vaultId + ':row:' + rowId, box, size) };
      }));
      f.leaves.push(...rows);
    }
    if (!f.array && f.leaves.length !== 1) invalid();
  }
  if (byteCount(fields) + 16 !== head.bytes) invalid();
  return { head, fields };
}
