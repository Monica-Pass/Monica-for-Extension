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
    && input.algorithms.includes(-7);
}

export function shouldInterceptPasskeyGet(input: PasskeyGetInterceptionInput): boolean {
  return input.topLevel
    && input.mediation !== "conditional"
    && input.mediation !== "silent"
    && input.extensionNames.length === 0
    && !input.externalOnly;
}
