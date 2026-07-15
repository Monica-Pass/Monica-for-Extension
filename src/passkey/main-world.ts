import { OPEN_SHADOW_ROOT_EVENT } from "../content/shadow-bridge";

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
    const result = await bridge({
      operation: "create", challenge: encode(pk.challenge), rpId: pk.rp.id, rpName: pk.rp.name,
      userId: encode(pk.user.id), userName: pk.user.name, userDisplayName: pk.user.displayName,
      algorithms: pk.pubKeyCredParams.map((param) => param.alg), excludeCredentialIds: (pk.excludeCredentials || []).map((item) => encode(item.id))
    });
    return publicKeyCredential(result);
  } });
  Object.defineProperty(credentials, "get", { configurable: true, value: async (options?: CredentialRequestOptions) => {
    if (!options?.publicKey) return nativeGet(options);
    const pk = options.publicKey;
    const result = await bridge({ operation: "get", challenge: encode(pk.challenge), rpId: pk.rpId, allowCredentialIds: (pk.allowCredentials || []).map((item) => encode(item.id)) });
    return publicKeyCredential(result);
  } });
}

function bridge(request: Record<string, unknown>): Promise<Record<string, any>> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => { cleanup(); reject(new DOMException("Monica Passkey 请求超时。", "NotAllowedError")); }, 120_000);
    const listener = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== EXTENSION_SOURCE || event.data?.requestId !== requestId) return;
      cleanup();
      if (event.data.error) reject(new DOMException(event.data.error, event.data.name || "NotAllowedError")); else resolve(event.data.result);
    };
    const cleanup = () => { window.clearTimeout(timeout); window.removeEventListener("message", listener); };
    window.addEventListener("message", listener);
    window.postMessage({ source: PAGE_SOURCE, requestId, request }, location.origin);
  });
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
    getClientExtensionResults: { value: () => ({}) }, toJSON: { value: () => ({ id: result.id, rawId: result.rawId, type: "public-key", authenticatorAttachment: "platform", response: responseData, clientExtensionResults: {} }) }
  });
  return credential as Credential;
}

function encode(value: BufferSource): string { const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function decode(value: string): ArrayBuffer { const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); const binary = atob(normalized); return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer; }

export {};
