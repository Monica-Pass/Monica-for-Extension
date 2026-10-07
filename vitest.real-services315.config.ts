import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/interop/real-services315*.interop.ts"], fileParallelism: false, maxWorkers: 1, testTimeout: 120000, hookTimeout: 120000 } });
