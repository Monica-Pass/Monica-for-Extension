import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const hostRoot = resolve(root, "native", "mdbx2-host");
const coreRevision = "aafa22f195c626a8d8288d712bf42bccea134847";
const expectedSource = `git+https://github.com/Monica-Pass/Mdbx.git?rev=${coreRevision}#${coreRevision}`;

const [manifest, lockfile, toolchain, hostManifest, installer, uninstaller, runtime, contract] = await Promise.all([
  readFile(resolve(hostRoot, "Cargo.toml"), "utf8"),
  readFile(resolve(hostRoot, "Cargo.lock"), "utf8"),
  readFile(resolve(hostRoot, "rust-toolchain.toml"), "utf8"),
  readFile(resolve(hostRoot, "host-manifest.template.json"), "utf8"),
  readFile(resolve(hostRoot, "install-host.ps1"), "utf8"),
  readFile(resolve(hostRoot, "uninstall-host.ps1"), "utf8"),
  readFile(resolve(hostRoot, "src", "runtime.rs"), "utf8"),
  readFile(resolve(root, "src", "providers", "mdbx2", "native-contract.ts"), "utf8")
]);

if (!manifest.includes(`rev = "${coreRevision}"`)) throw new Error("MDBX2 Host core dependency is not pinned to the reviewed revision.");
if (!manifest.includes('uniffi = "=0.31.1"')) throw new Error("MDBX2 Host UniFFI version is not pinned to the Android release version.");
if (!lockfile.includes(`source = "${expectedSource}"`)) throw new Error("MDBX2 Host Cargo.lock does not contain the reviewed core source identity.");
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
for (const required of ['"snapshot.prune.plan"', '"snapshot.prune.execute"', 'MAX_SNAPSHOT_PRUNE_CANDIDATES', 'MAX_SNAPSHOT_PRUNE_KEEP_LATEST', '"supportsSnapshotPrune".to_string()']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host snapshot prune boundary is missing ${required}.`);
}
for (const required of ['"conflict.list"', '"conflict.resolve"', 'MAX_CONFLICT_PAGE_SIZE', 'MAX_CONFLICT_RESULT_BYTES', '"supportsConflictResolution": true', 'conflict-resolutions.state.']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host conflict boundary is missing ${required}.`);
}
for (const required of ['"attachment.list"', '"attachment.read.begin"', '"attachment.upload.begin"', '"attachment.delete"', 'MAX_ATTACHMENT_BYTES', 'MAX_ATTACHMENT_MEMORY_BYTES', '"supportsAttachmentManagement": true', 'Zeroizing<Vec<u8>>']) {
  if (!runtime.includes(required)) throw new Error(`MDBX2 Host attachment boundary is missing ${required}.`);
}
for (const required of ["MDBX2_MAX_HISTORY_PAGE_SIZE", "MDBX2_MAX_HISTORY_RESULT_BYTES", "MDBX2_MAX_HISTORY_REVERT_ITEMS", "supportsHistoryDiff: true", "supportsHistoryRevert: true"]) {
  if (!contract.includes(required)) throw new Error(`MDBX2 extension history contract is missing ${required}.`);
}
for (const required of ["MDBX2_MAX_COLLECTION_TITLE_BYTES", "MDBX2_MAX_COLLECTION_RESULT_BYTES", "supportsCollectionMutation: true", '"collection.create"', '"collection.restore"']) {
  if (!contract.includes(required)) throw new Error(`MDBX2 extension Collection contract is missing ${required}.`);
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

console.log(`Verified MDBX2 Host pin ${coreRevision}, Rust 1.86.0, UniFFI 0.31.1, exact-origin installer, Collection, history read/revert, snapshot prune, conflict and attachment boundaries, and manifest template.`);
