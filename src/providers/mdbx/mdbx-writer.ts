import type { VaultItem } from "../../core/model";
import { encryptMdbxField } from "./mdbx-crypto";
import { encodeMdbxPayload } from "./mdbx-entry-codec";
import { queryMdbxRow, queryMdbxRows, type MdbxSqliteDatabase } from "./mdbx-sqlite";

export interface MdbxWriteContext {
  database: MdbxSqliteDatabase;
  epochKey?: Uint8Array;
  deviceId: string;
  now: string;
  /** Payload as it was decrypted on read, so unmodelled keys can be carried through. */
  originalPayload?: Record<string, unknown>;
  /** Item as it was decoded on read. Absent means this is a create. */
  previous?: VaultItem;
}

/**
 * Updates only the columns whose value actually changed. `INSERT OR REPLACE` is deliberately not used:
 * Android grows `entries` via `ensureColumn` (`MdbxVaultStore.kt:2869+`), so replacing the row would
 * blank out any column a newer build added that this one does not know about.
 */
export async function writeMdbxEntry(context: MdbxWriteContext, entryId: string, item: VaultItem): Promise<string> {
  const { database, epochKey, deviceId, now } = context;
  const commitId = await appendMdbxCommit(context, "entry", entryId);
  const payload = encodeMdbxPayload(item, context.originalPayload, context.previous);
  const titleChanged = !context.previous || context.previous.title !== item.title;
  const payloadChanged = JSON.stringify(payload) !== JSON.stringify(context.originalPayload ?? {});

  if (!context.previous) {
    await ensureMdbxProject(context, entryId, item.title, commitId);
    database.run(
      `INSERT INTO entries (entry_id, project_id, entry_type, title_ct, payload_ct, payload_schema_version,
        object_clock, head_commit_id, deleted, created_at, updated_at, created_by_device_id, updated_by_device_id)
       VALUES (?, ?, ?, ?, ?, 1, '1', ?, 0, ?, ?, ?, ?)`,
      [
        entryId,
        entryId,
        mdbxEntryTypeFor(item),
        await encryptMdbxField(epochKey, item.title),
        await encryptMdbxField(epochKey, JSON.stringify(payload)),
        commitId,
        now,
        now,
        deviceId,
        deviceId
      ]
    );
    upsertMdbxObjectIndex(context, "entry", entryId, entryId, item.title, commitId, mdbxEntryTypeFor(item));
    return commitId;
  }

  const assignments: string[] = [];
  const values: unknown[] = [];
  if (titleChanged) {
    assignments.push("title_ct = ?");
    values.push(await encryptMdbxField(epochKey, item.title));
  }
  if (payloadChanged) {
    assignments.push("payload_ct = ?");
    values.push(await encryptMdbxField(epochKey, JSON.stringify(payload)));
  }
  if (!assignments.length) return commitId;

  assignments.push("object_clock = object_clock + 1", "head_commit_id = ?", "updated_at = ?", "updated_by_device_id = ?");
  values.push(commitId, now, deviceId, entryId);
  database.run(`UPDATE entries SET ${assignments.join(", ")} WHERE entry_id = ?`, values);
  if (titleChanged) upsertMdbxObjectIndex(context, "entry", entryId, entryId, item.title, commitId, mdbxEntryTypeFor(item));
  return commitId;
}

/**
 * Deletion is a tombstone plus `deleted = 1`, never a `DELETE FROM entries`. Removing the row would
 * make the deletion invisible to another device, which would then resurrect the entry on merge.
 */
export async function deleteMdbxEntry(context: MdbxWriteContext, entryId: string): Promise<string> {
  const { database, deviceId, now } = context;
  const commitId = await appendMdbxCommit(context, "entry", entryId);
  const projectId = String(queryMdbxRow(database, "SELECT project_id FROM entries WHERE entry_id = ?", [entryId])?.project_id ?? entryId);

  database.run(
    "UPDATE entries SET deleted = 1, object_clock = object_clock + 1, head_commit_id = ?, updated_at = ?, updated_by_device_id = ? WHERE entry_id = ?",
    [commitId, now, deviceId, entryId]
  );
  database.run("UPDATE object_index SET deleted = 1, updated_at = ?, head_commit_id = ? WHERE object_id = ?", [now, commitId, entryId]);
  database.run(
    "UPDATE projects SET deleted = 1, object_clock = object_clock + 1, head_commit_id = ?, updated_at = ?, updated_by_device_id = ? WHERE project_id = ?",
    [commitId, now, deviceId, projectId]
  );
  insertMdbxTombstone(context, "entry", entryId);
  insertMdbxTombstone(context, "project", projectId);
  return commitId;
}

