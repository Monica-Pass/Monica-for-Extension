import { describe, expect, it, vi } from "vitest";
import { BitwardenClient, inferBitwardenServerUrls } from "./bitwarden-client";
import { deriveBitwardenMasterKey, stretchBitwardenMasterKey, type BitwardenSymmetricKey } from "./bitwarden-crypto";

const EMAIL = "alice@example.com";
const PASSWORD = "correct horse battery staple";

describe("Bitwarden auth client", () => {
  it("maps official US/EU and self-hosted URLs without cross-origin discovery", () => {
    expect(inferBitwardenServerUrls("https://vault.bitwarden.com")).toEqual({ vault: "https://vault.bitwarden.com", api: "https://api.bitwarden.com", identity: "https://identity.bitwarden.com" });
    expect(inferBitwardenServerUrls("vault.bitwarden.eu")).toEqual({ vault: "https://vault.bitwarden.eu", api: "https://api.bitwarden.eu", identity: "https://identity.bitwarden.eu" });
    expect(inferBitwardenServerUrls("https://passwords.example.com/api/")).toEqual({ vault: "https://passwords.example.com", api: "https://passwords.example.com/api", identity: "https://passwords.example.com/identity" });
    expect(() => inferBitwardenServerUrls("http://passwords.example.com")).toThrow("HTTPS");
  });

  it("performs prelogin and password login and unwraps the vault key", async () => {
    const masterKey = await deriveBitwardenMasterKey(PASSWORD, EMAIL, { type: 0, iterations: 100_000 });
    const stretched = await stretchBitwardenMasterKey(masterKey);
    const vaultKey: BitwardenSymmetricKey = { encKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1), macKey: Uint8Array.from({ length: 32 }, (_, index) => index + 65) };
    const setupClient = new BitwardenClient();
    const protectedKey = await setupClient.protectVaultKey(vaultKey, stretched, new Uint8Array(16));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.redirect).toBe("error");
      if (url.endsWith("/accounts/prelogin")) return json({ Kdf: 0, KdfIterations: 100_000 });
      if (url.endsWith("/connect/token")) {
        const form = init?.body as URLSearchParams;
        expect(form.get("password")).toBe("ij4bpg+9sHwyc9ipLMipC5BiUug2hc9KWk8nXWxhz2o=");
        expect(new Headers(init?.headers).get("Auth-Email")).toBe("YWxpY2VAZXhhbXBsZS5jb20");
        return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, Key: protectedKey });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher);
    const result = await client.login({ vaultUrl: "https://vault.bitwarden.com", email: EMAIL, masterPassword: PASSWORD, deviceId: "device-1" });
    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") return;
    expect(client.vaultKey(result.session)).toEqual(vaultKey);
    expect(result.session).toMatchObject({ apiUrl: "https://api.bitwarden.com", identityUrl: "https://identity.bitwarden.com", accessToken: "access", refreshToken: "refresh" });
  });

  it("returns a resumable two-factor requirement without persisting the master password", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/accounts/prelogin")) return json({ kdf: 0, kdfIterations: 1 });
      return json({ error: "invalid_grant", TwoFactorProviders2: { "0": {}, "1": {} } }, 400);
    }) as unknown as typeof fetch;
    const result = await new BitwardenClient(fetcher).login({ vaultUrl: "https://self.example.com", email: EMAIL, masterPassword: PASSWORD, deviceId: "device-1" });
    expect(result).toEqual({ status: "two-factor-required", providers: [0, 1], providerData: { "0": {}, "1": {} } });
  });

  it("continues password login with an explicit two-factor code", async () => {
    const masterKey = await deriveBitwardenMasterKey(PASSWORD, EMAIL, { type: 0, iterations: 1 });
    const stretched = await stretchBitwardenMasterKey(masterKey);
    const vaultKey: BitwardenSymmetricKey = { encKey: new Uint8Array(32), macKey: new Uint8Array(32) };
    const setupClient = new BitwardenClient();
    const protectedKey = await setupClient.protectVaultKey(vaultKey, stretched, new Uint8Array(16));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/accounts/prelogin")) return json({ Kdf: 0, KdfIterations: 1 });
      const form = init?.body as URLSearchParams;
      expect(form.get("twoFactorToken")).toBe("123456");
      expect(form.get("twoFactorProvider")).toBe("0");
      expect(form.get("twoFactorRemember")).toBe("1");
      return json({ access_token: "access", refresh_token: "refresh", Key: protectedKey });
    }) as unknown as typeof fetch;
    const result = await new BitwardenClient(fetcher).login({
      vaultUrl: "https://self.example.com",
      email: EMAIL,
      masterPassword: PASSWORD,
      deviceId: "device-1",
      twoFactorCode: "123456",
      twoFactorProvider: 0,
      rememberTwoFactor: true
    });
    expect(result.status).toBe("authenticated");
  });

  it("requests an email two-factor code with the derived master password hash", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/accounts/prelogin")) return json({ Kdf: 0, KdfIterations: 100_000 });
      expect(String(input)).toBe("https://self.example.com/api/two-factor/send-email-login");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ deviceIdentifier: "device-1", email: EMAIL, masterPasswordHash: "ij4bpg+9sHwyc9ipLMipC5BiUug2hc9KWk8nXWxhz2o=" });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(new BitwardenClient(fetcher).sendTwoFactorEmailCode({ vaultUrl: "https://self.example.com", email: EMAIL, masterPassword: PASSWORD, deviceId: "device-1" })).resolves.toBeUndefined();
  });

  it("refreshes an expiring token before sync", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/identity/connect/token")) {
        expect((init?.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
        return json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 7200 });
      }
      if (url.endsWith("/api/sync?excludeDomains=true")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fresh-access");
        return json({ Profile: { Id: "user" }, Ciphers: [] });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher);
    const result = await client.sync({
      vaultUrl: "https://self.example.com",
      apiUrl: "https://self.example.com/api",
      identityUrl: "https://self.example.com/identity",
      email: EMAIL,
      deviceId: "device-1",
      accessToken: "expired",
      refreshToken: "refresh",
      expiresAt: 0,
      kdf: { type: 0, iterations: 1 },
      vaultKeyEnc: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      vaultKeyMac: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    });
    expect(result.session).toMatchObject({ accessToken: "fresh-access", refreshToken: "fresh-refresh" });
  });

  it("retries an idempotent transient sync and keeps authorization out of errors", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ message: "Bearer server-echo-secret" }, 503))
      .mockResolvedValueOnce(json({ Profile: { Id: "user" }, Ciphers: [] })) as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher, { baseDelayMs: 0, jitterRatio: 0 });

    await expect(client.sync(activeSession())).resolves.toMatchObject({ payload: { Ciphers: [] } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const calls = (fetcher as unknown as { mock: { calls: Array<[RequestInfo | URL, RequestInit]> } }).mock.calls;
    expect(new Headers(calls[0][1].headers).get("Authorization")).toBe("Bearer access-secret");
  });

  it("does not retry token login after an ambiguous network failure", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/accounts/prelogin")) return json({ Kdf: 0, KdfIterations: 1 });
      throw new TypeError("network failed token=must-not-escape");
    }) as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher, { baseDelayMs: 0 });

    const error = await client.login({ vaultUrl: "https://self.example.com", email: EMAIL, masterPassword: PASSWORD, deviceId: "device-1" }).catch((cause) => cause);
    expect(error).toMatchObject({ name: "ProviderTransportError", code: "network", retryable: false, attempts: 1 });
    expect(error.message).not.toContain("must-not-escape");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns a typed safe Bitwarden HTTP error without server-echoed tokens", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ message: "Bearer server-echo-secret", access_token: "response-secret" }, 401)) as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher, { baseDelayMs: 0 });

    const error = await client.sync(activeSession()).catch((cause) => cause);
    expect(error).toMatchObject({ name: "ProviderTransportError", code: "authentication", status: 401, retryable: false });
    expect(error.message).toBe("同步 Bitwarden 密码库失败（HTTP 401）。");
    expect(JSON.stringify(error)).not.toMatch(/server-echo-secret|response-secret|access-secret/);
  });

  it("honors cancellation before starting a Bitwarden sync request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn() as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher);

    await expect(client.sync(activeSession(), controller.signal)).rejects.toMatchObject({ code: "cancelled", retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function activeSession() {
  return {
    vaultUrl: "https://self.example.com",
    apiUrl: "https://self.example.com/api",
    identityUrl: "https://self.example.com/identity",
    email: EMAIL,
    deviceId: "device-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresAt: Date.now() + 3_600_000,
    kdf: { type: 0 as const, iterations: 1 },
    vaultKeyEnc: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    vaultKeyMac: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  };
}
