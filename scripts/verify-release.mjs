import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const releaseDir = resolve(root, "release");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packageLockBytes = await readFile(resolve(root, "package-lock.json"));
const packageLock = JSON.parse(packageLockBytes.toString("utf8"));
const prefix = `monica-extension-${packageJson.version}`;
const archiveName = `${prefix}.zip`;
const archivePath = resolve(releaseDir, archiveName);

await verifyArtifacts(releaseDir);
const first = await mkdtemp(join(tmpdir(), "monica-release-a-"));
const second = await mkdtemp(join(tmpdir(), "monica-release-b-"));
try {
  await execFileAsync(process.execPath, [resolve(root, "scripts/package-release.mjs"), "--output-dir", first], { cwd: root });
  await execFileAsync(process.execPath, [resolve(root, "scripts/package-release.mjs"), "--output-dir", second], { cwd: root });
  await compareArtifactSets(releaseDir, first);
  await compareArtifactSets(first, second);
} finally {
  await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
}
console.log(`Verified ${archivePath}: hashes, inventory, contents and two independent packages are byte-identical.`);

async function verifyArtifacts(directory) {
  const archiveBytes = await readFile(resolve(directory, archiveName));
  const archiveHash = sha256(archiveBytes);
  verifyZipTimestamps(archiveBytes);
  const checksum = await readFile(resolve(directory, `${archiveName}.sha256`), "utf8");
  assert(checksum === `${archiveHash}  ${archiveName}\n`, "Archive checksum file does not match the ZIP bytes.");

  const entries = unzipSync(archiveBytes);
  for (const path of Object.keys(entries)) assert(!path.includes("\\") && !path.startsWith("/") && !path.split("/").includes(".."), `Unsafe ZIP path: ${path}`);
  for (const required of ["manifest.json", "background.js", "content.js", "main-world.js", "index.html", "popup.html", "LICENSE", "RELEASE-METADATA.json", "SBOM.cdx.json", "THIRD-PARTY-LICENSES.json", "SECURITY-EVIDENCE.json"]) {
    assert(entries[required], `ZIP is missing ${required}.`);
  }

  const metadata = parseJson(entries["RELEASE-METADATA.json"], "release metadata");
  assert(metadata.version === packageJson.version && metadata.manifestVersion === 3, "Release metadata version mismatch.");
  assert(metadata.archiveTimestamp === "1980-01-01T00:00:00.000Z", "Release timestamp is not fixed.");
  assert(metadata.packageLockSha256 === sha256(packageLockBytes), "Release metadata lockfile hash mismatch.");
  const declaredPaths = metadata.files.map((file) => file.path).sort();
  const actualPaths = Object.keys(entries).filter((path) => path !== "RELEASE-METADATA.json").sort();
  assert(JSON.stringify(declaredPaths) === JSON.stringify(actualPaths), "Embedded file manifest does not exactly cover ZIP entries.");
  for (const file of metadata.files) {
    assert(entries[file.path]?.length === file.size, `Size mismatch for ${file.path}.`);
    assert(sha256(entries[file.path]) === file.sha256, `SHA-256 mismatch for ${file.path}.`);
  }

  const distFiles = await listFiles(resolve(root, "dist"));
  const declaredDist = metadata.files.filter((file) => file.source === "dist").map((file) => file.path).sort();
  assert(JSON.stringify(distFiles) === JSON.stringify(declaredDist), "Release metadata does not exactly cover dist files.");
  for (const path of distFiles) assert(sha256(await readFile(resolve(root, "dist", path))) === sha256(entries[path]), `ZIP differs from dist for ${path}.`);
  assert(equalBytes(await readFile(resolve(root, "LICENSE")), entries.LICENSE), "ZIP license differs from the repository license.");

  const sbomSidecar = await readFile(resolve(directory, metadata.sidecars.sbom.file));
  const licensesSidecar = await readFile(resolve(directory, metadata.sidecars.licenses.file));
  const evidenceSidecar = await readFile(resolve(directory, metadata.sidecars.securityEvidence.file));
  assert(metadata.sidecars.sbom.size === sbomSidecar.length && metadata.sidecars.sbom.sha256 === sha256(sbomSidecar), "SBOM sidecar metadata mismatch.");
  assert(metadata.sidecars.licenses.size === licensesSidecar.length && metadata.sidecars.licenses.sha256 === sha256(licensesSidecar), "License sidecar metadata mismatch.");
  assert(metadata.sidecars.securityEvidence.size === evidenceSidecar.length && metadata.sidecars.securityEvidence.sha256 === sha256(evidenceSidecar), "Security evidence sidecar metadata mismatch.");
  assert(equalBytes(sbomSidecar, entries[metadata.sidecars.sbom.archivePath]), "SBOM sidecar differs from embedded SBOM.");
  assert(equalBytes(licensesSidecar, entries[metadata.sidecars.licenses.archivePath]), "License sidecar differs from embedded inventory.");
  assert(equalBytes(evidenceSidecar, entries[metadata.sidecars.securityEvidence.archivePath]), "Security evidence sidecar differs from embedded evidence.");
  const sbom = parseJson(sbomSidecar, "SBOM");
  const licenses = parseJson(licensesSidecar, "license inventory");
  const evidence = parseJson(evidenceSidecar, "security evidence");
  assert(sbom.bomFormat === "CycloneDX" && sbom.specVersion === "1.5", "SBOM format mismatch.");
  assert(licenses.packageLockSha256 === sha256(packageLockBytes), "License inventory lockfile hash mismatch.");
  assert(evidence.source?.trackedWorktreeClean === true, "Trusted release evidence reports a dirty source tree.");
  assert(evidence.source?.commit === git("rev-parse", "HEAD"), "Security evidence source commit mismatch.");
  assert(evidence.inputs?.packageLockSha256 === sha256(packageLockBytes), "Security evidence lockfile hash mismatch.");
  assert(evidence.embeddedEvidence?.sbomSha256 === sha256(sbomSidecar) && evidence.embeddedEvidence?.thirdPartyLicensesSha256 === sha256(licensesSidecar), "Security evidence embedded hashes mismatch.");

  const expectedPackages = productionPackages(packageLock);
  const sbomPackages = new Set(sbom.components.map((component) => `${component.name}@${component.version}`));
  const licensePackages = new Set(licenses.packages.map((component) => `${component.name}@${component.version}`));
  assert(expectedPackages.size === sbomPackages.size && [...expectedPackages].every((item) => sbomPackages.has(item)), "SBOM does not match production lockfile packages.");
  assert(expectedPackages.size === licensePackages.size && [...expectedPackages].every((item) => licensePackages.has(item)), "License inventory does not match production lockfile packages.");
  assert(licenses.packages.every((component) => component.license && component.license !== "UNKNOWN"), "License inventory contains an unknown license.");
}

