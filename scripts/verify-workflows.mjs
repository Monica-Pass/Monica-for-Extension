import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflowDir = resolve(root, ".github/workflows");
const workflowNames = (await readdir(workflowDir)).filter((name) => /\.ya?ml$/i.test(name)).sort();
if (!workflowNames.length) throw new Error("No GitHub Actions workflows found.");

for (const name of workflowNames) {
  const source = await readFile(resolve(workflowDir, name), "utf8");
  if (/\bpull_request_target\s*:/.test(source)) throw new Error(`${name} uses pull_request_target, which is forbidden for this repository.`);
  if (!/^permissions:\s*$/m.test(source) && !/^\s+permissions:\s*$/m.test(source)) throw new Error(`${name} has no explicit permissions block.`);
  if (/\b(?:curl|wget|Invoke-WebRequest)\b/i.test(source)) throw new Error(`${name} downloads executable content with an unverified shell command.`);
  for (const match of source.matchAll(/uses:\s*([^\s#]+)@([^\s#]+)/g)) {
    const action = match[1];
    const reference = match[2];
    if (action.startsWith("./")) continue;
    if (!/^[0-9a-f]{40}$/i.test(reference)) throw new Error(`${name} does not pin ${action} to a full commit SHA.`);
  }
  if (/\bnpm\s+(?:install|i)\b/.test(source) && !/\bnpm\s+ci\b/.test(source)) throw new Error(`${name} must use npm ci rather than npm install.`);
}
console.log(`Verified ${workflowNames.length} workflow files: immutable actions, explicit permissions and no unverified download commands.`);
