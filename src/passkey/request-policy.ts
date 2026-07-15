import type { PasskeyRequest } from "../runtime/messages";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_CHALLENGE_CHARS = 16 * 1024;
const MAX_CREDENTIAL_ID_CHARS = 4096;
const MAX_CREDENTIAL_LIST = 128;

export function validatePasskeyRequest(input: unknown): PasskeyRequest {
  if (!input || typeof input !== "object") throw new Error("Passkey 请求格式无效。");
  const value = input as Record<string, unknown>;
  const operation = value.operation;
  const challenge = boundedBase64Url(value.challenge, MAX_CHALLENGE_CHARS, "Passkey challenge");
  const rpId = optionalBoundedString(value.rpId, 253, "Passkey RP ID");

  if (operation === "create") {
    const algorithms = boundedIntegerArray(value.algorithms, 32, "Passkey 算法列表");
    return {
      operation,
      challenge,
      rpId,
      rpName: boundedString(value.rpName, 256, "Passkey RP 名称"),
      userId: boundedBase64Url(value.userId, 128, "Passkey 用户 ID"),
      userName: boundedString(value.userName, 256, "Passkey 用户名"),
      userDisplayName: boundedString(value.userDisplayName, 256, "Passkey 显示名"),
      algorithms,
      excludeCredentialIds: boundedCredentialIds(value.excludeCredentialIds)
    };
  }
  if (operation === "get") {
    return {
      operation,
      challenge,
      rpId,
      allowCredentialIds: boundedCredentialIds(value.allowCredentialIds)
    };
  }
  throw new Error("Passkey 操作类型无效。");
}

function boundedCredentialIds(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > MAX_CREDENTIAL_LIST) throw new Error("Passkey 凭据列表格式无效或过大。");
  return input.map((value) => boundedBase64Url(value, MAX_CREDENTIAL_ID_CHARS, "Passkey 凭据 ID"));
}

function boundedIntegerArray(input: unknown, maximumLength: number, label: string): number[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > maximumLength || input.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`${label}格式无效或过大。`);
  }
  return [...new Set(input as number[])];
}

function boundedBase64Url(input: unknown, maximumLength: number, label: string): string {
  const value = boundedString(input, maximumLength, label);
  if (!BASE64URL.test(value)) throw new Error(`${label}不是有效的 Base64URL。`);
  return value;
}

function boundedString(input: unknown, maximumLength: number, label: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > maximumLength) throw new Error(`${label}为空或过长。`);
  return input;
}

function optionalBoundedString(input: unknown, maximumLength: number, label: string): string | undefined {
  if (input === undefined) return undefined;
  return boundedString(input, maximumLength, label);
}
