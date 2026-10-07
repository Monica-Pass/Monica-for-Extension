import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/interop/passkey-webdav-counters.interop.ts"], maxWorkers: 1, fileParallelism: false, testTimeout: 90000 } });
