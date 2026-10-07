import { selectPasskeyRegistrationAlgorithm } from "./registration-policy";

/** Edge's JSON parser materializes this optional boolean even when it was omitted. */
export function requestedPasskeyExtensionNames(extensions?: AuthenticationExtensionsClientInputs): string[] {
  return Object.entries(extensions || {})
    .filter(([name, value]) => !(name === "enforceCredentialProtectionPolicy" && value === false))
    .map(([name]) => name);
}

export interface PasskeyCreateInterceptionInput {
  topLevel: boolean;
  authenticatorAttachment?: string | null;
  userVerification?: string | null;
  extensionNames: string[];
  algorithms: number[];
}

export interface PasskeyGetInterceptionInput {
  topLevel: boolean;
  mediation?: string | null;
  userVerification?: string | null;
  extensionNames: string[];
  externalOnly: boolean;
}

/**
 * UV-required requests enter Monica for fresh master-password or Windows Hello
 * verification. Without either, the bridge keeps the browser authenticator available.
 */
export function shouldInterceptPasskeyCreate(input: PasskeyCreateInterceptionInput): boolean {
  return input.topLevel
    && input.authenticatorAttachment !== "cross-platform"
    && input.extensionNames.every((name) => name === "credProps")
    && selectPasskeyRegistrationAlgorithm(input.algorithms) !== undefined;
}

export function shouldInterceptPasskeyGet(input: PasskeyGetInterceptionInput): boolean {
  return input.topLevel
    && input.mediation !== "conditional"
    && input.mediation !== "silent"
    && input.extensionNames.length === 0
    && !input.externalOnly;
}
