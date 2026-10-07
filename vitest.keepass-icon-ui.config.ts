import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['tests/interop/keepass-icon-ui.interop.ts'],maxWorkers:1,testTimeout:60000}});
