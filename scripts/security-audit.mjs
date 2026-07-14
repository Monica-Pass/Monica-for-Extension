import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "dist/manifest.json"), "utf8"));
const scripts = ["background.js", "content.js", "main-world.js"];
const missing = scripts.filter((name) => !manifest.content_scripts?.some((entry) => entry.js?.includes(name)) && name !== "background.js");
if (missing.length || manifest.background?.service_worker !== "background.js") throw new Error(`Missing trusted extension scripts: ${missing.join(", ")}`);
if (!manifest.content_scripts.some((entry) => entry.world === "MAIN" && entry.js?.includes("main-world.js") && entry.run_at === "document_start")) throw new Error("MAIN-world Passkey bridge is not document_start.");
const outputFiles = await readdir(resolve(root, "dist"), { recursive: true });
if (outputFiles.some((name) => String(name).endsWith(".map"))) throw new Error("Release output contains source maps.");
const forbidden = ["super-secret-value", "webdav-secret", "android-backup-secret", "passkey e2e master password", "localStorage", "sessionStorage"];
for (const name of scripts) {
  const source = await readFile(resolve(root, "dist", name), "utf8");
  for (const token of forbidden) if (source.includes(token)) throw new Error(`${name} contains forbidden token: ${token}`);
}
const background = await readFile(resolve(root, "dist/background.js"), "utf8");
if (!background.includes("TRUSTED_CONTEXTS")) throw new Error("Session storage is not restricted to trusted contexts.");
console.log("Security audit passed: encrypted/trusted runtime output contains no fixture secrets or source maps.");
