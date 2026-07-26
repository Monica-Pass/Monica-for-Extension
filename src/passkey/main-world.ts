import { OPEN_SHADOW_ROOT_EVENT } from "../content/shadow-bridge";
import { shouldInterceptPasskeyCreate, shouldInterceptPasskeyGet } from "./interception-policy";

const PAGE_SOURCE = "monica-passkey-page";
const EXTENSION_SOURCE = "monica-passkey-extension";

const attachShadowDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
const currentAttachShadow = attachShadowDescriptor?.value as (this: Element, init: ShadowRootInit) => ShadowRoot;
if (currentAttachShadow && !(currentAttachShadow as typeof currentAttachShadow & { __monicaShadowBridge?: boolean }).__monicaShadowBridge) {
  const bridgedAttachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = currentAttachShadow.call(this, init);
    if (init.mode === "open") this.dispatchEvent(new CustomEvent(OPEN_SHADOW_ROOT_EVENT, { bubbles: true, composed: true }));
    return root;
  };
  Object.defineProperty(bridgedAttachShadow, "__monicaShadowBridge", { value: true });
  Object.defineProperty(Element.prototype, "attachShadow", { ...attachShadowDescriptor, value: bridgedAttachShadow });
}

if (navigator.credentials && !(navigator.credentials as CredentialsContainer & { __monicaPasskey?: boolean }).__monicaPasskey) {
  const credentials = navigator.credentials as CredentialsContainer & { __monicaPasskey?: boolean };
  const nativeCreate = credentials.create.bind(credentials);
  const nativeGet = credentials.get.bind(credentials);
  Object.defineProperty(credentials, "__monicaPasskey", { value: true });
  Object.defineProperty(credentials, "create", { configurable: true, value: async (options?: CredentialCreationOptions) => {
    if (!options?.publicKey) return nativeCreate(options);
    const pk = options.publicKey;
    const selection = pk.authenticatorSelection;
    const extensionNames = Object.keys(pk.extensions || {});
    if (!shouldInterceptPasskeyCreate({
      topLevel: window.top === window,
      authenticatorAttachment: selection?.authenticatorAttachment,
      userVerification: selection?.userVerification,
      extensionNames,
      algorithms: pk.pubKeyCredParams.map((param) => param.alg)
    })) return nativeCreate(options);
    try {
      const result = await bridge({
        operation: "create", challenge: encode(pk.challenge), rpId: pk.rp.id, rpName: pk.rp.name,
        userId: encode(pk.user.id), userName: pk.user.name, userDisplayName: pk.user.displayName,
        algorithms: pk.pubKeyCredParams.map((param) => param.alg), excludeCredentialIds: (pk.excludeCredentials || []).map((item) => encode(item.id)),
        discoverable: selection?.residentKey === "required" || selection?.residentKey === "preferred" || selection?.requireResidentKey === true,
        userVerificationRequired: selection?.userVerification === "required", credProps: Boolean(pk.extensions?.credProps), timeoutMs: normalizeTimeout(pk.timeout)
      }, normalizeTimeout(pk.timeout), (options as CredentialCreationOptions & { signal?: AbortSignal }).signal);
      return publicKeyCredential(result);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotSupportedError") return nativeCreate(options);
      throw error;
    }
  } });
  Object.defineProperty(credentials, "get", { configurable: true, value: async (options?: CredentialRequestOptions) => {
    if (!options?.publicKey) return nativeGet(options);
    const pk = options.publicKey;
    const mediation = (options as CredentialRequestOptions & { mediation?: CredentialMediationRequirement }).mediation;
    const allow = pk.allowCredentials || [];
    const externalOnly = allow.length > 0 && allow.every((item) => item.transports?.length && !item.transports.some((transport) => transport === "internal" || transport === "hybrid"));
    if (!shouldInterceptPasskeyGet({
      topLevel: window.top === window,
      mediation,
      userVerification: pk.userVerification,
      extensionNames: Object.keys(pk.extensions || {}),
      externalOnly
    })) return nativeGet(options);
    try {
      const result = await bridge({ operation: "get", challenge: encode(pk.challenge), rpId: pk.rpId, allowCredentialIds: allow.map((item) => encode(item.id)), userVerification: pk.userVerification, timeoutMs: normalizeTimeout(pk.timeout) }, normalizeTimeout(pk.timeout), (options as CredentialRequestOptions & { signal?: AbortSignal }).signal);
      return publicKeyCredential(result);
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotSupportedError") return nativeGet(options);
      throw error;
    }
  } });
}

