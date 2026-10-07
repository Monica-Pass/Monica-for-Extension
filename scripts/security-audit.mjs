import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "dist/manifest.json"), "utf8"));
const sourceManifest = JSON.parse(await readFile(resolve(root, "public/manifest.json"), "utf8"));
const scripts = ["background.js", "content.js", "main-world.js"];
const missing = scripts.filter((name) => !manifest.content_scripts?.some((entry) => entry.js?.includes(name)) && name !== "background.js");
if (missing.length || manifest.background?.service_worker !== "background.js") throw new Error(`Missing trusted extension scripts: ${missing.join(", ")}`);
if (!manifest.content_scripts.some((entry) => entry.world === "MAIN" && entry.js?.includes("main-world.js") && entry.run_at === "document_start")) throw new Error("MAIN-world Passkey bridge is not document_start.");
if (manifest.externally_connectable || manifest.optional_permissions || manifest.optional_host_permissions) throw new Error("Release manifest exposes an unexpected external or optional privilege surface.");
// favicon reads the browser's local icon cache in extension pages only; the
// _favicon endpoint remains absent from web-accessible resources below.
// sidePanel reuses the same trusted manager path and locked session; opening is an
// explicit popup click and does not grant a webpage access to the manager.
if (JSON.stringify(manifest.permissions) !== JSON.stringify(["alarms", "cookies", "favicon", "identity", "nativeMessaging", "sidePanel", "storage", "webNavigation"])) throw new Error("Release manifest permission set changed without a security review.");
if (manifest.side_panel?.default_path !== "index.html?surface=sidepanel" || manifest.action?.default_popup !== "popup.html") throw new Error("Side panel must reuse the reviewed manager without replacing the action popup.");
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["http://*/*", "https://*/*"])) throw new Error("Release manifest host access changed without a security review.");
const csp = manifest.content_security_policy?.extension_pages || "";
for (const directive of ["script-src 'self' 'wasm-unsafe-eval'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
  if (!csp.includes(directive)) throw new Error(`Release CSP is missing: ${directive}`);
}
if (/unsafe-inline|(?<!wasm-)unsafe-eval/.test(csp)) throw new Error("Release CSP permits unsafe inline or JavaScript eval execution.");
const accessible = manifest.web_accessible_resources || [];
const localeResources = ["ja", "ko", "de", "es", "ru", "vi"].map((locale) => `locales/ui-${locale}.json`);
if (accessible.length !== 1 || JSON.stringify(accessible[0].resources) !== JSON.stringify(["icons/logo-256.png", ...localeResources]) || accessible[0].use_dynamic_url !== true) {
  throw new Error("Web-accessible resources are broader than the reviewed logo and offline language catalogs.");
}
// These public JSON resources contain UI text only. They cannot add executable code,
// vault data, or an open-ended resource path to the content-script surface.
const catalogKeys = Object.keys(JSON.parse(await readFile(resolve(root, "src/i18n/ui-en.json"), "utf8"))).sort();
for (const resource of localeResources) {
  const catalog = JSON.parse(await readFile(resolve(root, "dist", resource), "utf8"));
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)
      || JSON.stringify(Object.keys(catalog).sort()) !== JSON.stringify(catalogKeys)
      || Object.values(catalog).some((value) => typeof value !== "string")) throw new Error(`Invalid public UI catalog: ${resource}`);
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
  // SignalR's platform detector checks whether the worker has this property.
  // Exempt only that exact read-only probe, retaining the ban on all imports,
  // property accesses/aliases and dynamically loaded worker code.
  const executableSource = source.replaceAll('"importScripts"in self', 'false');
  for (const form of ["new Function", "eval(", "importScripts"]) {
    if (executableSource.includes(form)) throw new Error(`${name} contains a CSP-forbidden code-generation form: ${form}`);
  }
}
const background = await readFile(resolve(root, "dist/background.js"), "utf8");
if (!background.includes("TRUSTED_CONTEXTS")) throw new Error("Session storage is not restricted to trusted contexts.");
if (!background.includes("WEB_PAGE_REQUEST_TYPES") && !background.includes("CREDENTIAL_CAPTURE")) throw new Error("Background page-command allowlist is missing from the release.");
const backgroundSource = await readFile(resolve(root, "src/background/index.ts"), "utf8");
if (!backgroundSource.includes("if (!WEB_PAGE_REQUEST_TYPES.has(request.type)) assertExtensionPage(sender);")) throw new Error("Privileged runtime commands are not default-denied.");
if (!backgroundSource.includes('case "MDBX2_HOST_STATUS"') || backgroundSource.includes('case "MDBX_OPEN"')) throw new Error("MDBX Native Messaging review requires MDBX2-only privileged commands.");
const pageTypes = ["CREDENTIAL_CAPTURE", "CREDENTIAL_PENDING", "CREDENTIAL_ACCEPT", "CREDENTIAL_DISMISS", "PASSKEY_BEGIN", "PASSKEY_UNLOCK_CONTINUE", "PASSKEY_ACCEPT", "PASSKEY_DISMISS"];
const allowlistBlock = backgroundSource.match(/const WEB_PAGE_REQUEST_TYPES[\s\S]*?\]\);/)?.[0] || "";
for (const type of pageTypes) if (!allowlistBlock.includes(`"${type}"`)) throw new Error(`Page request allowlist is missing ${type}.`);
const messageSource = await readFile(resolve(root, "src/runtime/messages.ts"), "utf8");
// Parse declarations and switch clauses so quote style cannot silently exclude
// new privileged commands or turn a real handler into a false missing-handler error.
const messageAst = ts.createSourceFile('messages.ts', messageSource, ts.ScriptTarget.Latest, true);
const backgroundAst = ts.createSourceFile('background.ts', backgroundSource, ts.ScriptTarget.Latest, true);
const declaredTypes = new Set(), handlers = new Map();
for (const node of messageAst.statements) {
  if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'ExtensionRequest' || !ts.isUnionTypeNode(node.type)) continue;
  for (const variant of node.type.types) {
    if (!ts.isTypeLiteralNode(variant)) continue;
    for (const member of variant.members) {
      if (ts.isPropertySignature(member) && member.name.getText(messageAst) === 'type'
        && member.type && ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)) declaredTypes.add(member.type.literal.text);
    }
  }
}
const requestHandler = backgroundAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleRequest');
const dispatch = requestHandler?.body?.statements.find(node => ts.isSwitchStatement(node) && node.expression.getText(backgroundAst) === 'request.type');
for (const clause of dispatch?.caseBlock.clauses || []) {
  if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) handlers.set(clause.expression.text, clause.statements.map(node=>node.getText(backgroundAst)).join('\n'));
}
if (!declaredTypes.size || !handlers.size) throw new Error('Runtime command declaration/dispatch audit could not be parsed.');
for (const type of declaredTypes) if (!handlers.has(type)) throw new Error(`Runtime request ${type} has no explicit background handler.`);
const projectCommands = [...declaredTypes].filter(type=>type.startsWith('VAULT_PASSWORD_PROJECT_') || type.startsWith('VAULT_KEEPASS_PROJECT_'));
for (const type of projectCommands) {
  if (new RegExp(`["']${type}["']`).test(allowlistBlock) || !handlers.get(type).includes('assertManagerPage(sender)'))
    throw new Error(`Password project request ${type} is not restricted to the manager page.`);
}
for (const type of ['VAULT_PASSWORD_PROJECT_REMOVE', 'VAULT_PASSWORD_PROJECT_RESTORE', 'VAULT_KEEPASS_PROJECT_REMOVE', 'VAULT_KEEPASS_PROJECT_RESOLVE', 'VAULT_KEEPASS_PROJECT_RECOVERY_DELETE']) {
  if (!handlers.get(type)?.includes('request.confirmed !== true')) throw new Error(`Password project request ${type} lacks explicit confirmation.`);
}
for (const type of ["PASSKEY_VERIFICATION_CONTEXT", "PASSKEY_VERIFY_PASSWORD", "PASSKEY_VERIFY_HELLO", "PASSKEY_CANCEL_VERIFICATION"]) {
  if (allowlistBlock.includes(`"${type}"`)) throw new Error(`Passkey identity verification request ${type} is exposed to web pages.`);
  if (!backgroundSource.includes(`case "${type}"`)) throw new Error(`Passkey identity verification handler ${type} is missing.`);
}
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
const contentSource = await readFile(resolve(root, "src/content/index.ts"), "utf8");
if (!contentSource.includes("sender.id !== chrome.runtime.id") || !contentSource.includes("isBoundedBridgeRequest")) throw new Error("Content-script message or Passkey bridge sender limits are missing.");
for (const name of ["content.js", "main-world.js"]) {
  const source = await readFile(resolve(root, "dist", name), "utf8");
  if (source.includes("com.monica_pass.mdbx2") || source.includes("connectNative")) throw new Error(`${name} contains a forbidden Native Messaging reference.`);
}
console.log("Security audit passed: encrypted/trusted runtime output contains no fixture secrets or source maps.");
console.log(`Parsed ${declaredTypes.size} runtime commands, including ${projectCommands.length} manager-only password project commands.`);
