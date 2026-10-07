import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/interop/passkey-file-counters.interop.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 120000 } });
