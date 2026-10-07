import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['tests/interop/android317-removed-project-return.interop.ts'],fileParallelism:false,maxWorkers:1,testTimeout:120000}});
