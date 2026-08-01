import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("MDBX2 Host package verification requires Windows x64.");

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const hostRoot = resolve(root, "native", "mdbx2-host");
const releaseDir = resolve(root, "release");
const allowDirty = process.argv.includes("--allow-dirty");
const sourceTreeClean = git("status", "--porcelain", "--untracked-files=no") === "";
if (!sourceTreeClean && !allowDirty) throw new Error("Refusing to verify MDBX2 Host package from a dirty tracked worktree.");
const cargo = parseCargo(await readFile(resolve(hostRoot, "Cargo.toml"), "utf8"));
const archiveName = `monica-mdbx2-host-windows-x64-${cargo.version}.zip`;
const archivePath = resolve(releaseDir, archiveName);
await verifyArchive(archivePath, resolve(releaseDir, `${archiveName}.sha256`));

const first = await mkdtemp(join(tmpdir(), "monica-mdbx2-host-a-"));
const second = await mkdtemp(join(tmpdir(), "monica-mdbx2-host-b-"));
try {
  const script = resolve(root, "scripts", "package-mdbx2-host.mjs");
  const dirtyFlag = allowDirty ? ["--allow-dirty"] : [];
  await execFileAsync(process.execPath, [script, "--output-dir", first, ...dirtyFlag], { cwd: root });
  await execFileAsync(process.execPath, [script, "--output-dir", second, ...dirtyFlag], { cwd: root });
  for (const name of [archiveName, `${archiveName}.sha256`]) {
    const [left, right, released] = await Promise.all([
      readFile(resolve(first, name)),
      readFile(resolve(second, name)),
      readFile(resolve(releaseDir, name))
    ]);
    assert(equalBytes(left, right) && equalBytes(left, released), `${name} is not byte-reproducible.`);
  }
} finally {
  await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
}
console.log(`Verified ${archivePath}: executable, installer policy, hashes and reproducibility.`);

async function verifyArchive(path, checksumPath) {
  const bytes = await readFile(path);
  const checksum = await readFile(checksumPath, "utf8");
  assert(checksum === `${sha256(bytes)}  ${archiveName}\n`, "MDBX2 Host checksum does not match the ZIP bytes.");
  verifyZipTimestamps(bytes);
  const entries = unzipSync(bytes);
  for (const required of ["monica-mdbx2-host.exe", "install-host.ps1", "uninstall-host.ps1", "host-manifest.template.json", "README.md", "Cargo.lock", "LICENSE", "HOST-METADATA.json"]) {
    assert(entries[required], `MDBX2 Host package is missing ${required}.`);
  }
  const builtExecutable = await readFile(resolve(hostRoot, "target", "release", "monica-mdbx2-host.exe"));
  assert(equalBytes(builtExecutable, entries["monica-mdbx2-host.exe"]), "Packaged MDBX2 Host differs from the verified release build.");
  const metadata = JSON.parse(new TextDecoder().decode(entries["HOST-METADATA.json"]));
  assert(metadata.hostName === "com.monica_pass.mdbx2" && metadata.protocolVersion === 2, "MDBX2 Host metadata identity mismatch.");
  assert(metadata.coreRevision === "aafa22f195c626a8d8288d712bf42bccea134847", "MDBX2 Host metadata core revision mismatch.");
  assert(metadata.source?.trackedWorktreeClean === sourceTreeClean && metadata.source?.commit === git("rev-parse", "HEAD"), "MDBX2 Host source evidence mismatch.");
  assert(metadata.executable?.size === builtExecutable.length && metadata.executable?.sha256 === sha256(builtExecutable), "MDBX2 Host executable metadata mismatch.");
  const installer = new TextDecoder().decode(entries["install-host.ps1"]);
  assert(installer.includes("^[a-p]{32}$") && !installer.includes("chrome-extension://*/"), "MDBX2 Host installer does not enforce exact extension origins.");
  assert(installer.includes("Google\\Chrome\\NativeMessagingHosts") && installer.includes("Microsoft\\Edge\\NativeMessagingHosts"), "MDBX2 Host installer is missing Chrome or Edge registration.");
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", powerShellParseCommand(resolve(hostRoot, "install-host.ps1"), resolve(hostRoot, "uninstall-host.ps1"))], { cwd: root, stdio: "pipe" });
}

function powerShellParseCommand(...paths) {
  const quoted = paths.map((path) => `'${path.replaceAll("'", "''")}'`).join(",");
  return `$failed=$false; foreach($p in @(${quoted})){ $tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){ $errors | ForEach-Object { Write-Error $_.Message }; $failed=$true } }; if($failed){ exit 1 }`;
}

function verifyZipTimestamps(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert(end >= 0, "MDBX2 Host ZIP end record is missing.");
  const entryCount = bytes.readUInt16LE(end + 10);
  let central = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert(bytes.readUInt32LE(central) === 0x02014b50, "Invalid MDBX2 Host ZIP entry.");
    assert(bytes.readUInt16LE(central + 12) === 0 && bytes.readUInt16LE(central + 14) === 0x21, "MDBX2 Host ZIP timestamp is not fixed.");
    const local = bytes.readUInt32LE(central + 42);
    assert(bytes.readUInt32LE(local) === 0x04034b50, "Invalid MDBX2 Host ZIP local entry.");
    assert(bytes.readUInt16LE(local + 10) === 0 && bytes.readUInt16LE(local + 12) === 0x21, "MDBX2 Host local ZIP timestamp is not fixed.");
    central += 46 + bytes.readUInt16LE(central + 28) + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32);
  }
}

function parseCargo(source) {
  const name = /^name\s*=\s*"([^"]+)"/m.exec(source)?.[1];
  const version = /^version\s*=\s*"([^"]+)"/m.exec(source)?.[1];
  if (!name || !version) throw new Error("MDBX2 Host Cargo identity is missing.");
  return { name, version };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
