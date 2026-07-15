import { describe, expect, it } from "vitest";
import { createProviderDiagnostic, redactProviderDiagnostic } from "./provider-diagnostics";
import { ProviderTransportError } from "./provider-transport";

describe("provider diagnostic redaction", () => {
  it("deeply removes credentials tokens keys URLs email and server-echoed secrets", () => {
    const source = {
      provider: "bitwarden",
      config: {
        email: "joy.private@example.com",
        password: "correct horse battery staple",
        accessToken: "access-token-secret",
        refreshToken: "refresh-token-secret",
        vaultKeyEnc: "vault-key-secret",
        endpoint: "https://joy:password@vault.private.example/api/sync?token=query-secret"
      },
      headers: { Authorization: "Bearer bearer-secret", Cookie: "session=cookie-secret" },
      message: "request failed password=hunter2 token=server-secret at https://private.example/path?q=secret",
      nested: [{ secret: "nested-secret", safeCount: 3 }]
    };

    const redacted = redactProviderDiagnostic(source);
    const serialized = JSON.stringify(redacted);
    for (const secret of ["joy.private", "correct horse", "access-token", "refresh-token", "vault-key", "password@", "query-secret", "bearer-secret", "cookie-secret", "hunter2", "server-secret", "nested-secret", "private.example"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(redacted).toMatchObject({ provider: "bitwarden", config: { password: "[REDACTED]", accessToken: "[REDACTED]" }, nested: [{ secret: "[REDACTED]", safeCount: 3 }] });
  });

  it("exports only the typed safe error surface", () => {
    const error = new ProviderTransportError("rate-limited", "Bitwarden 暂时限制请求。", {
      retryable: true,
      operation: "sync",
      attempts: 3,
      status: 429,
      retryAfterMs: 2_000
    });
    const diagnostic = createProviderDiagnostic("provider-id-must-not-export", "bitwarden", error, "2026-07-15T00:00:00.000Z");
    expect(diagnostic).toEqual({
      at: "2026-07-15T00:00:00.000Z",
      providerRef: expect.stringMatching(/^provider-[a-f0-9]{8}$/),
      kind: "bitwarden",
      operation: "sync",
      outcome: "failure",
      code: "rate-limited",
      status: 429,
      retryable: true,
      attempts: 3,
      retryAfterMs: 2_000,
      message: "Bitwarden 暂时限制请求。"
    });
    expect(JSON.stringify(diagnostic)).not.toContain("provider-id-must-not-export");
  });
});
