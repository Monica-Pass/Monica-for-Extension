import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const expectedNode = packageJson.engines?.node;
const expectedNpm = packageJson.engines?.npm;
const expectedManager = packageJson.packageManager;
const actualNode = process.versions.node;
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("verify:toolchain must run through the pinned npm CLI.");
const actualNpm = execFileSync(process.execPath, [npmCli, "--version"], { cwd: root, encoding: "utf8" }).trim();

if (!expectedNode || !expectedNpm || expectedManager !== `npm@${expectedNpm}`) throw new Error("package.json must declare a Node range and pin one exact npm version.");
if (!satisfiesComparators(actualNode, expectedNode) || actualNpm !== expectedNpm) throw new Error(`Toolchain mismatch: expected Node ${expectedNode} / npm ${expectedNpm}, got Node ${actualNode} / npm ${actualNpm}.`);
console.log(`Verified toolchain: Node ${actualNode} satisfies ${expectedNode}; npm ${actualNpm} is pinned.`);

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
