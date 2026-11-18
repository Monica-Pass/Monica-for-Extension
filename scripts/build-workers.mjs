import { build } from "esbuild";
import { readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from 'node:child_process';
import { browserDependencyNotices } from './mdbx2-browser-licenses.mjs';

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, process.env.MONICA_BUILD_OUT_DIR || 'dist');
execFileSync(process.execPath, ['scripts/build-nearby-setup.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
// Never ship missing, stale or unverified native-format browser code. Build the
// pinned package with build:mdbx2-browser when updating the engine sources.
execFileSync(process.execPath, ['scripts/verify-mdbx2-browser.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true });
await mkdir(resolve(output, 'mdbx-browser'), { recursive: true });
for (const file of ['engine.js', 'monica_mdbx2_browser.wasm', 'BROWSER-BUILD.json']) {
  await copyFile(resolve(root, 'native/mdbx2-browser/pkg', file), resolve(output, 'mdbx-browser', file));
}
await writeFile(resolve(output, 'mdbx-browser/THIRD-PARTY-NOTICES.json'), JSON.stringify(await browserDependencyNotices(root), null, 2) + '\n');

/**
 * kdbxweb's UMD wrapper requires Node's `crypto` and `@xmldom/xmldom` unconditionally. `crypto` is
 * aliased away because kdbxweb only falls back to it when WebCrypto is missing, which never happens
 * here. `@xmldom/xmldom` is bundled for real: an MV3 service worker has no global `DOMParser` or
 * `XMLSerializer`, so it is the only way the KDBX inner XML can be parsed and re-serialised.
 */
const kdbxwebAlias = { crypto: resolve(root, "scripts/stubs/node-crypto.js") };

/**
 * kdbxweb's webpack bootstrap resolves the global object as
 * `if (typeof globalThis === 'object') return globalThis; try { return this || new Function(...)() }`.
 * The fallback is unreachable on every browser this extension targets, but `new Function` is still
 * code generation, which the release CSP (`script-src 'self' 'wasm-unsafe-eval'`) refuses to load.
 * It is rewritten to a plain `globalThis` reference so the shipped worker contains no eval form.
 */
const stripKdbxwebEvalFallback = {
  name: "strip-kdbxweb-eval-fallback",
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /kdbxweb[\\/]dist[\\/]kdbxweb\.js$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const original = "new Function('return this')()";
      if (!source.includes(original)) throw new Error("kdbxweb no longer contains the expected eval fallback; re-check the bootstrap.");
      return { contents: source.replaceAll(original, "globalThis"), loader: "js" };
    });
  }
};

await Promise.all([
  build({ entryPoints: [resolve(root, 'src/providers/mdbx2/browser/offscreen.ts')], outfile: resolve(output, 'mdbx-browser/offscreen.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome128', minify: true, legalComments: 'none' }),
  build({ entryPoints: [resolve(root, 'src/providers/mdbx2/browser/engine-worker.ts')], outfile: resolve(output, 'mdbx-browser/engine-worker.js'), bundle: true, format: 'esm', platform: 'browser', target: 'chrome128', external: ['./engine.js'], minify: true, legalComments: 'none' }),
  build({
    entryPoints: [resolve(root, "src/background/index.ts")],
    outfile: resolve(output, "background.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome109",
    alias: kdbxwebAlias,
    plugins: [stripKdbxwebEvalFallback],
    minify: true,
    legalComments: "none"
  }),
  build({
    entryPoints: [resolve(root, "src/content/index.ts")],
    outfile: resolve(output, "content.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome109",
    minify: true,
    legalComments: "none"
  }),
  build({
    entryPoints: [resolve(root, "src/passkey/main-world.ts")],
    outfile: resolve(output, "main-world.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome109",
    minify: true,
    legalComments: "none"
  })
]);
