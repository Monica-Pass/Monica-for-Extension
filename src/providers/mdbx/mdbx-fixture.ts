import { randomBytes } from "../../security/encoding";
import {
  deriveMdbxCredentialKey,
  encryptMdbxField,
  mdbxIterationsFrom,
  mdbxVerifier,
  wrapMdbxEpochKey,
  type MdbxCredential
} from "./mdbx-crypto";
import type { MdbxSqliteDatabase, MdbxSqliteEngine } from "./mdbx-sqlite";

/**
 * Builds a `.mdbx` file byte-compatible with `MdbxVaultStore.kt:2844-2868`. Android ships no binary
 * fixture and must not be modified to produce one, so the schema is reproduced here and the tests
 * exercise the real reader against a real SQLite file rather than a hand-written row shape.
 */
export const MDBX_FIXTURE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS vault_meta (vault_id TEXT PRIMARY KEY NOT NULL, format_name TEXT NOT NULL DEFAULT 'Monica Database eXtended', format_version TEXT NOT NULL DEFAULT 'MDBX-1', release_label TEXT NOT NULL DEFAULT 'MDBX-test-compatible', capability_flags TEXT NOT NULL DEFAULT 'legacy-test-compatible', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, default_tiga_mode TEXT NOT NULL DEFAULT 'multi', unlock_methods TEXT NOT NULL DEFAULT 'password', active_key_epoch_id TEXT NOT NULL, compat_flags TEXT NOT NULL DEFAULT '', critical_extensions TEXT NOT NULL DEFAULT '', credential_salt BLOB, credential_verifier BLOB, credential_kdf_profile TEXT, key_file_name TEXT, key_file_fingerprint TEXT)",
  "CREATE TABLE IF NOT EXISTS devices (device_id TEXT PRIMARY KEY NOT NULL, device_name TEXT NOT NULL, client_label TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS folders (folder_id TEXT PRIMARY KEY NOT NULL, parent_folder_id TEXT, name_ct BLOB NOT NULL, path_key TEXT NOT NULL, object_clock TEXT NOT NULL, head_commit_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_device_id TEXT NOT NULL, updated_by_device_id TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS projects (project_id TEXT PRIMARY KEY NOT NULL, title_ct BLOB NOT NULL, summary_ct BLOB, group_id TEXT, icon_ref TEXT, favorite INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, tiga_mode_override TEXT, object_clock TEXT NOT NULL, head_commit_id TEXT NOT NULL, attachment_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_device_id TEXT NOT NULL, updated_by_device_id TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS entries (entry_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, entry_type TEXT NOT NULL, title_ct BLOB, payload_ct BLOB NOT NULL, payload_schema_version INTEGER NOT NULL DEFAULT 1, tiga_mode_override TEXT, object_clock TEXT NOT NULL, head_commit_id TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by_device_id TEXT NOT NULL, updated_by_device_id TEXT NOT NULL, FOREIGN KEY (project_id) REFERENCES projects(project_id))",
  "CREATE TABLE IF NOT EXISTS object_index (object_type TEXT NOT NULL, object_id TEXT NOT NULL, parent_id TEXT, title_key TEXT NOT NULL, entry_type TEXT, head_commit_id TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (object_type, object_id))",
  "CREATE TABLE IF NOT EXISTS commits (commit_id TEXT PRIMARY KEY NOT NULL, device_id TEXT NOT NULL, local_seq INTEGER NOT NULL, commit_kind TEXT NOT NULL, change_scope TEXT NOT NULL, changed_object_ids_ct BLOB NOT NULL, vector_clock TEXT NOT NULL, message_ct BLOB, created_at TEXT NOT NULL, integrity_tag BLOB NOT NULL)",
  "CREATE TABLE IF NOT EXISTS commit_parents (commit_id TEXT NOT NULL, parent_commit_id TEXT NOT NULL, PRIMARY KEY (commit_id, parent_commit_id))",
  "CREATE TABLE IF NOT EXISTS device_heads (device_id TEXT PRIMARY KEY NOT NULL, head_commit_id TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS branches (branch_id TEXT PRIMARY KEY NOT NULL, branch_name TEXT NOT NULL, head_commit_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS tombstones (tombstone_id TEXT PRIMARY KEY NOT NULL, target_object_type TEXT NOT NULL, target_object_id TEXT NOT NULL, delete_clock TEXT NOT NULL, deleted_by_device_id TEXT NOT NULL, deleted_at TEXT NOT NULL, purge_eligible_at TEXT)",
  "CREATE TABLE IF NOT EXISTS conflicts (conflict_id TEXT PRIMARY KEY NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL, base_commit_id TEXT NOT NULL, local_commit_id TEXT NOT NULL, incoming_commit_id TEXT NOT NULL, conflicting_fields TEXT NOT NULL, resolution TEXT NOT NULL DEFAULT 'unresolved', created_at TEXT NOT NULL, resolved_at TEXT)",
  "CREATE TABLE IF NOT EXISTS key_epochs (key_epoch_id TEXT PRIMARY KEY NOT NULL, status TEXT NOT NULL, wrapped_epoch_key_ct BLOB NOT NULL, kdf_profile_id TEXT NOT NULL, created_at TEXT NOT NULL, activated_at TEXT, retired_at TEXT)"
];

export interface MdbxFixtureEntry {
  entryId: string;
  entryType: string;
  title: string;
  payload: Record<string, unknown>;
  deleted?: boolean;
}

