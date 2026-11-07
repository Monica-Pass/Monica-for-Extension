import { UNSUPPORTED_COMMAND_ERROR } from '../runtime/messages';
import type { ExtensionRequest } from '../runtime/messages';
import type { SecureVaultService } from '../security/secure-vault-service';
import type { ProviderOperationQueue } from './provider-operation-queue';
import { mdbxDirectWriteProvider } from './mdbx-direct-write';
import { assertExtensionPage, assertManagerPage, WEB_PAGE_REQUEST_TYPES } from './request-access';

export type CommandHandlers<R extends ExtensionRequest> = {
  [K in R['type']]: (request: Extract<R, { type: K }>, sender: chrome.runtime.MessageSender, nativeWriteLocked: boolean) => unknown;
};

/** Lookup preserves the request/handler discriminant relationship. Unknown
 * keys, including prototype properties, never select a handler. */
export function commandHandler<R extends ExtensionRequest>(handlers: CommandHandlers<R>, request: ExtensionRequest) {
  if (!Object.prototype.hasOwnProperty.call(handlers, request.type)) return undefined;
  return handlers[request.type as R['type']] as (request: R, sender: chrome.runtime.MessageSender, nativeWriteLocked: boolean) => unknown;
}

/** The aggregate table is checked against the complete request union. Unknown
 * messages still fail closed at runtime, before any handler is selected. */
export function createCommandDispatcher(handlers: CommandHandlers<ExtensionRequest>) {
  return function routeRequest(request: ExtensionRequest, sender: chrome.runtime.MessageSender, nativeWriteLocked: boolean): unknown {
    const handler = commandHandler(handlers, request);
    if (!handler) throw new Error(UNSUPPORTED_COMMAND_ERROR);
    return handler(request, sender, nativeWriteLocked);
  };
}

/** Both browser messages and internal attachment operations cross the same
 * authorization and native-write guard before invoking their domain handler. */
export function createCommandExecutor(
  service: Pick<SecureVaultService, 'getProvider' | 'assertNoBitwardenMdbxMove' | 'assertNoNearbyNativeSequence'>,
  providerOperations: ProviderOperationQueue
) {
  return async function execute<R extends ExtensionRequest>(
    request: R, sender: chrome.runtime.MessageSender,
    handler: (request: R, sender: chrome.runtime.MessageSender, nativeWriteLocked: boolean) => unknown
  ): Promise<unknown> {
    if (!WEB_PAGE_REQUEST_TYPES.has(request.type)) assertExtensionPage(sender);
    const nativeProvider = mdbxDirectWriteProvider(request);
    if (nativeProvider && (await service.getProvider(nativeProvider))?.kind === 'mdbx2') {
      assertManagerPage(sender);
      return providerOperations.run(nativeProvider, async () => {
        await service.assertNoBitwardenMdbxMove(nativeProvider);
        await service.assertNoNearbyNativeSequence(nativeProvider);
        return handler(request, sender, true);
      });
    }
    return handler(request, sender, false);
  };
}

export type CommandExecutor = ReturnType<typeof createCommandExecutor>;
