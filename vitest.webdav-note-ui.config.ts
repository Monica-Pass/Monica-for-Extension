import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['tests/interop/webdav-note-ui.interop.ts'],fileParallelism:false,maxWorkers:1,testTimeout:60_000}});
