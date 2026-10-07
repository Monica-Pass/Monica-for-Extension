import { defineConfig } from 'vitest/config';

// Real Android-exported archives only. Each leg is selected explicitly by path.
export default defineConfig({ test: {
  include: ['tests/interop/android315-zip.interop.ts', 'tests/interop/android316-zip-return.interop.ts'],
  fileParallelism: false, maxWorkers: 1, testTimeout: 120_000
} });
