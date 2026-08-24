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
 * UV-required requests enter Monica so the background can verify an enrolled
 * Windows Hello binding. Without one the background reports NotSupported and
 * the main-world bridge falls back to the browser authenticator.
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