/** Appends a DAG node and moves this device's head, mirroring `MdbxVaultStore.kt:3065-3119`. */
export async function appendMdbxCommit(context: MdbxWriteContext, scope: string, objectId: string): Promise<string> {
  const { database, epochKey, deviceId, now } = context;
  ensureMdbxDevice(context);
  const seq = Number(queryMdbxRow(database, "SELECT COALESCE(MAX(local_seq), 0) + 1 AS seq FROM commits WHERE device_id = ?", [deviceId])?.seq ?? 1);
  const parent = queryMdbxRow(database, "SELECT head_commit_id FROM device_heads WHERE device_id = ?", [deviceId])?.head_commit_id;
  const commitId = crypto.randomUUID();

  database.run(
    `INSERT INTO commits (commit_id, device_id, local_seq, commit_kind, change_scope, changed_object_ids_ct, vector_clock, created_at, integrity_tag)
     VALUES (?, ?, ?, 'local', ?, ?, ?, ?, ?)`,
    [
      commitId,
      deviceId,
      seq,
      scope,
      await encryptMdbxField(epochKey, JSON.stringify([objectId])),
      JSON.stringify({ [deviceId]: seq }),
      now,
      new TextEncoder().encode(crypto.randomUUID())
    ]
  );
  if (parent) database.run("INSERT OR IGNORE INTO commit_parents (commit_id, parent_commit_id) VALUES (?, ?)", [commitId, String(parent)]);
  database.run("INSERT OR REPLACE INTO device_heads (device_id, head_commit_id, last_seen_at, revoked) VALUES (?, ?, ?, 0)", [deviceId, commitId, now]);
  database.run("UPDATE branches SET head_commit_id = ?, updated_at = ? WHERE branch_id = 'main'", [commitId, now]);
  return commitId;
}

/** `commits.changed_object_ids_ct` is a BLOB, so a fresh device row must exist before any commit. */
function ensureMdbxDevice(context: MdbxWriteContext): void {
  const { database, deviceId, now } = context;
  if (queryMdbxRows(database, "SELECT device_id FROM devices WHERE device_id = ?", [deviceId]).length) {
    database.run("UPDATE devices SET last_seen_at = ? WHERE device_id = ?", [now, deviceId]);
    return;
  }
  database.run(
    "INSERT INTO devices (device_id, device_name, client_label, created_at, last_seen_at) VALUES (?, 'Monica 浏览器扩展', 'monica-extension', ?, ?)",
    [deviceId, now, now]
  );
}

async function ensureMdbxProject(context: MdbxWriteContext, projectId: string, title: string, commitId: string): Promise<void> {
  const { database, deviceId, now, epochKey } = context;
  if (queryMdbxRows(database, "SELECT project_id FROM projects WHERE project_id = ?", [projectId]).length) return;
  database.run(
    `INSERT INTO projects (project_id, title_ct, object_clock, head_commit_id, created_at, updated_at, created_by_device_id, updated_by_device_id)
     VALUES (?, ?, '1', ?, ?, ?, ?, ?)`,
    [projectId, await encryptMdbxField(epochKey, title), commitId, now, now, deviceId, deviceId]
  );
  upsertMdbxObjectIndex(context, "project", projectId, null, title, commitId, null);
}

function upsertMdbxObjectIndex(
  context: MdbxWriteContext,
  objectType: string,
  objectId: string,
  parentId: string | null,
  title: string,
  commitId: string,
  entryType: string | null
): void {
  context.database.run(
    `INSERT OR REPLACE INTO object_index (object_type, object_id, parent_id, title_key, entry_type, head_commit_id, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [objectType, objectId, parentId, title.toLowerCase(), entryType, commitId, context.now]
  );
}

function insertMdbxTombstone(context: MdbxWriteContext, objectType: string, objectId: string): void {
  context.database.run(
    "INSERT OR REPLACE INTO tombstones (tombstone_id, target_object_type, target_object_id, delete_clock, deleted_by_device_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?)",
    [`tombstone:${objectType}:${objectId}`, objectType, objectId, context.now, context.deviceId, context.now]
  );
}

/** `MdbxVaultStore.kt:2086-2095`. A password entry is stored as `password`, not `login`. */
export function mdbxEntryTypeFor(item: VaultItem): string {
  if (item.kind === "secure-note") return "note";
  if (item.kind === "totp") return "totp";
  if (item.kind === "passkey") return "passkey";
  return "password";
}