async function compareArtifactSets(leftDirectory, rightDirectory) {
  const names = [`${prefix}.zip`, `${prefix}.zip.sha256`, `${prefix}.sbom.cdx.json`, `${prefix}.third-party-licenses.json`, `${prefix}.security-evidence.json`];
  for (const name of names) {
    const [left, right] = await Promise.all([readFile(resolve(leftDirectory, name)), readFile(resolve(rightDirectory, name))]);
    assert(equalBytes(left, right), `${name} is not byte-reproducible.`);
  }
}

async function listFiles(directory) {
  const paths = (await readdir(directory, { recursive: true })).map((path) => path.replaceAll("\\", "/")).sort(compareText);
  const files = [];
  for (const path of paths) if ((await stat(resolve(directory, path))).isFile()) files.push(relative(directory, resolve(directory, path)).replaceAll("\\", "/"));
  return files.sort();
}

function productionPackages(lock) {
  const result = new Set();
  for (const [packagePath, value] of Object.entries(lock.packages || {})) {
    if (!packagePath || !value?.version || value.dev === true || value.devOptional === true) continue;
    const name = value.name || packagePath.slice(packagePath.lastIndexOf("node_modules/") + "node_modules/".length);
    result.add(`${name}@${value.version}`);
  }
  return result;
}

function verifyZipTimestamps(bytes) {
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  assert(end >= 0, "ZIP end-of-central-directory record is missing.");
  const entryCount = bytes.readUInt16LE(end + 10);
  let central = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < entryCount; index += 1) {
    assert(bytes.readUInt32LE(central) === 0x02014b50, "Invalid ZIP central-directory entry.");
    assert(bytes.readUInt16LE(central + 12) === 0 && bytes.readUInt16LE(central + 14) === 0x21, "ZIP central-directory timestamp is not 1980-01-01 00:00:00.");
    const local = bytes.readUInt32LE(central + 42);
    assert(bytes.readUInt32LE(local) === 0x04034b50, "Invalid ZIP local entry.");
    assert(bytes.readUInt16LE(local + 10) === 0 && bytes.readUInt16LE(local + 12) === 0x21, "ZIP local timestamp is not 1980-01-01 00:00:00.");
    central += 46 + bytes.readUInt16LE(central + 28) + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32);
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error(`Invalid ${label} JSON.`); }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
