import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { zipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const outputDir = resolve(argumentValue("--output-dir") || resolve(root, "release"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const packageLockBytes = await readFile(resolve(root, "package-lock.json"));
const packageLock = JSON.parse(packageLockBytes.toString("utf8"));
const version = packageJson.version;
const prefix = `monica-extension-${version}`;
const fixedTimestamp = "1980-01-01T00:00:00.000Z";
const fixedZipTime = new Date(1980, 0, 1, 0, 0, 0);

const distEntries = await readDistEntries();
for (const required of ["manifest.json", "background.js", "content.js", "main-world.js", "index.html", "popup.html"]) {
  if (!distEntries.has(required)) throw new Error(`Release is missing ${required}`);
}
const manifest = JSON.parse(new TextDecoder().decode(distEntries.get("manifest.json")));
if (manifest.version !== version || manifest.manifest_version !== 3) throw new Error("Package and MV3 manifest versions do not match.");

const inventory = productionPackageInventory(packageLock);
const lockfileSha256 = sha256(packageLockBytes);
const sbomName = `${prefix}.sbom.cdx.json`;
const licensesName = `${prefix}.third-party-licenses.json`;
const sbomBytes = jsonBytes(cycloneDxBom(packageJson, inventory, lockfileSha256, fixedTimestamp));
const licensesBytes = jsonBytes({
  schemaVersion: 1,
  product: packageJson.name,
  version,
  generatedFrom: "package-lock.json",
  packageLockSha256: lockfileSha256,
  packages: inventory
});

const packagedEntries = new Map(distEntries);
packagedEntries.set("SBOM.cdx.json", sbomBytes);
packagedEntries.set("THIRD-PARTY-LICENSES.json", licensesBytes);
const fileManifest = [...packagedEntries.entries()]
  .sort(([left], [right]) => compareText(left, right))
  .map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes), source: distEntries.has(path) ? "dist" : "generated" }));
const metadata = {
  schemaVersion: 1,
  product: packageJson.name,
  version,
  manifestVersion: manifest.manifest_version,
  archiveTimestamp: fixedTimestamp,
  hashAlgorithm: "SHA-256",
  packageLockSha256: lockfileSha256,
  files: fileManifest,
  sidecars: {
    sbom: { file: sbomName, archivePath: "SBOM.cdx.json", size: sbomBytes.length, sha256: sha256(sbomBytes) },
    licenses: { file: licensesName, archivePath: "THIRD-PARTY-LICENSES.json", size: licensesBytes.length, sha256: sha256(licensesBytes) }
  }
};
packagedEntries.set("RELEASE-METADATA.json", jsonBytes(metadata));

const zippable = {};
for (const [name, bytes] of [...packagedEntries.entries()].sort(([left], [right]) => compareText(left, right))) {
  zippable[name] = [bytes, { mtime: fixedZipTime }];
}
const archiveBytes = zipSync(zippable, { level: 9 });
const archiveName = `${prefix}.zip`;
const archiveSha256 = sha256(archiveBytes);

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDir, archiveName), archiveBytes),
  writeFile(resolve(outputDir, `${archiveName}.sha256`), `${archiveSha256}  ${archiveName}\n`, "utf8"),
  writeFile(resolve(outputDir, sbomName), sbomBytes),
  writeFile(resolve(outputDir, licensesName), licensesBytes)
]);
console.log(`Created ${resolve(outputDir, archiveName)} with ${packagedEntries.size} files (SHA-256 ${archiveSha256}).`);

async function readDistEntries() {
  const entries = new Map();
  const paths = (await readdir(dist, { recursive: true })).map((path) => path.replaceAll("\\", "/")).sort(compareText);
  for (const path of paths) {
    const absolute = resolve(dist, path);
    if (!(await stat(absolute)).isFile()) continue;
    entries.set(relative(dist, absolute).replaceAll("\\", "/"), new Uint8Array(await readFile(absolute)));
  }
  return entries;
}

function productionPackageInventory(lock) {
  const packages = new Map();
  for (const [packagePath, value] of Object.entries(lock.packages || {})) {
    if (!packagePath || !value?.version || value.dev === true || value.devOptional === true) continue;
    const name = value.name || packagePath.slice(packagePath.lastIndexOf("node_modules/") + "node_modules/".length);
    const key = `${name}@${value.version}`;
    if (!packages.has(key)) packages.set(key, {
      name,
      version: value.version,
      license: value.license || "UNKNOWN",
      integrity: value.integrity || null,
      direct: Boolean(packageJson.dependencies?.[name])
    });
  }
  return [...packages.values()].sort((left, right) => compareText(left.name, right.name) || compareText(left.version, right.version));
}

function cycloneDxBom(pkg, inventory, lockfileHash, timestamp) {
  const rootRef = `pkg:npm/${purlName(pkg.name)}@${pkg.version}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp,
      component: { type: "application", "bom-ref": rootRef, name: pkg.name, version: pkg.version, licenses: [{ expression: pkg.license }] },
      properties: [{ name: "monica:package-lock:sha256", value: lockfileHash }]
    },
    components: inventory.map((entry) => ({
      type: "library",
      "bom-ref": `pkg:npm/${purlName(entry.name)}@${entry.version}`,
      name: entry.name,
      version: entry.version,
      scope: "required",
      licenses: [{ expression: entry.license }],
      purl: `pkg:npm/${purlName(entry.name)}@${entry.version}`,
      properties: [{ name: "monica:direct-dependency", value: String(entry.direct) }]
    }))
  };
}

function purlName(name) {
  return name.startsWith("@") ? `%40${name.slice(1)}` : name;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
