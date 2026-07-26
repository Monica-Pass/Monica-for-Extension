import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const workflowDir = resolve(root, ".github/workflows");
const workflowNames = (await readdir(workflowDir)).filter((name) => /\.ya?ml$/i.test(name)).sort();
if (!workflowNames.length) throw new Error("No GitHub Actions workflows found.");

const sources = new Map();
for (const name of workflowNames) {
  const source = await readFile(resolve(workflowDir, name), "utf8");
  sources.set(name, source);
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

// Secret scan must not discard unverified/unknown findings via --only-verified.
const secretScan = sources.get("secret-scan.yml");
if (!secretScan) throw new Error("secret-scan.yml is required.");
// Flag form or extra_args value; ignore prose comments that only mention the policy.
if (/--only-verified\b/.test(secretScan) || /extra_args:\s*[^\n]*\bonly-verified\b/.test(secretScan)) {
  throw new Error("secret-scan.yml must not use --only-verified (drops unverified/unknown credential findings).");
}

// Dependency review must keep the real API on non-forks and a real substitute on forks.
// Require both job branches in structure (if: conditions near jobs), not prose comments alone.
const dependencyReview = sources.get("dependency-review.yml");
if (!dependencyReview) throw new Error("dependency-review.yml is required.");
const withoutComments = dependencyReview
  .split(/\r?\n/)
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");
const hasUpstreamReview =
  /if:\s*\$\{\{\s*!\s*github\.event\.repository\.fork\s*\}\}/.test(withoutComments) &&
  /dependency-review-action@/.test(withoutComments);
const hasForkSubstitute =
  /if:\s*\$\{\{\s*github\.event\.repository\.fork\s*\}\}/.test(withoutComments) &&
  /\bnpm\s+audit\b/.test(withoutComments);
if (!hasUpstreamReview || !hasForkSubstitute) {
  throw new Error(
    "dependency-review.yml must keep dependency-review-action under if: !github.event.repository.fork and a fork job with if: github.event.repository.fork plus npm audit.",
  );
}

console.log(
  `Verified ${workflowNames.length} workflow files: immutable actions, explicit permissions, no unverified download commands, secret-scan without only-verified, fork-aware dependency-review.`,
);
