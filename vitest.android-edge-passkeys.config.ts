import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/interop/android317-edge-passkey-return.interop.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 120000 } });
