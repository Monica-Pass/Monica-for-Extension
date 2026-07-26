import { build } from "esbuild";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

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
