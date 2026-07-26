import { mdbxIterationsFrom, mdbxUnlockMethodFrom, type MdbxUnlockMethod } from "./mdbx-crypto";

/** From `MdbxVaultStore.kt:45-49` (SHA 9930d8d8). */
const SUPPORTED_FORMAT_VERSIONS = ["MDBX-1", "MDBX-1-DRAFT"];

/** `MdbxVaultStore.kt:300-320`. Twelve tables gate writes; four gate reads. */
export const MDBX_REQUIRED_CORE_TABLES = [
  "vault_meta", "devices", "folders", "projects", "entries", "object_index",
  "commits", "commit_parents", "device_heads", "branches", "tombstones", "conflicts"
];
export const MDBX_MINIMUM_READABLE_TABLES = ["vault_meta", "folders", "projects", "entries"];

export type MdbxAccessLevel = "read-write" | "read-only" | "unsupported";

export interface MdbxVaultMeta {
  vaultId: string;
  formatVersion: string;
  releaseLabel?: string;
  capabilityFlags?: string;
  defaultTigaMode?: string;
  unlockMethod: MdbxUnlockMethod;
  kdfProfile: string;
  iterations: number;
  keyFileFingerprint?: string;
  activeKeyEpochId?: string;
  compatFlags?: string;
  criticalExtensions?: string;
}

export interface MdbxAccessAssessment {
  level: MdbxAccessLevel;
  /** Chinese, user-facing. The UI must show this verbatim rather than claiming full compatibility. */
  reason?: string;
  missingTables: string[];
}

/**
 * Android checks the format version and table sets but ignores `critical_extensions`. We downgrade
 * to read-only when it is non-empty: the column exists precisely so a future writer can declare
 * semantics this build does not implement, and writing anyway would corrupt that vault on Android.
 */
export function assessMdbxAccess(meta: MdbxVaultMeta | undefined, tables: string[]): MdbxAccessAssessment {
  const present = new Set(tables);
  const missingReadable = MDBX_MINIMUM_READABLE_TABLES.filter((table) => !present.has(table));
  if (missingReadable.length) {
    return { level: "unsupported", reason: `缺少 MDBX 必需表：${missingReadable.join("、")}。`, missingTables: missingReadable };
  }
  if (!meta) return { level: "unsupported", reason: "MDBX 数据库缺少 vault_meta 记录。", missingTables: [] };
  if (!SUPPORTED_FORMAT_VERSIONS.includes(meta.formatVersion)) {
    return { level: "unsupported", reason: `不支持的 MDBX 格式版本：${meta.formatVersion || "未知"}。`, missingTables: [] };
  }

  const missingCore = MDBX_REQUIRED_CORE_TABLES.filter((table) => !present.has(table));
  if (missingCore.length) {
    return { level: "read-only", reason: `缺少写入所需的表（${missingCore.join("、")}），已切换为只读。`, missingTables: missingCore };
  }
  if (meta.criticalExtensions) {
    return {
      level: "read-only",
      reason: `此数据库声明了本版本未实现的扩展（${meta.criticalExtensions}），已切换为只读以免损坏数据。`,
      missingTables: []
    };
  }
  return { level: "read-write", missingTables: [] };
}

export function parseMdbxVaultMeta(row: Record<string, unknown> | undefined): MdbxVaultMeta | undefined {
  if (!row) return undefined;
  /** Android reads `vault_meta.credential_kdf_profile` first and falls back to the active key epoch's
   * `kdf_profile_id` (`MdbxVaultStore.kt:570-572`); the caller merges those two rows before we see them. */
  const kdfProfile = stringOrEmpty(row.credential_kdf_profile) || stringOrEmpty(row.kdf_profile_id);
  return {
    vaultId: stringOrEmpty(row.vault_id),
    formatVersion: stringOrEmpty(row.format_version),
    releaseLabel: optionalString(row.release_label),
    capabilityFlags: optionalString(row.capability_flags),
    defaultTigaMode: optionalString(row.default_tiga_mode),
    unlockMethod: mdbxUnlockMethodFrom(row.unlock_methods),
    kdfProfile,
    iterations: mdbxIterationsFrom(kdfProfile),
    keyFileFingerprint: optionalString(row.key_file_fingerprint),
    activeKeyEpochId: optionalString(row.active_key_epoch_id),
    compatFlags: optionalString(row.compat_flags),
    criticalExtensions: optionalString(row.critical_extensions)
  };
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
