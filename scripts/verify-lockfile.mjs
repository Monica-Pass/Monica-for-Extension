import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [packageSource, lockSource, npmrc] = await Promise.all([
  readFile(resolve(root, "package.json"), "utf8"),
  readFile(resolve(root, "package-lock.json"), "utf8"),
  readFile(resolve(root, ".npmrc"), "utf8")
]);
const packageJson = JSON.parse(packageSource);
const lockfile = JSON.parse(lockSource);

if (lockfile.lockfileVersion !== 3) throw new Error(`Expected lockfileVersion 3, received ${lockfile.lockfileVersion}.`);
if (!/^ignore-scripts=true$/m.test(npmrc)) throw new Error(".npmrc must disable dependency lifecycle scripts by default.");
if (!/^registry=https:\/\/registry\.npmjs\.org\/$/m.test(npmrc)) throw new Error(".npmrc must pin the official npm registry.");

const rootPackage = lockfile.packages?.[""];
if (!rootPackage) throw new Error("package-lock.json has no root package entry.");
for (const section of ["dependencies", "devDependencies"]) {
  const declared = packageJson[section] || {};
  if (JSON.stringify(rootPackage[section] || {}) !== JSON.stringify(declared)) {
    throw new Error(`package-lock.json root ${section} does not match package.json.`);
  }
}

let registryPackages = 0;
for (const [path, entry] of Object.entries(lockfile.packages || {})) {
  if (!path || entry.link || !entry.version) continue;
  registryPackages += 1;
  if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
    throw new Error(`${path} is not locked to the official npm registry.`);
  }
  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
    throw new Error(`${path} is missing a SHA-512 registry integrity value.`);
  }
}
if (!registryPackages) throw new Error("package-lock.json contains no registry packages.");

console.log(`Verified ${registryPackages} locked registry packages: official npm origin, SHA-512 integrity and install scripts disabled by default.`);
