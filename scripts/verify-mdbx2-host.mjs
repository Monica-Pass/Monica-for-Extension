import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const hostRoot = resolve(root, "native", "mdbx2-host");
const coreRevision = "aafa22f195c626a8d8288d712bf42bccea134847";
const expectedSource = `git+https://github.com/Monica-Pass/Mdbx.git?rev=${coreRevision}#${coreRevision}`;

const [manifest, lockfile, toolchain, hostManifest] = await Promise.all([
  readFile(resolve(hostRoot, "Cargo.toml"), "utf8"),
  readFile(resolve(hostRoot, "Cargo.lock"), "utf8"),
  readFile(resolve(hostRoot, "rust-toolchain.toml"), "utf8"),
  readFile(resolve(hostRoot, "host-manifest.template.json"), "utf8")
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

console.log(`Verified MDBX2 Host pin ${coreRevision}, Rust 1.86.0, UniFFI 0.31.1 and exact-origin manifest template.`);
