import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { auditRuntimeCommands, readRuntimeAuditSources } from './runtime-command-audit.mjs';
const sources = await readRuntimeAuditSources(fileURLToPath(new URL('..', import.meta.url)));

test('all declared commands have exactly one wired handler', () => {
  const result = auditRuntimeCommands(sources);
  assert.equal(result.handlers.size, result.declaredTypes.size);
  assert.equal(result.handlers.size, 233);
  assert.equal(result.wiredModules.size, 18);
});

for (const [name, key, before, after] of [
  ['default denial', 'executor', 'assertExtensionPage(sender);', 'void sender;'],
  ['entry invocation', 'entry', 'startBackground();', 'void 0;'],
  ['native classification', 'executor', 'mdbxDirectWriteProvider(request)', 'undefined'],
  ['native condition', 'executor', 'if (nativeProvider &&', 'if (false && nativeProvider &&'],
  ['manager authentication', 'access', 'assertTrustedManagerPage(sender, chrome.runtime.id, `${extensionRoot}/`);', 'if (false) assertTrustedManagerPage(sender, chrome.runtime.id, `${extensionRoot}/`);'],
  ['extension authentication', 'access', 'assertTrustedExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""));', 'void sender;'],
  ['native move recovery guard', 'executor', 'await service.assertNoBitwardenMdbxMove(nativeProvider);', 'void nativeProvider;'],
  ['native nearby recovery guard', 'executor', 'await service.assertNoNearbyNativeSequence(nativeProvider);', 'void nativeProvider;'],
  ['native ownership', 'executor', 'handler(request, sender, true)', 'handler(request, sender, false)'],
  ['dispatcher ownership', 'executor', 'handler(request, sender, nativeWriteLocked)', 'handler(request, sender, false)'],
  ['aggregate selection', 'composition', 'createCommandDispatcher(handlers)', 'createCommandDispatcher(otherHandlers)'],
  ['aggregate coverage', 'composition', '...credentialRuntime.handlers,', ''],
  ['aggregate duplicate', 'composition', '...credentialRuntime.handlers,', '...credentialRuntime.handlers, ...credentialRuntime.handlers,'],
  ['handler construction', 'composition', 'createCredentialRuntime({', 'createUncalledCredentialRuntime({'],
  ['browser handler wiring', 'composition', 'handleRequest,', 'handleRequest: unguarded,'],
  ['browser execution', './events', 'deps.handleRequest(message, sender)', 'unguarded(message, sender)'],
  ['lifecycle function wiring', 'composition', 'clearPendingPasskeyRequests: passkeyRuntime.clearPendingPasskeyRequests', 'clearPendingPasskeyRequests: async () => undefined'],
  ['navigation cancellation', 'composition', 'chrome.webNavigation.onCommitted.addListener(passkeyRuntime.navigationCommitted);', ''],
  ['tab cancellation', 'composition', 'chrome.tabs.onRemoved.addListener(passkeyRuntime.tabRemoved);', ''],
  ['session cancellation', './events', "deps.nearbyOwner.close('session-changed');", 'void 0;'],
  ['manager restriction', './attachment-runtime', 'assertManagerPage(sender);', 'void sender;'],
  ['synchronization manager restriction', './provider-sync-runtime', 'assertManagerPage(sender);', 'void sender;'],
  ['manager import', './credential-runtime', "from './request-access'", "from './unsafe-access'"],
  ['deletion confirmation', './attachment-runtime', 'request.confirmed !== true', 'false'],
  ['internal write executor', './attachment-runtime', 'return executeCommand(request, sender, handler);', 'return handler(request, sender, false);'],
  ['factory return', './credential-runtime', 'clearPendingUsernameContexts, handlers', 'clearPendingUsernameContexts, unrelatedHandlers'],
  ['command coverage', './attachment-runtime', '"PROVIDER_ATTACHMENT_LIST":', '"REMOVED_ATTACHMENT_LIST":'],
  ['duplicate command', './attachment-runtime', '"PROVIDER_ATTACHMENT_LIST":', '"PROVIDER_ATTACHMENT_READ_BEGIN":']
]) {
  test(`fails closed when ${name} is removed, even with the old correct code in a dead function`, () => {
    const original = key.startsWith('./') ? sources.modules[key] : sources[key];
    assert.ok(original.includes(before), `fixture missing ${before}`);
    const changed = original.replace(before, after) + `\nfunction unusedCorrectCode() { /* ${before} */ }\n`;
    const broken = key.startsWith('./') ? { ...sources, modules: { ...sources.modules, [key]: changed } } : { ...sources, [key]: changed };
    assert.throws(() => auditRuntimeCommands(broken));
  });
}
