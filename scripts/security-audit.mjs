import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "dist/manifest.json"), "utf8"));
const sourceManifest = JSON.parse(await readFile(resolve(root, "public/manifest.json"), "utf8"));
const scripts = ["background.js", "content.js", "main-world.js"];
const missing = scripts.filter((name) => !manifest.content_scripts?.some((entry) => entry.js?.includes(name)) && name !== "background.js");
if (missing.length || manifest.background?.service_worker !== "background.js") throw new Error(`Missing trusted extension scripts: ${missing.join(", ")}`);
if (!manifest.content_scripts.some((entry) => entry.world === "MAIN" && entry.js?.includes("main-world.js") && entry.run_at === "document_start")) throw new Error("MAIN-world Passkey bridge is not document_start.");
if (manifest.externally_connectable || manifest.optional_permissions || manifest.optional_host_permissions) throw new Error("Release manifest exposes an unexpected external or optional privilege surface.");
if (JSON.stringify(manifest.permissions) !== JSON.stringify(["alarms", "cookies", "nativeMessaging", "storage", "webNavigation"])) throw new Error("Release manifest permission set changed without a security review.");
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["http://*/*", "https://*/*"])) throw new Error("Release manifest host access changed without a security review.");
const csp = manifest.content_security_policy?.extension_pages || "";
for (const directive of ["script-src 'self' 'wasm-unsafe-eval'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
  if (!csp.includes(directive)) throw new Error(`Release CSP is missing: ${directive}`);
}
if (/unsafe-inline|(?<!wasm-)unsafe-eval/.test(csp)) throw new Error("Release CSP permits unsafe inline or JavaScript eval execution.");
const accessible = manifest.web_accessible_resources || [];
if (accessible.length !== 1 || JSON.stringify(accessible[0].resources) !== JSON.stringify(["icons/logo-256.png"]) || accessible[0].use_dynamic_url !== true) {
  throw new Error("Web-accessible resources are broader than the reviewed dynamic logo resource.");
}
if (JSON.stringify(sourceManifest) !== JSON.stringify(manifest)) throw new Error("Built manifest differs from the reviewed source manifest.");
const outputFiles = await readdir(resolve(root, "dist"), { recursive: true });
if (outputFiles.some((name) => String(name).endsWith(".map"))) throw new Error("Release output contains source maps.");
const forbidden = ["super-secret-value", "webdav-secret", "android-backup-secret", "passkey e2e master password", "localStorage", "sessionStorage"];
for (const name of scripts) {
  const source = await readFile(resolve(root, "dist", name), "utf8");
  for (const token of forbidden) if (source.includes(token)) throw new Error(`${name} contains forbidden token: ${token}`);
  // The release CSP is `script-src 'self' 'wasm-unsafe-eval'`, so any code-generation form a bundled
  // dependency drags in would fail at load rather than at review time.
  for (const form of ["new Function", "eval(", "importScripts"]) {
    if (source.includes(form)) throw new Error(`${name} contains a CSP-forbidden code-generation form: ${form}`);
  }
}
const background = await readFile(resolve(root, "dist/background.js"), "utf8");
if (!background.includes("TRUSTED_CONTEXTS")) throw new Error("Session storage is not restricted to trusted contexts.");
if (!background.includes("WEB_PAGE_REQUEST_TYPES") && !background.includes("CREDENTIAL_CAPTURE")) throw new Error("Background page-command allowlist is missing from the release.");
const backgroundSource = await readFile(resolve(root, "src/background/index.ts"), "utf8");
if (!backgroundSource.includes("if (!WEB_PAGE_REQUEST_TYPES.has(request.type)) assertExtensionPage(sender);")) throw new Error("Privileged runtime commands are not default-denied.");
if (!backgroundSource.includes('case "MDBX2_HOST_STATUS"') || backgroundSource.includes('case "MDBX_OPEN"')) throw new Error("MDBX Native Messaging review requires MDBX2-only privileged commands.");
const pageTypes = ["CREDENTIAL_CAPTURE", "CREDENTIAL_PENDING", "CREDENTIAL_ACCEPT", "CREDENTIAL_DISMISS", "PASSKEY_BEGIN", "PASSKEY_ACCEPT", "PASSKEY_DISMISS"];
const allowlistBlock = backgroundSource.match(/const WEB_PAGE_REQUEST_TYPES[\s\S]*?\]\);/)?.[0] || "";
for (const type of pageTypes) if (!allowlistBlock.includes(`"${type}"`)) throw new Error(`Page request allowlist is missing ${type}.`);
const messageSource = await readFile(resolve(root, "src/runtime/messages.ts"), "utf8");
const steamTypes = [...messageSource.matchAll(/type:\s*"(STEAM_[A-Z0-9_]+)"/g)].map((match) => match[1]);
for (const type of steamTypes) if (allowlistBlock.includes(`"${type}"`)) throw new Error(`Privileged Steam request ${type} is exposed to web pages.`);
const mdbx2Types = [...messageSource.matchAll(/type:\s*"(MDBX2_[A-Z0-9_]+)"/g)].map((match) => match[1]);
for (const type of mdbx2Types) {
  if (allowlistBlock.includes(`"${type}"`)) throw new Error(`Privileged MDBX2 request ${type} is exposed to web pages.`);
  const start = backgroundSource.indexOf(`case "${type}"`);
  if (start < 0 || !backgroundSource.slice(start, start + 500).includes("assertManagerPage(sender)")) throw new Error(`MDBX2 request ${type} is not restricted to the manager page.`);
}
if (!backgroundSource.includes('chrome.runtime.getURL("index.html")')) throw new Error("MDBX2 manager-page origin check is missing.");
if (
  !backgroundSource.includes("const mdbx2SyncCoordinator = new Mdbx2SyncCoordinator(mdbx2NativeClient);")
  || !backgroundSource.includes("const mdbx2Provider = new Mdbx2Provider(mdbx2NativeClient, mdbx2SyncCoordinator);")
  || !backgroundSource.includes("providers.register(mdbx2Provider);")
) {
  throw new Error("MDBX2 Provider is not registered through the reviewed Native Host client.");
}
if (!backgroundSource.includes("mdbx2Provider.lock();") || !backgroundSource.includes("mdbx2Provider.lockAccount(request.providerId);")) {
  throw new Error("MDBX2 decrypted compatibility caches are not cleared on lock and provider removal.");
}
for (const legacyType of ["MDBX_OPEN", "MDBX_STATUS", "MDBX_EXPORT_FILE", "MDBX_LOCK"]) {
  if (messageSource.includes(`"${legacyType}"`) || backgroundSource.includes(`"${legacyType}"`)) throw new Error(`Legacy MDBX1 runtime request remains exposed: ${legacyType}.`);
}
const steamRequestDeclarations = messageSource.split("\n").filter((line) => line.includes('type: "STEAM_'));
for (const field of ["accessToken", "refreshToken", "identitySecret", "sharedSecret", "steamLoginSecure"]) {
  if (steamRequestDeclarations.some((line) => line.includes(field))) throw new Error(`Steam runtime request exposes credential field: ${field}.`);
}
const revocationDeclaration = steamRequestDeclarations.find((line) => line.includes('"STEAM_REVOKE_AUTHORIZED_DEVICE"')) || "";
if (revocationDeclaration.includes("password") && !revocationDeclaration.includes("confirmed: true")) throw new Error("Steam revocation password request is missing explicit confirmation.");
for (const line of steamRequestDeclarations.filter((entry) => entry.includes("password") && !entry.includes('"STEAM_REVOKE_AUTHORIZED_DEVICE"'))) throw new Error(`Unexpected Steam password field: ${line}`);
const declaredTypes = [...messageSource.matchAll(/type:\s*"([A-Z0-9_]+)"/g)].map((match) => match[1]);
for (const type of new Set(declaredTypes)) if (!backgroundSource.includes(`case "${type}"`)) throw new Error(`Runtime request ${type} has no explicit background handler.`);
const contentSource = await readFile(resolve(root, "src/content/index.ts"), "utf8");
if (!contentSource.includes("sender.id !== chrome.runtime.id") || !contentSource.includes("isBoundedBridgeRequest")) throw new Error("Content-script message or Passkey bridge sender limits are missing.");
for (const name of ["content.js", "main-world.js"]) {
  const source = await readFile(resolve(root, "dist", name), "utf8");
  if (source.includes("com.monica_pass.mdbx2") || source.includes("connectNative")) throw new Error(`${name} contains a forbidden Native Messaging reference.`);
}
console.log("Security audit passed: encrypted/trusted runtime output contains no fixture secrets or source maps.");
