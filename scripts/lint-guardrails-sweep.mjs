// Removes leftover __guardrail_probe__* fixture directories created by
// scripts/lint-guardrails-audit.test.mjs. The fixtures contain banned tokens
// (localStorage/connectNative) under src/, so a run killed mid-test would
// otherwise brick `npm run lint` and `tsc -b` until they are removed. The sweep
// is non-fatal by design: it never throws, so wiring it ahead of eslint in the
// lint scripts cannot introduce a new failure mode.
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const probeRoots = ["src/background", "src/passkey", "src/content", "src/lib", "src/i18n", "src/manager"];

export async function sweepGuardrailFixtures() {
  for (const dir of probeRoots) {
    const entries = await readdir(resolve(root, dir)).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.startsWith("__guardrail_probe__"))
      .map((entry) => rm(join(root, dir, entry), { recursive: true, force: true }).catch(() => {})));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await sweepGuardrailFixtures();
}
