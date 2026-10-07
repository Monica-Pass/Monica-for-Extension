import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/interop/android315-edge-note-return.interop.ts'],fileParallelism:false,maxWorkers:1,testTimeout:60_000}});
