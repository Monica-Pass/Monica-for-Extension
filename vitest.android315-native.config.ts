import { defineConfig } from "vitest/config";

// Explicit fixture-only runner: never starts an emulator or creates fallback data.
export default defineConfig({ test: {
  // SSO proof is scoped to actual Native metadata persistence, not Android relationships.
  include: ["tests/interop/android315-sso-move.interop.ts", "tests/interop/android315-sso-copy.interop.ts", "tests/interop/android315-sso-native.interop.ts", "tests/interop/android315-linked-move.interop.ts", "tests/interop/android315-moved-attachment-return.interop.ts", "tests/interop/android315-attachment-proof.interop.ts", "tests/interop/android315-vault-identity.interop.ts", "tests/interop/android315-source-delete.interop.ts", "tests/interop/android315-native-process.interop.ts", "tests/interop/android315-local-export.interop.ts", "tests/interop/android315-content-return.interop.ts", "tests/interop/android315-note-return.interop.ts"],
  fileParallelism: false, maxWorkers: 1, testTimeout: 10 * 60_000
} });
