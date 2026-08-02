import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/interop/**/*.interop.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 20 * 60_000,
    hookTimeout: 20 * 60_000
  }
});
