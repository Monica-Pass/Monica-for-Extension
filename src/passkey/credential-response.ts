export function publicKeyCredential(result: Record<string, unknown>): Credential {
  const responseData = result.response as Record<string, unknown>;
  const responsePrototype = result.operation === "create" ? window.AuthenticatorAttestationResponse?.prototype : window.AuthenticatorAssertionResponse?.prototype;
  const response = Object.create(responsePrototype || Object.prototype);
  const binaryFields = result.operation === "create" ? ["clientDataJSON", "attestationObject"] : ["clientDataJSON", "authenticatorData", "signature", "userHandle"];
  for (const key of binaryFields) Object.defineProperty(response, key, { enumerable: true, value: decode(responseData[key] as string) });
  if (result.operation === "create") {
    Object.defineProperties(response, {
      getAuthenticatorData: { value: () => decode(responseData.authenticatorData as string) }, getPublicKey: { value: () => decode(responseData.publicKey as string) },
      getPublicKeyAlgorithm: { value: () => responseData.publicKeyAlgorithm }, getTransports: { value: () => ["internal"] }
    });
  }
  const credential = Object.create(window.PublicKeyCredential?.prototype || Object.prototype);
  Object.defineProperties(credential, {
    id: { enumerable: true, value: result.id }, rawId: { enumerable: true, value: decode(result.rawId as string) }, type: { enumerable: true, value: "public-key" },
    response: { enumerable: true, value: response }, authenticatorAttachment: { enumerable: true, value: "platform" },
    getClientExtensionResults: { value: () => result.clientExtensionResults || {} },
    // Web IDL methods are writable/configurable. webauthn-json replaces toJSON
    // before serializing (including on GitHub), just as it does on native credentials.
    toJSON: { writable: true, configurable: true, value: () => ({ id: result.id, rawId: result.rawId, type: "public-key", authenticatorAttachment: "platform", response: responseData, clientExtensionResults: result.clientExtensionResults || {} }) }
  });
  return credential as Credential;
}


function decode(value: string): ArrayBuffer { const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4); const binary = atob(normalized); return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer; }