function bridge(request: Record<string, unknown>, timeoutMs = 120_000, signal?: AbortSignal): Promise<Record<string, any>> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancellationRequested = false;
    let cancellationMessage = "Passkey 请求已取消。";
    let cancellationName = "NotAllowedError";
    let timeout = 0;
    let acknowledgementTimeout = 0;
    let acknowledgementFallback = 0;
    let terminalWatchdog = 0;
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.clearTimeout(acknowledgementTimeout);
      window.clearTimeout(acknowledgementFallback);
      window.clearTimeout(terminalWatchdog);
      window.removeEventListener("message", listener);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (message: string, name: string) => { if (settled) return; settled = true; cleanup(); reject(new DOMException(message, name)); };
    const requestCancellation = (message: string, name: string) => {
      if (settled || cancellationRequested) return;
      cancellationRequested = true;
      cancellationMessage = message;
      cancellationName = name;
      window.clearTimeout(timeout);
      terminalWatchdog = window.setTimeout(() => fail(cancellationMessage, cancellationName), 5 * 60_000);
      window.postMessage({ source: "monica-passkey-page-cancel", requestId, message, name }, location.origin);
    };
    const listener = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== EXTENSION_SOURCE || event.data?.requestId !== requestId) return;
      if (event.data.ack === true) {
        window.clearTimeout(acknowledgementTimeout);
        window.clearTimeout(acknowledgementFallback);
        return;
      }
      if (settled) return; settled = true; cleanup();
      if (event.data.error) reject(new DOMException(event.data.error, event.data.name || "NotAllowedError")); else resolve(event.data.result);
    };
    const abort = () => requestCancellation("Passkey 请求已中止。", "AbortError");
    if (signal?.aborted) return fail("Passkey 请求已中止。", "AbortError");
    signal?.addEventListener("abort", abort, { once: true });
    window.addEventListener("message", listener);
    timeout = window.setTimeout(() => requestCancellation("Monica Passkey 请求超时。", "NotAllowedError"), timeoutMs);
    acknowledgementTimeout = window.setTimeout(() => {
      requestCancellation("Monica Passkey 通道没有响应。", "NotAllowedError");
      acknowledgementFallback = window.setTimeout(() => fail(cancellationMessage, cancellationName), 1_000);
    }, 750);
    window.postMessage({ source: PAGE_SOURCE, requestId, request }, location.origin);
  });
}

function normalizeTimeout(value?: number): number {
  return Number.isFinite(value) ? Math.max(1_000, Math.min(120_000, Math.trunc(value!))) : 120_000;
}

function publicKeyCredential(result: Record<string, any>): Credential {
  const responseData = result.response;
  const responsePrototype = result.operation === "create" ? window.AuthenticatorAttestationResponse?.prototype : window.AuthenticatorAssertionResponse?.prototype;
  const response = Object.create(responsePrototype || Object.prototype);
  const binaryFields = result.operation === "create" ? ["clientDataJSON", "attestationObject"] : ["clientDataJSON", "authenticatorData", "signature", "userHandle"];
  for (const key of binaryFields) Object.defineProperty(response, key, { enumerable: true, value: decode(responseData[key]) });
  if (result.operation === "create") {
    Object.defineProperties(response, {
      getAuthenticatorData: { value: () => decode(responseData.authenticatorData) }, getPublicKey: { value: () => decode(responseData.publicKey) },
      getPublicKeyAlgorithm: { value: () => responseData.publicKeyAlgorithm }, getTransports: { value: () => ["internal"] }
    });
  }
  const credential = Object.create(window.PublicKeyCredential?.prototype || Object.prototype);
  Object.defineProperties(credential, {
    id: { enumerable: true, value: result.id }, rawId: { enumerable: true, value: decode(result.rawId) }, type: { enumerable: true, value: "public-key" },
    response: { enumerable: true, value: response }, authenticatorAttachment: { enumerable: true, value: "platform" },
    getClientExtensionResults: { value: () => result.clientExtensionResults || {} }, toJSON: { value: () => ({ id: result.id, rawId: result.rawId, type: "public-key", authenticatorAttachment: "platform", response: responseData, clientExtensionResults: result.clientExtensionResults || {} }) }
  });
  return credential as Credential;
}

function encode(value: BufferSource): string { const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decode(value: string): ArrayBuffer { const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); const binary = atob(normalized); return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer; }

export {};
