import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { zipSync } from "fflate";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("MDBX2 Host release package must be built on Windows x64.");

const root = resolve(import.meta.dirname, "..");
const hostRoot = resolve(root, "native", "mdbx2-host");
const outputDir = resolve(argumentValue("--output-dir") || resolve(root, "release"));
const cargo = parseCargo(await readFile(resolve(hostRoot, "Cargo.toml"), "utf8"));
const executableName = "monica-mdbx2-host.exe";
const executableBytes = new Uint8Array(await readFile(resolve(hostRoot, "target", "release", executableName)));
const sourceCommit = git("rev-parse", "HEAD");
const sourceTreeClean = git("status", "--porcelain", "--untracked-files=no") === "";
if (!sourceTreeClean && !process.argv.includes("--allow-dirty")) throw new Error("Refusing to package MDBX2 Host from a dirty tracked worktree.");

const fixedZipTime = new Date(1980, 0, 1, 0, 0, 0);
const packageName = `monica-mdbx2-host-windows-x64-${cargo.version}.zip`;
const entries = new Map([
  [executableName, executableBytes],
  ["install-host.ps1", new Uint8Array(await readFile(resolve(hostRoot, "install-host.ps1")))],
  ["uninstall-host.ps1", new Uint8Array(await readFile(resolve(hostRoot, "uninstall-host.ps1")))],
  ["host-manifest.template.json", new Uint8Array(await readFile(resolve(hostRoot, "host-manifest.template.json")))],
  ["README.md", new Uint8Array(await readFile(resolve(hostRoot, "README.md")))],
  ["Cargo.lock", new Uint8Array(await readFile(resolve(hostRoot, "Cargo.lock")))],
  ["LICENSE", new Uint8Array(await readFile(resolve(root, "LICENSE")))]
]);
const metadata = {
  schemaVersion: 1,
  product: cargo.name,
  version: cargo.version,
  platform: "windows-x64",
  hostName: "com.monica_pass.mdbx2",
  protocolVersion: 2,
  coreRevision: "974c517465e7b6cac0947d2d59875aa4211fa16b",
  source: { commit: sourceCommit, trackedWorktreeClean: sourceTreeClean },
  executable: { file: executableName, size: executableBytes.length, sha256: sha256(executableBytes) },
  installScope: "current-user",
  registryTargets: [
    "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.monica_pass.mdbx2",
    "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.monica_pass.mdbx2",
    "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.monica_pass.windows_hello",
    "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.monica_pass.windows_hello"
  ]
};
entries.set("HOST-METADATA.json", jsonBytes(metadata));

const zippable = {};
for (const [name, bytes] of [...entries.entries()].sort(([left], [right]) => compareText(left, right))) {
  zippable[name] = [bytes, { mtime: fixedZipTime }];
}
const archiveBytes = zipSync(zippable, { level: 9 });
const archiveHash = sha256(archiveBytes);
await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDir, packageName), archiveBytes),
  writeFile(resolve(outputDir, `${packageName}.sha256`), `${archiveHash}  ${packageName}\n`, "utf8")
]);
console.log(`Created ${resolve(outputDir, packageName)} (SHA-256 ${archiveHash}).`);

function parseCargo(source) {
  const name = /^name\s*=\s*"([^"]+)"/m.exec(source)?.[1];
  const version = /^version\s*=\s*"([^"]+)"/m.exec(source)?.[1];
  if (!name || !version) throw new Error("MDBX2 Host Cargo package identity is missing.");
  return { name, version };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
