import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const hostRoot = resolve(root, "native", "mdbx2-host");
const coreRevision = "90005c8c608c952093a4522ffa507a562e2e39a4";

const [manifest, lockfile, toolchain, hostManifest, installer, uninstaller, runtime, windowsHello, contract] = await Promise.all([
  readFile(resolve(hostRoot, "Cargo.toml"), "utf8"),
  readFile(resolve(hostRoot, "Cargo.lock"), "utf8"),
  readFile(resolve(hostRoot, "rust-toolchain.toml"), "utf8"),
  readFile(resolve(hostRoot, "host-manifest.template.json"), "utf8"),
  readFile(resolve(hostRoot, "install-host.ps1"), "utf8"),
  readFile(resolve(hostRoot, "uninstall-host.ps1"), "utf8"),
  readFile(resolve(hostRoot, "src", "runtime.rs"), "utf8"),
  readFile(resolve(hostRoot, "src", "windows_hello.rs"), "utf8"),
  readFile(resolve(root, "src", "providers", "mdbx2", "native-contract.ts"), "utf8")
]);

if (!manifest.includes('mdbx-ffi = { path = "vendor/mdbx/crates/mdbx-ffi" }') || !manifest.includes('mdbx-core = { path = "vendor/mdbx/crates/mdbx-core" }')) throw new Error("MDBX2 Host must use the verified Android runtime source.");
if (!manifest.includes('uniffi = "=0.31.1"')) throw new Error("MDBX2 Host UniFFI version is not pinned to the Android release version.");
if (lockfile.includes('git+https://github.com/Monica-Pass/Mdbx')) throw new Error("MDBX2 Host Cargo.lock still resolves an unpatched Git dependency.");
const provenance = JSON.parse(await readFile(resolve(hostRoot, "ENGINE-PROVENANCE.json"), "utf8"));
if (provenance.source.commit !== coreRevision || provenance.source.additional_overlays.length !== 3) throw new Error("MDBX2 Host runtime provenance does not match Android 1.0.315.");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalize = (path, bytes) => /\.(rs|toml|lock|md|json)$/.test(path) || path === "LICENSE" ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n")) : bytes;
const extensionHashes = {};
for (const overlay of provenance.extension_overlays || []) {
  if (!overlay.patch?.startsWith('runtime-patches/') || overlay.patch.includes('..')) throw new Error('Invalid extension overlay path.');
  if (sha256(await readFile(resolve(hostRoot, overlay.patch))) !== overlay.patch_sha256) throw new Error(`Extension overlay hash differs: ${overlay.id}.`);
  if (Object.keys(overlay.files).length !== Object.keys(overlay.base_files).length) throw new Error('Extension overlay file inventory differs.');
  for (const [path, hash] of Object.entries(overlay.files)) {
    if (!provenance.files[path] || (extensionHashes[path] || provenance.files[path]) !== overlay.base_files[path]) throw new Error(`Extension overlay baseline differs: ${path}.`);
    extensionHashes[path] = hash;
  }
}
for (const [path, expected] of Object.entries(provenance.files)) {
  if (path.includes("..") || path.startsWith("/")) throw new Error("Invalid runtime provenance path.");
  const actual = sha256(normalize(path, await readFile(resolve(hostRoot, "vendor", "mdbx", path))));
  if (actual !== (extensionHashes[path] || expected)) throw new Error(`MDBX2 vendored source changed: ${path}.`);
}
for (const overlay of [provenance.source.local_overlay, ...provenance.source.additional_overlays]) {
  const file = overlay.patch.split("/").at(-1);
  if (sha256(await readFile(resolve(hostRoot, "runtime-patches", file))) !== overlay.patch_sha256) throw new Error(`MDBX2 Android overlay hash differs: ${file}.`);
}
const finalHashes = {...provenance.source.local_overlay.files, ...provenance.source.additional_overlays[0].files, ...provenance.source.final_overlay_files};
for (const [path, hash] of Object.entries(finalHashes)) {
  if (provenance.files[path] !== hash) throw new Error(`MDBX2 source differs from Android final runtime: ${path}.`);
}
if (!runtime.includes(`MDBX_CORE_REVISION: &str = "${coreRevision}"`) || !contract.includes(`MDBX2_CORE_REVISION = "${coreRevision}"`)) throw new Error("MDBX2 runtime and extension revision gates differ.");
for (const capability of ["supportsNativeObjectIdentity", "supportsObjectRevisionPreconditions", "supportsLosslessJson", "supportsAtomicObjectAttachmentMove", "supportsVaultWriteRevision", "supportsObjectRestore"]) {
  if (!runtime.includes(`"${capability}": true`)) throw new Error(`MDBX2 Host is missing ${capability}.`);
}
if (!toolchain.includes('channel = "1.86.0"')) throw new Error("MDBX2 Host Rust toolchain differs from the reviewed core release toolchain.");

