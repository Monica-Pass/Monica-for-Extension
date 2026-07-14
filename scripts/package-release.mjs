import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { zipSync } from "fflate";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const version = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version;
const entries = {};
for (const path of await readdir(dist, { recursive: true })) {
  const absolute = resolve(dist, path);
  try { entries[relative(dist, absolute).replaceAll("\\", "/")] = new Uint8Array(await readFile(absolute)); } catch { /* directory */ }
}
for (const required of ["manifest.json", "background.js", "content.js", "main-world.js", "index.html", "popup.html"]) if (!entries[required]) throw new Error(`Release is missing ${required}`);
const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
if (manifest.version !== version || manifest.manifest_version !== 3) throw new Error("Package and MV3 manifest versions do not match.");
await mkdir(resolve(root, "release"), { recursive: true });
const target = resolve(root, "release", `monica-extension-${version}.zip`);
await writeFile(target, zipSync(entries, { level: 9 }));
console.log(`Created ${target} with ${Object.keys(entries).length} files.`);
