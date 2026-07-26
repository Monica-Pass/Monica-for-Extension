import { build } from "esbuild";
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

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
  // The MDBX provider fetches this through `chrome.runtime.getURL()`. It must stay out of
  // `web_accessible_resources`, which `security-audit.mjs:20` pins to the logo alone.
  copyFile(resolve(root, "node_modules/sql.js/dist/sql-wasm.wasm"), resolve(root, "dist/sql-wasm.wasm")),
  build({
    entryPoints: [resolve(root, "src/background/index.ts")],
    outfile: resolve(root, "dist/background.js"),
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
    outfile: resolve(root, "dist/content.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome109",
    minify: true,
    legalComments: "none"
  }),
  build({
    entryPoints: [resolve(root, "src/passkey/main-world.ts")],
    outfile: resolve(root, "dist/main-world.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome109",
    minify: true,
    legalComments: "none"
  })
]);
