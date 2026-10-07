import { defineConfig } from 'vitest/config';

// Requires explicit synthetic input/output; never starts Android or touches a user's vault.
export default defineConfig({ test: {
  include: ['tests/interop/android317-project-removal-durable.interop.ts'],
  fileParallelism: false, maxWorkers: 1, testTimeout: 10 * 60_000,
} });