const parsedHostManifest = JSON.parse(hostManifest);
if (parsedHostManifest.name !== "com.monica_pass.mdbx2" || parsedHostManifest.type !== "stdio") {
  throw new Error("MDBX2 native-host manifest identity changed without review.");
}
if (!Array.isArray(parsedHostManifest.allowed_origins) || parsedHostManifest.allowed_origins.length !== 1) {
  throw new Error("MDBX2 native-host manifest must contain one installer-substituted exact origin.");
}
const allowedOrigin = parsedHostManifest.allowed_origins[0];
if (allowedOrigin !== "chrome-extension://__EXTENSION_ID__/" || allowedOrigin.includes("*")) {
  throw new Error("MDBX2 native-host manifest contains an unreviewed origin pattern.");
}
if (parsedHostManifest.path !== "__HOST_EXECUTABLE_PATH__") {
  throw new Error("MDBX2 native-host manifest path must be supplied by the installer.");
}
if (!installer.includes('"^[a-p]{32}$"') || installer.includes("chrome-extension://*/")) {
  throw new Error("MDBX2 Host installer must validate exact Chrome extension IDs and forbid wildcard origins.");
}
for (const registryPath of ["Google\\Chrome\\NativeMessagingHosts", "Microsoft\\Edge\\NativeMessagingHosts"]) {
  if (!installer.includes(registryPath) || !uninstaller.includes(registryPath)) throw new Error(`MDBX2 Host installer lifecycle is missing ${registryPath}.`);
}
if (!uninstaller.includes("GetPathRoot") || !uninstaller.includes("-LiteralPath $InstallRoot -Recurse")) {
  throw new Error("MDBX2 Host uninstaller is missing its reviewed absolute-path deletion guard.");
}
for (const required of ['"history.list"', '"history.diff"', '"history.revert"', 'MAX_HISTORY_PAGE_SIZE', 'MAX_HISTORY_RESULT_BYTES', 'MAX_HISTORY_REVERT_ITEMS', '"supportsHistoryDiff": true', '"supportsHistoryRevert".to_string()']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host history boundary is missing ${required}.`);
}
for (const required of ['"collection.list"', '"collection.create"', '"collection.rename"', '"collection.move"', '"collection.delete"', '"collection.restore"', 'MAX_COLLECTION_TITLE_BYTES', 'MAX_COLLECTION_RESULT_BYTES', '"supportsCollectionMutation".to_string()']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host Collection boundary is missing ${required}.`);
}
for (const required of ['"vault.diagnostics"', 'MAX_VAULT_DIAGNOSTIC_CATEGORIES', 'MAX_VAULT_HEALTH_ISSUE_KINDS', 'MAX_VAULT_DIAGNOSTICS_RESULT_BYTES', '"supportsVaultDiagnostics".to_string()', '"supportsVaultHealthIssueKinds".to_string()', 'vault_health_projection', 'safe_vault_health_issue_kind']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host diagnostics boundary is missing ${required}.`);
}
for (const required of ['"vault.tiga"', 'MAX_VAULT_TIGA_RESULT_BYTES', 'MAX_VAULT_TIGA_UNLOCK_METHODS', 'MAX_VAULT_TIGA_BROWSER_LIMITATIONS', '"supportsVaultTigaPosture".to_string()', 'vault_tiga_report']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host Tiga posture boundary is missing ${required}.`);
}
for (const required of ['"snapshot.prune.plan"', '"snapshot.prune.execute"', 'MAX_SNAPSHOT_PRUNE_CANDIDATES', 'MAX_SNAPSHOT_PRUNE_KEEP_LATEST', '"supportsSnapshotPrune".to_string()']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host snapshot prune boundary is missing ${required}.`);
}
for (const required of ['"conflict.list"', '"conflict.resolve"', 'MAX_CONFLICT_PAGE_SIZE', 'MAX_CONFLICT_RESULT_BYTES', '"supportsConflictResolution": true', 'conflict-resolutions.state.']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host conflict boundary is missing ${required}.`);
}
for (const required of ['"attachment.list"', '"attachment.read.begin"', '"attachment.upload.begin"', '"attachment.delete"', 'MAX_ATTACHMENT_BYTES', 'MAX_ATTACHMENT_MEMORY_BYTES', '"supportsAttachmentManagement": true', 'Zeroizing<Vec<u8>>']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host attachment boundary is missing ${required}.`);
}
for (const required of ["GetForegroundWindow", "hello-window-unavailable", "binding-record-invalid", "credential_bytes", "confirmation-required"]) {
  if (!windowsHello.includes(required)) throw new Error(`MDBX2 Host Windows Hello boundary is missing ${required}.`);
}
for (const required of ["MDBX2_MAX_HISTORY_PAGE_SIZE", "MDBX2_MAX_HISTORY_RESULT_BYTES", "MDBX2_MAX_HISTORY_REVERT_ITEMS", "supportsHistoryDiff: true", "supportsHistoryRevert: true"]) {
  if (!contract.includes(required)) throw new Error(`MDBX2 extension history contract is missing ${required}.`);
}
for (const required of ["MDBX2_MAX_COLLECTION_TITLE_BYTES", "MDBX2_MAX_COLLECTION_RESULT_BYTES", "supportsCollectionMutation: true", '"collection.create"', '"collection.restore"']) {
  if (!contract.includes(required)) throw new Error(`MDBX2 extension Collection contract is missing ${required}.`);
}
for (const required of ["MDBX2_MAX_VAULT_DIAGNOSTIC_CATEGORIES", "MDBX2_MAX_VAULT_HEALTH_ISSUE_KINDS", "MDBX2_MAX_VAULT_DIAGNOSTICS_RESULT_BYTES", "supportsVaultDiagnostics: true", "supportsVaultHealthIssueKinds: true", '"vault.diagnostics"', "Mdbx2VaultDiagnosticsReport"]) {
  if (!contract.includes(required)) throw new Error(`MDBX2 extension diagnostics contract is missing ${required}.`);
}
for (const required of ["MDBX2_MAX_VAULT_TIGA_RESULT_BYTES", "MDBX2_MAX_VAULT_TIGA_UNLOCK_METHODS", "MDBX2_MAX_VAULT_TIGA_BROWSER_LIMITATIONS", "supportsVaultTigaPosture: true", '"vault.tiga"', "Mdbx2VaultTigaPosture"]) {
  if (!contract.includes(required)) throw new Error(`MDBX2 extension Tiga posture contract is missing ${required}.`);
}
for (const required of ["MDBX2_MAX_SNAPSHOT_PRUNE_CANDIDATES", "MDBX2_MAX_SNAPSHOT_PRUNE_KEEP_LATEST", "supportsSnapshotPrune: true", '"snapshot.prune.plan"', '"snapshot.prune.execute"']) {
  if (!contract.includes(required)) throw new Error(`MDBX2 extension snapshot prune contract is missing ${required}.`);
}
for (const required of ["MDBX2_MAX_CONFLICT_PAGE_SIZE", "MDBX2_MAX_CONFLICT_RESULT_BYTES", "supportsConflictResolution: true"]) {
  if (!contract.includes(required)) throw new Error(`MDBX2 extension conflict contract is missing ${required}.`);
}
for (const required of ["MDBX2_MAX_ATTACHMENT_BYTES", "MDBX2_MAX_ATTACHMENT_MEMORY_BYTES", "supportsAttachmentManagement: true", '"attachment.upload.finish"']) {
  if (!contract.includes(required)) throw new Error(`MDBX2 extension attachment contract is missing ${required}.`);
}

console.log(`Verified MDBX2 Host pin ${coreRevision} with all four Android overlays, ${(provenance.extension_overlays || []).length} explicit extension overlays and ${Object.keys(provenance.files).length} vendored files, Rust 1.86.0, UniFFI 0.31.1, lossless JSON/native identity/revision boundaries, exact-origin installer, Windows Hello, Collection, diagnostics, Tiga, history, snapshot, conflict and attachment boundaries.`);
