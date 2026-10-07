import { describe, expect, it, vi } from "vitest";
import { OneDriveAuthClient } from "./onedrive-auth";

const redirectUri = `https://${"a".repeat(32)}.chromiumapp.org/onedrive`;
const tokens = { token_type: "Bearer", access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, scope: "User.Read Files.ReadWrite" };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("OneDrive authorization code with PKCE", () => {
  it("binds callback, state and S256 verifier, without a client secret", async () => {
    let authorization!: URL;
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
      expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
      const body = new URLSearchParams(String(init!.body));
      expect(body.get("client_secret")).toBeNull(); expect(body.get("code")).toBe("synthetic-code");
      expect(body.get("redirect_uri")).toBe(redirectUri);
      const verifier = body.get("code_verifier")!;
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
      expect(authorization.searchParams.get("code_challenge")).toBe(challenge);
      return response(tokens);
    });
    const result = await new OneDriveAuthClient(undefined, fetcher, () => 1000).authorize({ redirectUri, launch: async url => {
      authorization = new URL(url);
      expect(authorization.origin).toBe("https://login.microsoftonline.com");
      expect(authorization.searchParams.get("response_type")).toBe("code");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("scope")).toContain("offline_access");
      return `${redirectUri}?state=${authorization.searchParams.get("state")}&code=synthetic-code`;
    } });
    expect(result).toEqual({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: 3601000, scope: tokens.scope });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["state", "origin", "path", "fragment", "duplicate-code", "duplicate-state", "error"])("rejects %s callback tampering before token exchange", async variant => {
    const fetcher = vi.fn();
    await expect(new OneDriveAuthClient(undefined, fetcher).authorize({ redirectUri, launch: async url => {
      const state = new URL(url).searchParams.get("state");
      const returned = new URL(`${redirectUri}?state=${state}&code=synthetic`);
      if (variant === "state") returned.searchParams.set("state", "mismatch");
      if (variant === "origin") returned.hostname = "attacker.example";
      if (variant === "path") returned.pathname = "/other";
      if (variant === "fragment") returned.hash = "code=secret";
      if (variant === "duplicate-code") returned.searchParams.append("code", "second");
      if (variant === "duplicate-state") returned.searchParams.append("state", state!);
      if (variant === "error") returned.searchParams.set("error", "access_denied");
      return returned.href;
    } })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects cancellation while the browser login window is open", async () => {
    const controller = new AbortController(), fetcher = vi.fn();
    await expect(new OneDriveAuthClient(undefined, fetcher).authorize({ redirectUri, signal: controller.signal, launch: async url => {
      controller.abort(); return `${redirectUri}?state=${new URL(url).searchParams.get("state")}&code=synthetic`;
    } })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses rotated refresh tokens and retains the prior token only when Microsoft omits rotation", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ ...tokens, refresh_token: "rotated" })).mockResolvedValueOnce(response({ ...tokens, refresh_token: undefined }));
    const auth = new OneDriveAuthClient(undefined, fetcher);
    const first = await auth.refresh("previous"); expect(first.refreshToken).toBe("rotated");
    const second = await auth.refresh(first.refreshToken); expect(second.refreshToken).toBe("rotated");
    expect(new URLSearchParams(String(fetcher.mock.calls[1][1].body)).get("refresh_token")).toBe("rotated");
  });

  it.each([{ ...tokens, scope: "User.Read" }, { ...tokens, token_type: "Basic" }, { ...tokens, expires_in: -1 }, { ...tokens, access_token: "line\nbreak" }])("rejects malformed or insufficient token response", async value => {
    await expect(new OneDriveAuthClient(undefined, async () => response(value)).refresh("previous")).rejects.toThrow();
  });

  it("does not echo server descriptions or replay an authorization exchange", async () => {
    const fetcher = vi.fn(async () => response({ error: "invalid_grant", error_description: "secret synthetic-refresh" }, 400));
    await expect(new OneDriveAuthClient(undefined, fetcher).refresh("previous")).rejects.not.toThrow(/secret|synthetic-refresh/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["https://attacker.example/onedrive", `${redirectUri}?override=true`, `http://${"a".repeat(32)}.chromiumapp.org/onedrive`])("only accepts the extension redirect: %s", async value => {
    const launch = vi.fn();
    await expect(new OneDriveAuthClient().authorize({ redirectUri: value, launch })).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });
});
