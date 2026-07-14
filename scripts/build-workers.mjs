import { build } from "esbuild";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

await Promise.all([
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
  })
]);
