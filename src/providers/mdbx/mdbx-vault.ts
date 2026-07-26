import type { VaultItem } from "../../core/model";
import {
  bytesEqual,
  decryptMdbxField,
  deriveMdbxCredentialKey,
  mdbxVerifier,
  unwrapMdbxEpochKey,
  type MdbxCredential
} from "./mdbx-crypto";
import { decodeMdbxEntry, type MdbxEntryRow } from "./mdbx-entry-codec";
import { assessMdbxAccess, parseMdbxVaultMeta, type MdbxAccessAssessment, type MdbxVaultMeta } from "./mdbx-format";
import { listMdbxTables, mdbxColumnBytes, queryMdbxRow, queryMdbxRows, type MdbxSqliteDatabase } from "./mdbx-sqlite";

export interface MdbxUnsupportedEntry {
  entryId: string;
  entryType: string;
  reason: string;
}

export interface MdbxVaultSnapshot {
  meta: MdbxVaultMeta;
  access: MdbxAccessAssessment;
  items: VaultItem[];
  /** Rows kept verbatim because this build cannot model their `entry_type`. Never rewritten. */
  unsupported: MdbxUnsupportedEntry[];
  /** Raw payloads keyed by `entry_id`, so a later write can diff against what was actually stored. */
  payloads: Map<string, Record<string, unknown>>;
  warnings: string[];
}

/**
 * Android treats a vault with no salt/verifier/epoch key as unencrypted and skips verification
 * entirely (`MdbxVaultStore.kt:566-569`). We do the same rather than refusing to open it, because
 * such vaults exist — but the caller must surface that the data was never encrypted.
 */
export async function openMdbxVault(
  database: MdbxSqliteDatabase,
  credential: MdbxCredential,
  databaseId: number,
  providerId: string
): Promise<MdbxVaultSnapshot> {
  const tables = listMdbxTables(database);
  const meta = parseMdbxVaultMeta(readVaultMetaRow(database, tables));
  const access = assessMdbxAccess(meta, tables);
  if (!meta || access.level === "unsupported") throw new Error(access.reason || "无法打开此 MDBX 数据库。");

  const warnings: string[] = [];
  if (access.reason) warnings.push(access.reason);
  if (meta.unlockMethod !== credential.unlockMethod) {
    throw new Error(`此 MDBX 数据库的解锁方式是「${meta.unlockMethod}」，与所提供的凭据不符。`);
  }

  const epochKey = await unlockEpochKey(database, tables, meta, credential, warnings);
  const items: VaultItem[] = [];
  const unsupported: MdbxUnsupportedEntry[] = [];
  const payloads = new Map<string, Record<string, unknown>>();

  for (const row of queryMdbxRows(database, "SELECT * FROM entries")) {
    const entry = await readEntryRow(row, epochKey);
    payloads.set(entry.entryId, entry.payload);
    const decoded = decodeMdbxEntry(entry, providerId, databaseId);
    if (decoded.item) items.push(decoded.item);
    else unsupported.push({ entryId: entry.entryId, entryType: entry.entryType, reason: decoded.unsupportedReason || "" });
  }

  return { meta, access, items, unsupported, payloads, warnings };
}

/**
 * `vault_meta` and `key_epochs` are separate tables but both carry a `kdf_profile_id`-shaped column,
 * so they are merged with `vault_meta` winning — matching the fallback order Android uses.
 */
function readVaultMetaRow(database: MdbxSqliteDatabase, tables: string[]): Record<string, unknown> | undefined {
  const meta = queryMdbxRow(database, "SELECT * FROM vault_meta LIMIT 1");
  if (!meta) return undefined;
  if (!tables.includes("key_epochs")) return meta;
  const epoch = queryMdbxRow(database, "SELECT * FROM key_epochs WHERE status = 'active' LIMIT 1");
  return epoch ? { ...epoch, ...meta } : meta;
}

async function unlockEpochKey(
  database: MdbxSqliteDatabase,
  tables: string[],
  meta: MdbxVaultMeta,
  credential: MdbxCredential,
  warnings: string[]
): Promise<Uint8Array | undefined> {
  const metaRow = queryMdbxRow(database, "SELECT * FROM vault_meta LIMIT 1") || {};
  const salt = mdbxColumnBytes(metaRow.credential_salt);
  const verifier = mdbxColumnBytes(metaRow.credential_verifier);
  const wrapped = tables.includes("key_epochs")
    ? mdbxColumnBytes(queryMdbxRow(database, "SELECT wrapped_epoch_key_ct FROM key_epochs WHERE status = 'active' LIMIT 1")?.wrapped_epoch_key_ct)
    : undefined;

  if (!salt || !verifier || !wrapped) {
    warnings.push("此 MDBX 数据库没有凭据材料，内容以明文保存，Monica 无法为其提供加密保护。");
    return undefined;
  }

  const credentialKey = await deriveMdbxCredentialKey(credential, salt, meta.iterations);
  if (!bytesEqual(await mdbxVerifier(credentialKey, meta.vaultId), verifier)) throw new Error("MDBX 凭据不正确。");
  return unwrapMdbxEpochKey(credentialKey, wrapped);
}

/**
 * `payload_ct` holds JSON once decrypted. A row whose payload will not parse is kept with an empty
 * payload rather than dropped: the original bytes stay in the file and we simply do not model it.
 */
async function readEntryRow(row: Record<string, unknown>, epochKey: Uint8Array | undefined): Promise<MdbxEntryRow> {
  const payloadBytes = mdbxColumnBytes(row.payload_ct);
  const titleBytes = mdbxColumnBytes(row.title_ct);
  return {
    entryId: String(row.entry_id ?? ""),
    projectId: String(row.project_id ?? ""),
    entryType: String(row.entry_type ?? ""),
    title: titleBytes ? await decryptMdbxField(epochKey, titleBytes) : "",
    payload: payloadBytes ? parsePayload(await decryptMdbxField(epochKey, payloadBytes)) : {},
    deleted: Number(row.deleted ?? 0) !== 0,
    objectClock: Number(row.object_clock) || undefined,
    payloadSchemaVersion: Number(row.payload_schema_version) || undefined
  };
}

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