export interface MdbxFixtureOptions {
  credential: MdbxCredential;
  vaultId?: string;
  kdfProfile?: string;
  formatVersion?: string;
  criticalExtensions?: string;
  compatFlags?: string;
  /** Omit the credential material entirely, reproducing an Android vault that stores plaintext. */
  unencrypted?: boolean;
  omitTables?: string[];
  entries?: MdbxFixtureEntry[];
}

export async function buildMdbxFixture(engine: MdbxSqliteEngine, options: MdbxFixtureOptions): Promise<Uint8Array> {
  const database = engine.open();
  try {
    await populateMdbxFixture(database, options);
    return database.export();
  } finally {
    database.close();
  }
}

async function populateMdbxFixture(database: MdbxSqliteDatabase, options: MdbxFixtureOptions): Promise<void> {
  const omit = new Set(options.omitTables || []);
  for (const statement of MDBX_FIXTURE_SCHEMA) {
    const table = statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1] || "";
    if (!omit.has(table)) database.run(statement);
  }

  const now = "2026-07-26T00:00:00.000Z";
  const vaultId = options.vaultId || "vault-fixture";
  const kdfProfile = options.kdfProfile || "pbkdf2-sha256:50000";
  const epochKey = options.unencrypted ? undefined : randomBytes(32);

  if (epochKey && !omit.has("key_epochs")) {
    const salt = randomBytes(32);
    const credentialKey = await deriveMdbxCredentialKey(options.credential, salt, mdbxIterationsFrom(kdfProfile));
    database.run(
      "INSERT INTO key_epochs (key_epoch_id, status, wrapped_epoch_key_ct, kdf_profile_id, created_at, activated_at) VALUES (?, 'active', ?, ?, ?, ?)",
      ["epoch-1", await wrapMdbxEpochKey(credentialKey, epochKey), kdfProfile, now, now]
    );
    insertVaultMeta(database, {
      vaultId, now, kdfProfile, options,
      salt,
      verifier: await mdbxVerifier(credentialKey, vaultId)
    });
  } else {
    insertVaultMeta(database, { vaultId, now, kdfProfile, options });
  }

  if (!omit.has("projects")) {
    database.run(
      "INSERT INTO projects (project_id, title_ct, group_id, object_clock, head_commit_id, created_at, updated_at, created_by_device_id, updated_by_device_id) VALUES ('project-1', ?, NULL, '1', 'commit-1', ?, ?, 'device-1', 'device-1')",
      [await encryptMdbxField(epochKey, "默认项目"), now, now]
    );
  }
  if (!omit.has("folders")) {
    database.run(
      "INSERT INTO folders (folder_id, parent_folder_id, name_ct, path_key, object_clock, head_commit_id, created_at, updated_at, created_by_device_id, updated_by_device_id) VALUES ('root', NULL, ?, '/', '1', 'commit-1', ?, ?, 'device-1', 'device-1')",
      [await encryptMdbxField(epochKey, "Root"), now, now]
    );
  }
  if (!omit.has("devices")) {
    database.run(
      "INSERT INTO devices (device_id, device_name, client_label, created_at, last_seen_at) VALUES ('device-1', 'Android', 'monica-android', ?, ?)",
      [now, now]
    );
  }
  if (!omit.has("device_heads")) {
    database.run("INSERT INTO device_heads (device_id, head_commit_id, last_seen_at) VALUES ('device-1', 'commit-1', ?)", [now]);
  }
  if (!omit.has("branches")) {
    database.run("INSERT INTO branches (branch_id, branch_name, head_commit_id, created_at, updated_at) VALUES ('main', 'main', 'commit-1', ?, ?)", [now, now]);
  }

  for (const entry of options.entries || []) {
    database.run(
      "INSERT INTO entries (entry_id, project_id, entry_type, title_ct, payload_ct, payload_schema_version, object_clock, head_commit_id, deleted, created_at, updated_at, created_by_device_id, updated_by_device_id) VALUES (?, 'project-1', ?, ?, ?, 1, '1', 'commit-1', ?, ?, ?, 'device-1', 'device-1')",
      [
        entry.entryId,
        entry.entryType,
        await encryptMdbxField(epochKey, entry.title),
        await encryptMdbxField(epochKey, JSON.stringify(entry.payload)),
        entry.deleted ? 1 : 0,
        now,
        now
      ]
    );
  }
}

function insertVaultMeta(
  database: MdbxSqliteDatabase,
  context: { vaultId: string; now: string; kdfProfile: string; options: MdbxFixtureOptions; salt?: Uint8Array; verifier?: Uint8Array }
): void {
  const { vaultId, now, kdfProfile, options, salt, verifier } = context;
  database.run(
    `INSERT INTO vault_meta (
      vault_id, format_name, format_version, release_label, capability_flags, created_at, updated_at,
      default_tiga_mode, unlock_methods, active_key_epoch_id, compat_flags, critical_extensions,
      credential_salt, credential_verifier, credential_kdf_profile
    ) VALUES (?, 'Monica Database eXtended', ?, 'MDBX-1.0', 'android-official-1.0', ?, ?, 'multi', ?, 'epoch-1', ?, ?, ?, ?, ?)`,
    [
      vaultId,
      options.formatVersion || "MDBX-1",
      now,
      now,
      options.credential.unlockMethod,
      options.compatFlags || "",
      options.criticalExtensions || "",
      salt ?? null,
      verifier ?? null,
      salt ? kdfProfile : null
    ]
  );
}
