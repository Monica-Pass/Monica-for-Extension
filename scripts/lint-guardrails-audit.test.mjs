// Negative self-test for the source-level guardrails in eslint.config.mjs.
// scripts/security-audit.mjs only backstops the built dist bundles; these tests
// prove the lint rules themselves still fire (glob rot, a dropped rule on an
// ESLint upgrade, or a scope mistake would otherwise pass silently).
// Fixtures must be REAL files under src/ because the config matches by path and
// ESLint only applies project rules to files that exist on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ESLint } from "eslint";
import { sweepGuardrailFixtures } from "./lint-guardrails-sweep.mjs";

const root = resolve(import.meta.dirname, "..");

// Self-heal: a previously crashed or killed run may have left __guardrail_probe__*
// fixture directories behind (they contain banned tokens and would fail the lint
// hard gate and tsc until manually removed). The same sweep also runs ahead of
// eslint in the lint npm scripts via scripts/lint-guardrails-sweep.mjs.
await sweepGuardrailFixtures();

async function withFixture(relativeDir, fileName, code, run) {
  const dir = await mkdtemp(join(root, relativeDir, "__guardrail_probe__"));
  try {
    const file = join(dir, fileName);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${code}\n`, "utf8");
    return await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function lintFile(file) {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintFiles([file]);
  return result.messages;
}

test("storage ban fires for the global in the trusted background graph", async () => {
  const messages = await withFixture("src/background", "fixture.ts", 'const value = localStorage.getItem("k");', lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-globals"), `expected no-restricted-globals, got: ${JSON.stringify(messages)}`);
});

test("storage ban fires for member access (window.localStorage) in the background graph", async () => {
  const messages = await withFixture("src/background", "fixture.ts", 'const value = window.localStorage.getItem("k");', lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-syntax"), `expected no-restricted-syntax, got: ${JSON.stringify(messages)}`);
});

test("importScripts ban fires in the trusted background graph", async () => {
  const messages = await withFixture("src/background", "fixture.ts", 'importScripts("worker.js");', lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-globals"), `expected no-restricted-globals, got: ${JSON.stringify(messages)}`);
});

test("storage ban covers src/passkey, which dist/background.js and dist/content.js bundle", async () => {
  const messages = await withFixture("src/passkey", "fixture.ts", 'sessionStorage.setItem("k", "v");', lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-globals"), `expected no-restricted-globals, got: ${JSON.stringify(messages)}`);
});

test("connectNative ban fires in src/content", async () => {
  const messages = await withFixture("src/content", "fixture.ts", 'chrome.runtime.connectNative("com.monica_pass.mdbx2");', lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-syntax"), `expected no-restricted-syntax, got: ${JSON.stringify(messages)}`);
});

test("connectNative ban fires through a receiver alias (window.chrome.runtime)", async () => {
  const messages = await withFixture("src/content", "fixture.ts", 'window.chrome.runtime.connectNative("com.monica_pass.mdbx2");', lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-syntax"), `expected no-restricted-syntax, got: ${JSON.stringify(messages)}`);
});

test("legitimate chrome.runtime.sendMessage stays allowed in src/content", async () => {
  const messages = await withFixture("src/content", "fixture.ts", "void chrome.runtime.sendMessage({});", lintFile);
  const restricted = messages.filter((m) => m.ruleId === "no-restricted-syntax");
  assert.equal(restricted.length, 0, `connectNative ban must not fire on sendMessage: ${JSON.stringify(restricted)}`);
});

test("storage ban fires for computed member access (globalThis[\"localStorage\"]) in the background graph", async () => {
  const messages = await withFixture("src/background", "fixture.ts", 'const value = globalThis["localStorage"].getItem("k");', lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-syntax"), `expected no-restricted-syntax, got: ${JSON.stringify(messages)}`);
});

test("storage ban fires for a destructuring alias (const { localStorage } = globalThis) in the background graph", async () => {
  const messages = await withFixture("src/background", "fixture.ts", "const { localStorage } = globalThis;\nvoid localStorage;", lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-syntax"), `expected no-restricted-syntax (Property selector), got: ${JSON.stringify(messages)}`);
});

test("importScripts ban fires for member access (self.importScripts) in the background graph", async () => {
  const messages = await withFixture("src/background", "fixture.ts", 'self.importScripts("worker.js");', lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-syntax"), `expected no-restricted-syntax, got: ${JSON.stringify(messages)}`);
});

test("connectNative ban fires for computed access in src/content", async () => {
  const messages = await withFixture("src/content", "fixture.ts", 'void chrome.runtime["connectNative"]("com.monica_pass.mdbx2");', lintFile);
  assert.ok(messages.some((m) => m.ruleId === "no-restricted-syntax"), `expected no-restricted-syntax, got: ${JSON.stringify(messages)}`);
});

test("fail-closed scope: an unclassified src directory (src/manager) is inside the ban", async () => {
  const messages = await withFixture("src/manager", "fixture.ts", 'const value = localStorage.getItem("k");', lintFile);
  assert.ok(
    messages.some((m) => m.ruleId === "no-restricted-globals" || m.ruleId === "no-restricted-syntax"),
    `fail-closed ban must fire for directories not on the exemption list: ${JSON.stringify(messages)}`
  );
});

test("scope boundary: src/lib stays outside the storage ban", async () => {
  const messages = await withFixture("src/lib", "fixture.ts", 'const value = localStorage.getItem("k");', lintFile);
  const banned = messages.filter((m) => m.ruleId === "no-restricted-globals" || m.ruleId === "no-restricted-syntax");
  assert.equal(banned.length, 0, `storage ban must not fire outside the trusted graph: ${JSON.stringify(banned)}`);
});

test("scope boundary: src/i18n/index.ts locale persistence stays exempt", async () => {
  // The exemption is the specific file (its directory is NOT exempt — a new file
  // under src/i18n/ is inside the fail-closed ban, verified by the manager test).
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintFiles(["src/i18n/index.ts"]);
  const banned = result.messages.filter((m) => m.ruleId === "no-restricted-globals" || m.ruleId === "no-restricted-syntax");
  assert.equal(banned.length, 0, `locale persistence in src/i18n/index.ts is an exempt UI surface: ${JSON.stringify(banned)}`);
});
