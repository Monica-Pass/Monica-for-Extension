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
    expect(inferBitwardenServerUrls("http://localhost:8080")).toEqual({ vault: "http://localhost:8080", api: "http://localhost:8080/api", identity: "http://localhost:8080/identity" });
    expect(() => inferBitwardenServerUrls("http://passwords.example.com")).toThrow("HTTPS");
    expect(() => inferBitwardenServerUrls("ftp://localhost/vault")).toThrow("HTTPS");
    expect(() => inferBitwardenServerUrls("https://user:secret@passwords.example.com")).toThrow("不能包含用户名或密码");
    expect(() => inferBitwardenServerUrls("https://passwords.example.com?token=secret")).toThrow("不能包含查询参数或片段");
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
      if (url.includes("/accounts/prelogin")) return json({ Kdf: 0, KdfIterations: 100_000 });
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

  it("uses the current password prelogin endpoint and falls back for older self-hosted servers", async () => {
    const currentFetcher = vi.fn().mockResolvedValue(json({ Kdf: 0, KdfIterations: 600_000 }));
    await new BitwardenClient(currentFetcher as unknown as typeof fetch).prelogin("https://vault.bitwarden.com", EMAIL);
    expect(String(currentFetcher.mock.calls[0][0])).toBe("https://identity.bitwarden.com/accounts/prelogin/password");

    const legacyFetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/accounts/prelogin/password")) return json({ message: "not found" }, 404);
      if (String(input).endsWith("/accounts/prelogin")) return json({ Kdf: 0, KdfIterations: 100_000 });
      throw new Error(`Unexpected URL ${String(input)}`);
    }) as unknown as typeof fetch;
    const result = await new BitwardenClient(legacyFetcher).prelogin("https://vaultwarden.example.com", EMAIL);
    expect(result.kdf).toEqual({ type: 0, iterations: 100_000 });
    expect(legacyFetcher).toHaveBeenCalledTimes(2);
  });

  it("returns a resumable two-factor requirement without persisting the master password", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/accounts/prelogin")) return json({ kdf: 0, kdfIterations: 1 });
      return json({ error: "invalid_grant", TwoFactorProviders2: { "0": {}, "1": {} } }, 400);
    }) as unknown as typeof fetch;
    const result = await new BitwardenClient(fetcher).login({ vaultUrl: "https://self.example.com", email: EMAIL, masterPassword: PASSWORD, deviceId: "device-1" });
    expect(result).toEqual({ status: "two-factor-required", providers: [0, 1], providerData: { "0": {}, "1": {} } });
  });

  it("returns the organization identifier when password login requires SSO", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/accounts/prelogin")) return json({ kdf: 0, kdfIterations: 1 });
      return json({ error: "invalid_grant", SsoOrganizationIdentifier: "acme" }, 400);
    }) as unknown as typeof fetch;
    await expect(new BitwardenClient(fetcher).login({ vaultUrl: "https://self.example.com", email: EMAIL, masterPassword: PASSWORD, deviceId: "device-1" }))
      .resolves.toEqual({ status: "sso-required", organizationIdentifier: "acme" });
  });

  it("prevalidates SSO through the official domainHint endpoint", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://self.example.com/identity/sso/prevalidate?domainHint=acme%20corp");
      return json({ token: "prevalidated-token" });
    }) as unknown as typeof fetch;
    await expect(new BitwardenClient(fetcher).prevalidateSso("https://self.example.com", " acme corp "))
      .resolves.toEqual({ urls: { vault: "https://self.example.com", api: "https://self.example.com/api", identity: "https://self.example.com/identity" }, token: "prevalidated-token" });
  });

  it("revokes refresh tokens without retrying or exposing the token", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://self.example.com/identity/connect/revoke");
      expect((init?.body as URLSearchParams).get("token")).toBe("refresh-secret");
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(new BitwardenClient(fetcher).revoke(activeSession())).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("turns Bitwarden's invalid credential response into an actionable region-safe error", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/accounts/prelogin")) return json({ kdf: 0, kdfIterations: 1 });
      return json({
        error: "invalid_grant",
        error_description: "invalid_username_or_password",
        ErrorModel: { Message: "Username or password is incorrect. Try again." },
        access_token: "server-echo-secret"
      }, 400);
    }) as unknown as typeof fetch;

    const error = await new BitwardenClient(fetcher).login({
      vaultUrl: "https://vault.bitwarden.com",
      email: EMAIL,
      masterPassword: PASSWORD,
      deviceId: "device-1"
    }).catch((cause) => cause);

    expect(error).toMatchObject({ name: "ProviderTransportError", code: "client", status: 400, retryable: false });
    expect(error.message).toBe("Bitwarden 邮箱或主密码错误；请同时确认账号区域与服务器地址一致（US 或 EU）。");
    expect(JSON.stringify(error)).not.toContain("server-echo-secret");
  });

  it("reports an invalid or expired Bitwarden two-factor code without exposing response data", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/accounts/prelogin")) return json({ kdf: 0, kdfIterations: 1 });
      return json({ error: "invalid_grant", error_description: "invalid_two_factor_token", token: "server-echo-secret" }, 400);
    }) as unknown as typeof fetch;

    const error = await new BitwardenClient(fetcher).login({
      vaultUrl: "https://vault.bitwarden.com",
      email: EMAIL,
      masterPassword: PASSWORD,
      deviceId: "device-1",
      twoFactorCode: "123456",
      twoFactorProvider: 0
    }).catch((cause) => cause);

    expect(error.message).toBe("Bitwarden 两步验证码错误或已过期，请获取新验证码后重试。");
    expect(JSON.stringify(error)).not.toContain("server-echo-secret");
  });

  it("returns a resumable new-device verification requirement and submits its email OTP", async () => {
    let submittedOtp: string | null = null;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/accounts/prelogin")) return json({ kdf: 0, kdfIterations: 1 });
      submittedOtp = (init?.body as URLSearchParams).get("newDeviceOtp");
      return json({ ErrorModel: { Message: "new device verification required" }, DeviceVerified: false }, 400);
    }) as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher);

    await expect(client.login({
      vaultUrl: "https://vault.bitwarden.com",
      email: EMAIL,
      masterPassword: PASSWORD,
      deviceId: "device-1"
    })).resolves.toEqual({ status: "device-verification-required" });
    expect(submittedOtp).toBeNull();

    await expect(client.login({
      vaultUrl: "https://vault.bitwarden.com",
      email: EMAIL,
      masterPassword: PASSWORD,
      deviceId: "device-1",
      newDeviceOtp: " 654321 "
    })).resolves.toEqual({ status: "device-verification-required" });
    expect(submittedOtp).toBe("654321");
  });

  it("rejects oversized or control-character login codes before contacting Bitwarden", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher);
    const base = { vaultUrl: "https://vault.bitwarden.com", email: EMAIL, masterPassword: PASSWORD, deviceId: "device-1" };

    await expect(client.login({ ...base, newDeviceOtp: "1".repeat(257) })).rejects.toThrow("新设备验证码无效");
    await expect(client.login({ ...base, twoFactorCode: "123\n456", twoFactorProvider: 0 })).rejects.toThrow("两步验证码无效");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("continues password login with an explicit two-factor code", async () => {
    const masterKey = await deriveBitwardenMasterKey(PASSWORD, EMAIL, { type: 0, iterations: 1 });
    const stretched = await stretchBitwardenMasterKey(masterKey);
    const vaultKey: BitwardenSymmetricKey = { encKey: new Uint8Array(32), macKey: new Uint8Array(32) };
    const setupClient = new BitwardenClient();
    const protectedKey = await setupClient.protectVaultKey(vaultKey, stretched, new Uint8Array(16));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/accounts/prelogin")) return json({ Kdf: 0, KdfIterations: 1 });
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
      if (String(input).includes("/accounts/prelogin")) return json({ Kdf: 0, KdfIterations: 100_000 });
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

  it("refreshes once when a non-expired access token is revoked", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/sync?excludeDomains=true")) {
        const authorization = new Headers(init?.headers).get("Authorization");
        if (authorization === "Bearer access-secret") return json({ error: "invalid_token" }, 401);
        expect(authorization).toBe("Bearer rotated-access");
        return json({ Profile: { Id: "user" }, Ciphers: [] });
      }
      if (url.endsWith("/identity/connect/token")) {
        expect((init?.body as URLSearchParams).get("grant_type")).toBe("refresh_token");
        return json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 });
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const result = await new BitwardenClient(fetcher).sync(activeSession());
    expect(result.session).toMatchObject({ accessToken: "rotated-access", refreshToken: "rotated-refresh" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not retry token login after an ambiguous network failure", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/accounts/prelogin")) return json({ Kdf: 0, KdfIterations: 1 });
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

  it("caps authentication and vault JSON responses without trusting Content-Length", async () => {
    const authFetcher = vi.fn().mockResolvedValue(json({ Kdf: 0, padding: "x".repeat(128) })) as unknown as typeof fetch;
    const authClient = new BitwardenClient(authFetcher, {}, { maxAuthResponseBytes: 32 });
    await expect(authClient.prelogin("https://self.example.com", EMAIL)).rejects.toThrow("Bitwarden 预登录响应超过安全上限");

    const vaultFetcher = vi.fn().mockResolvedValue(json({ Ciphers: [], padding: "x".repeat(128) })) as unknown as typeof fetch;
    const vaultClient = new BitwardenClient(vaultFetcher, {}, { maxVaultResponseBytes: 32 });
    await expect(vaultClient.sync(activeSession())).rejects.toThrow("Bitwarden 密码库响应超过安全上限");
  });
});

