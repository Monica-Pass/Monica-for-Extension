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

if (!supportedNodeRange || !expectedNode || !expectedNpm || expectedManager !== `npm@${expectedNpm}`) throw new Error("package.json must declare supported Node/npm versions and .nvmrc must pin Node.");
if (actualNode !== expectedNode || actualNpm !== expectedNpm) throw new Error(`Toolchain mismatch: expected Node ${expectedNode} / npm ${expectedNpm}, got Node ${actualNode} / npm ${actualNpm}.`);
console.log(`Verified pinned toolchain: Node ${actualNode}, npm ${actualNpm} (supported Node range: ${supportedNodeRange}).`);
