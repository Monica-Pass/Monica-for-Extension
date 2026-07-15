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

if (!expectedNode || !expectedNpm || expectedManager !== `npm@${expectedNpm}`) throw new Error("package.json must pin one exact Node/npm toolchain.");
if (actualNode !== expectedNode || actualNpm !== expectedNpm) throw new Error(`Toolchain mismatch: expected Node ${expectedNode} / npm ${expectedNpm}, got Node ${actualNode} / npm ${actualNpm}.`);
console.log(`Verified pinned toolchain: Node ${actualNode}, npm ${actualNpm}.`);
