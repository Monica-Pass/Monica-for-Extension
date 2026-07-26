import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [packageSource, nvmrcSource] = await Promise.all([
  readFile(resolve(root, "package.json"), "utf8"),
  readFile(resolve(root, ".nvmrc"), "utf8")
]);
const packageJson = JSON.parse(packageSource);
const supportedNodeRange = packageJson.engines?.node;
const expectedNode = nvmrcSource.trim();
const expectedNpm = packageJson.engines?.npm;
const expectedManager = packageJson.packageManager;
const actualNode = process.versions.node;
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("verify:toolchain must run through the pinned npm CLI.");
const actualNpm = execFileSync(process.execPath, [npmCli, "--version"], { cwd: root, encoding: "utf8" }).trim();

if (!supportedNodeRange || !expectedNode || !expectedNpm || expectedManager !== `npm@${expectedNpm}`) {
  throw new Error("package.json must declare a Node range and pin one exact npm version; .nvmrc must pin Node.");
}
if (!satisfiesComparators(expectedNode, supportedNodeRange)) {
  throw new Error(`.nvmrc Node ${expectedNode} does not satisfy engines.node range ${supportedNodeRange}.`);
}
if (actualNode !== expectedNode || actualNpm !== expectedNpm) {
  throw new Error(`Toolchain mismatch: expected Node ${expectedNode} / npm ${expectedNpm}, got Node ${actualNode} / npm ${actualNpm}.`);
}
console.log(`Verified pinned toolchain: Node ${actualNode} (range ${supportedNodeRange}), npm ${actualNpm}.`);

function satisfiesComparators(version, range) {
  const actual = parseVersion(version);
  const comparators = range.trim().split(/\s+/).filter(Boolean);
  if (!comparators.length) return false;
  return comparators.every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(comparator);
    if (!match) throw new Error(`Unsupported Node engine comparator: ${comparator}`);
    const comparison = compareVersions(actual, parseVersion(match[2]));
    switch (match[1] || "=") {
      case ">=": return comparison >= 0;
      case "<=": return comparison <= 0;
      case ">": return comparison > 0;
      case "<": return comparison < 0;
      default: return comparison === 0;
    }
  });
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error(`Unsupported semantic version: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
