import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

/** Dedicated runner: never consumes Playwright's default browser fixture. */
test("Android 315 real Microsoft Edge surfaces, native messaging and locked restart", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const run = promisify(execFile);
  const { stdout, stderr } = await run(process.execPath, [path.resolve("scripts/interop-315-edge.mjs")], {
    cwd: path.resolve("."), env: process.env, windowsHide: true, maxBuffer: 4 * 1024 * 1024
  });
  await testInfo.attach("real-edge-runner", { body: stdout, contentType: "application/json" });
  if (stderr) await testInfo.attach("real-edge-stderr", { body: stderr, contentType: "text/plain" });
  const result = JSON.parse(stdout);
  expect(result.status).toBe("passed");
  expect(result.checks).toContain("real-action-popup");
  expect(result.checks).toContain("real-side-panel-ui-unlock");
  expect(result.checks).toContain("real-native-messaging");
  expect(result.checks).toContain("real-browser-restart-and-wrong-password-fail-closed");
});
