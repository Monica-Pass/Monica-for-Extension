import type { ProviderSourceRecord } from "./model";
import { bytesToBase64 } from "../security/encoding";

/**
 * Source envelopes live inside the encrypted vault, whose ciphertext is capped at 64 MiB. Without a
 * budget a single oversized database could push the vault past that cap and make it undecryptable,
 * so an over-budget sync must fail loudly instead of writing a vault nobody can open again.
 */
export const MAX_SOURCE_RECORD_PAYLOAD_BYTES = 1024 * 1024;
export const MAX_SOURCE_RECORDS_TOTAL_BYTES = 32 * 1024 * 1024;

export interface SourceRecordInput {
  providerId: string;
  remoteId: string;
  itemId?: string;
  revision?: string;
  format: string;
  encoding: string;
  payload: Uint8Array | string;
}

/** Hashes the decoded bytes, so the same remote record fingerprints identically across encodings. */
export async function createSourceRecord(input: SourceRecordInput): Promise<ProviderSourceRecord> {
  const bytes = typeof input.payload === "string" ? new TextEncoder().encode(input.payload) : input.payload;
  return {
    providerId: input.providerId,
    ...(input.itemId ? { itemId: input.itemId } : {}),
    remoteId: input.remoteId,
    ...(input.revision ? { revision: input.revision } : {}),
    format: input.format,
    encoding: input.encoding,
    payload: typeof input.payload === "string" ? input.payload : bytesToBase64(input.payload),
    contentHash: bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)))
  };
}

/**
 * Change detection for all three providers. `contentHash` is authoritative because MDBX rows carry no
 * ETag and KDBX entries reuse their timestamps; `revision` alone would miss an edit that kept it.
 */
export function sourceRecordChanged(previous: ProviderSourceRecord | undefined, next: ProviderSourceRecord): boolean {
  if (!previous) return true;
  return previous.contentHash !== next.contentHash || previous.format !== next.format || previous.encoding !== next.encoding;
}

export function findSourceRecord(records: ProviderSourceRecord[], providerId: string, remoteId: string): ProviderSourceRecord | undefined {
  return records.find((record) => record.providerId === providerId && record.remoteId === remoteId);
}

/** Returns a user-facing Chinese message when the envelopes would not fit, otherwise `undefined`. */
export function sourceRecordsBudgetError(records: ProviderSourceRecord[]): string | undefined {
  let total = 0;
  for (const record of records) {
    const size = payloadByteLength(record);
    if (size > MAX_SOURCE_RECORD_PAYLOAD_BYTES) {
      return `来源记录「${record.remoteId}」为 ${formatMiB(size)}，超过单条 ${formatMiB(MAX_SOURCE_RECORD_PAYLOAD_BYTES)} 上限，已中止同步以免损坏本地库。`;
    }
    total += size;
    if (total > MAX_SOURCE_RECORDS_TOTAL_BYTES) {
      return `来源记录合计超过 ${formatMiB(MAX_SOURCE_RECORDS_TOTAL_BYTES)} 上限，已中止同步以免损坏本地库。`;
    }
  }
  return undefined;
}

function payloadByteLength(record: ProviderSourceRecord): number {
  if (record.encoding !== "base64") return record.payload.length;
  const padding = record.payload.endsWith("==") ? 2 : record.payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(record.payload.length * 3 / 4) - padding);
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
