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
 * Monica currently provides user presence through its confirmation dialog,
 * but it does not yet have a trusted OS re-authentication surface. Requests
 * that require UV therefore remain with the browser's native authenticator.
 */
export function shouldInterceptPasskeyCreate(input: PasskeyCreateInterceptionInput): boolean {
  return input.topLevel
    && input.authenticatorAttachment !== "cross-platform"
    && input.userVerification !== "required"
    && input.extensionNames.every((name) => name === "credProps")
    && input.algorithms.includes(-7);
}

export function shouldInterceptPasskeyGet(input: PasskeyGetInterceptionInput): boolean {
  return input.topLevel
    && input.mediation !== "conditional"
    && input.mediation !== "silent"
    && input.userVerification !== "required"
    && input.extensionNames.length === 0
    && !input.externalOnly;
}
