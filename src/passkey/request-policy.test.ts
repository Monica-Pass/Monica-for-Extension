import { describe, expect, it } from "vitest";
import { validatePasskeyRequest } from "./request-policy";

describe("Passkey request policy", () => {
  it("accepts and copies bounded create/get requests", () => {
    expect(validatePasskeyRequest({
      operation: "create",
      challenge: "AQIDBA",
      rpId: "example.com",
      rpName: "Example",
      userId: "dXNlcg",
      userName: "joy",
      userDisplayName: "Joy",
      algorithms: [-7, -7],
      excludeCredentialIds: [],
      discoverable: true,
      userVerificationRequired: true,
      credProps: true,
      timeoutMs: 30_000
    })).toMatchObject({ operation: "create", algorithms: [-7], discoverable: true, userVerificationRequired: true, credProps: true, timeoutMs: 30_000 });
    expect(validatePasskeyRequest({ operation: "get", challenge: "AQIDBA", allowCredentialIds: ["Y3JlZA"], userVerification: "preferred", timeoutMs: 45_000 })).toMatchObject({ operation: "get", userVerification: "preferred", timeoutMs: 45_000 });
  });

  it("rejects malformed base64url oversized strings lists and unexpected operations", () => {
    expect(() => validatePasskeyRequest({ operation: "get", challenge: "not base64!", allowCredentialIds: [] })).toThrow("Base64URL");
    expect(() => validatePasskeyRequest({ operation: "get", challenge: "A".repeat(16 * 1024 + 1), allowCredentialIds: [] })).toThrow("过长");
    expect(() => validatePasskeyRequest({ operation: "get", challenge: "AQID", allowCredentialIds: Array(129).fill("Y3JlZA") })).toThrow("列表格式无效或过大");
    expect(() => validatePasskeyRequest({ operation: "get", challenge: "AQID", allowCredentialIds: [], timeoutMs: 500 })).toThrow("超时时间");
    expect(() => validatePasskeyRequest({ operation: "get", challenge: "AQID", allowCredentialIds: [], userVerification: "always" })).toThrow("用户验证选项");
    expect(() => validatePasskeyRequest({ operation: "delete", challenge: "AQID" })).toThrow("操作类型无效");
  });
});