describe("Bitwarden attachment write client", () => {
  it("prepares an attachment with the current Cipher revision and parses official upload modes", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-secret");
      expect(JSON.parse(String(init?.body))).toEqual({
        key: "2.wrapped",
        fileName: "2.encrypted-name",
        fileSize: 97,
        lastKnownRevisionDate: "2026-08-08T00:00:00.000Z"
      });
      return json({
        attachmentId: "attachment-1",
        fileUploadType: 0,
        url: "",
        cipherResponse: { id: "cipher-1", revisionDate: "2026-08-08T00:00:01.000Z" }
      });
    }) as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher, fastTransport());

    await expect(client.prepareAttachmentUpload(activeSession(), "cipher-1", {
      key: "2.wrapped",
      fileName: "2.encrypted-name",
      fileSize: 97,
      lastKnownRevisionDate: "2026-08-08T00:00:00.000Z"
    })).resolves.toMatchObject({
      upload: {
        attachmentId: "attachment-1",
        fileUploadType: 0,
        cipherResponse: { id: "cipher-1" }
      }
    });

    const unknown = new BitwardenClient(vi.fn().mockResolvedValue(json({
      attachmentId: "attachment-2",
      fileUploadType: 7
    })) as unknown as typeof fetch, fastTransport());
    await expect(unknown.prepareAttachmentUpload(activeSession(), "cipher-1", {
      key: "2.wrapped",
      fileName: "2.encrypted-name",
      fileSize: 97,
      lastKnownRevisionDate: "2026-08-08T00:00:00.000Z"
    })).rejects.toThrow("上传模式");

    const vaultwarden = new BitwardenClient(vi.fn().mockResolvedValue(json({
      fileUploadType: 0,
      cipherResponse: {
        id: "cipher-1",
        revisionDate: "2026-08-08T00:00:01.000Z",
        attachments: [{ id: "attachment-fallback", fileName: "2.encrypted-name", key: "2.wrapped", size: "97" }]
      }
    })) as unknown as typeof fetch, fastTransport());
    await expect(vaultwarden.prepareAttachmentUpload(activeSession(), "cipher-1", {
      key: "2.wrapped",
      fileName: "2.encrypted-name",
      fileSize: 97,
      lastKnownRevisionDate: "2026-08-08T00:00:00.000Z"
    })).resolves.toMatchObject({ upload: { attachmentId: "attachment-fallback", fileUploadType: 0 } });
  });

  it("uploads Direct mode with only the data part and the encrypted filename", async () => {
    const encrypted = Uint8Array.from({ length: 64 }, (_, index) => index);
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://self.example.com/api/ciphers/cipher-1/attachment/attachment-1");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer access-secret");
      const form = init?.body as FormData;
      expect([...form.keys()]).toEqual(["data"]);
      const data = form.get("data");
      expect(data).toBeInstanceOf(Blob);
      expect((data as File).name).toBe("2.encrypted-name");
      expect(new Uint8Array(await (data as Blob).arrayBuffer())).toEqual(encrypted);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(new BitwardenClient(fetcher, fastTransport()).uploadAttachmentDirect(
      activeSession(),
      "cipher-1",
      "attachment-1",
      "2.encrypted-name",
      encrypted
    )).resolves.toMatchObject({ accessToken: "access-secret" });
  });

  it("isolates Azure signed URLs from Bearer credentials and requires HTTP 201", async () => {
    const signed = "https://objects.example.test/blob?sv=2026-01-01&se=2099-01-01T00%3A00%3A00Z&sig=opaque";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("x-ms-blob-type")).toBe("BlockBlob");
      expect(headers.get("Content-Type")).toBe("application/octet-stream");
      expect(init).toMatchObject({ method: "PUT", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const encrypted = new Uint8Array(64).fill(1);
    await expect(new BitwardenClient(fetcher, fastTransport()).uploadAttachmentAzure(signed, encrypted)).resolves.toBeUndefined();

    const wrongStatus = new BitwardenClient(vi.fn().mockResolvedValue(new Response(null, { status: 200 })) as unknown as typeof fetch, fastTransport());
    await expect(wrongStatus.uploadAttachmentAzure(signed, encrypted)).rejects.toMatchObject({ status: 200 });

    const unused = vi.fn() as unknown as typeof fetch;
    await expect(new BitwardenClient(unused).uploadAttachmentAzure("http://objects.example.test/blob", encrypted)).rejects.toThrow("HTTPS");
    expect(unused).not.toHaveBeenCalled();
  });

  it("renews Azure URLs and treats 404 attachment deletion as complete", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/renew")) return json({ url: "https://objects.example.test/renewed?sig=opaque" });
      if (url.endsWith("/attachment-1")) return json({ message: "already gone" }, 404);
      throw new Error(`Unexpected URL ${url}`);
    }) as unknown as typeof fetch;
    const client = new BitwardenClient(fetcher, fastTransport());

    await expect(client.renewAttachmentUploadUrl(activeSession(), "cipher-1", "attachment-1"))
      .resolves.toMatchObject({ url: "https://objects.example.test/renewed?sig=opaque" });
    await expect(client.deleteAttachment(activeSession(), "cipher-1", "attachment-1"))
      .resolves.toMatchObject({ deleted: true });
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

function fastTransport() {
  return { baseDelayMs: 0, jitterRatio: 0, timeoutMs: 2_000 };
}
