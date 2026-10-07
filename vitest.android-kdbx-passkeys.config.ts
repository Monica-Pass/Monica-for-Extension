import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/interop/android317-kdbx-passkeys.interop.ts"], testTimeout: 60_000 } });
