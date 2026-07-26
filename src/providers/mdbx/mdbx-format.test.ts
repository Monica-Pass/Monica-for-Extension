import { describe, expect, it } from "vitest";
import { assessMdbxAccess, MDBX_REQUIRED_CORE_TABLES, parseMdbxVaultMeta } from "./mdbx-format";

const ALL_TABLES = [...MDBX_REQUIRED_CORE_TABLES, "attachments", "oplog"];
const META = { vault_id: "vault-1", format_version: "MDBX-1", unlock_methods: "password", kdf_profile_id: "pbkdf2-sha256:90000" };

describe("mdbx format gate", () => {
  it("allows writes only when all twelve core tables are present", () => {
    expect(assessMdbxAccess(parseMdbxVaultMeta(META), ALL_TABLES)).toMatchObject({ level: "read-write" });
  });

  it("degrades to read-only when a write-only table is missing", () => {
    const withoutCommits = ALL_TABLES.filter((table) => table !== "commits");

    const assessment = assessMdbxAccess(parseMdbxVaultMeta(META), withoutCommits);

    expect(assessment.level).toBe("read-only");
    expect(assessment.missingTables).toEqual(["commits"]);
    expect(assessment.reason).toContain("只读");
  });

  it("rejects a database missing any of the four readable tables", () => {
    expect(assessMdbxAccess(parseMdbxVaultMeta(META), ["vault_meta", "folders", "projects"])).toMatchObject({
      level: "unsupported",
      missingTables: ["entries"]
    });
  });

  it("rejects a format version this build does not know", () => {
    const future = assessMdbxAccess(parseMdbxVaultMeta({ ...META, format_version: "MDBX-2" }), ALL_TABLES);

    expect(future.level).toBe("unsupported");
    expect(future.reason).toContain("MDBX-2");
  });

  it("accepts the legacy draft format Android still opens", () => {
    expect(assessMdbxAccess(parseMdbxVaultMeta({ ...META, format_version: "MDBX-1-DRAFT" }), ALL_TABLES)).toMatchObject({ level: "read-write" });
  });

  it("refuses to write a vault declaring critical extensions it cannot honour", () => {
    const assessment = assessMdbxAccess(parseMdbxVaultMeta({ ...META, critical_extensions: "sky-portable-v2" }), ALL_TABLES);

    expect(assessment.level).toBe("read-only");
    expect(assessment.reason).toContain("sky-portable-v2");
  });

  it("reads the iteration count and unlock method from vault_meta", () => {
    expect(parseMdbxVaultMeta({ ...META, unlock_methods: "DEVICE_KEY", kdf_profile_id: "pbkdf2-sha256:360000" })).toMatchObject({
      unlockMethod: "device_key",
      iterations: 360_000
    });
  });

  it("keeps compat_flags and critical_extensions available so a write can carry them back", () => {
    const meta = parseMdbxVaultMeta({ ...META, compat_flags: "legacy-test-compatible", critical_extensions: "" });

    expect(meta).toMatchObject({ compatFlags: "legacy-test-compatible", criticalExtensions: undefined });
  });
});
