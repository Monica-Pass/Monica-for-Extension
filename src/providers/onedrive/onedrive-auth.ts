import { bytesToBase64 } from "../../security/encoding";
import { readBoundedJsonObject } from "../bounded-body";
import { ProviderTransportError, providerHttpError, resilientFetch } from "../provider-transport";

/** Public application ID shared with Monica Android. Its extension redirect must be registered as SPA. */
export const MONICA_ONEDRIVE_CLIENT_ID = "2aaf8c2c-b817-4085-9517-586a4a113dfc";
export const ONEDRIVE_SCOPES = "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Files.ReadWrite";
const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const MAX_TOKEN_BYTES = 64 * 1024;

export interface OneDriveTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

export interface OneDriveAuthorizationOptions {
  redirectUri: string;
  launch: (authorizationUrl: string) => Promise<string>;
  signal?: AbortSignal;
}

export class OneDriveAuthorizationError extends ProviderTransportError {
  constructor(message: string = "OneDrive 授权已失效，请重新登录。") {
    super("authentication", message, { operation: "OneDrive 登录", attempts: 1, retryable: false });
    this.name = "OneDriveAuthorizationError";
  }
}

/** Only the background owns tokens/verifier. Never persist a pending authorization in plaintext storage. */
export class OneDriveAuthClient {
  constructor(
    readonly clientId: string = MONICA_ONEDRIVE_CLIENT_ID,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now
  ) {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(clientId)) throw new OneDriveAuthorizationError("OneDrive 应用 ID 无效。");
  }

  async authorize(options: OneDriveAuthorizationOptions): Promise<OneDriveTokens> {
    const redirect = extensionRedirect(options.redirectUri);
    options.signal?.throwIfAborted();
    const state = randomUrlToken();
    const verifier = randomUrlToken();
    const challenge = urlBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const authorization = new URL(`${AUTHORITY}/authorize`);
    authorization.search = new URLSearchParams({ client_id: this.clientId, response_type: "code", response_mode: "query", redirect_uri: redirect.href,
      scope: ONEDRIVE_SCOPES, state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account" }).toString();
    const callback = await options.launch(authorization.href);
    options.signal?.throwIfAborted();
    let returned: URL;
    try { returned = new URL(callback); } catch { throw new OneDriveAuthorizationError("OneDrive 登录返回地址无效。"); }
    if (returned.origin !== redirect.origin || returned.pathname !== redirect.pathname || returned.hash || returned.username || returned.password ||
      returned.searchParams.getAll("state").length !== 1 || returned.searchParams.get("state") !== state) {
      throw new OneDriveAuthorizationError("OneDrive 登录会话不匹配，请重新登录。");
    }
    if (returned.searchParams.has("error")) throw new OneDriveAuthorizationError("OneDrive 登录未完成，请重试或检查应用授权配置。");
    const code = returned.searchParams.get("code");
    if (returned.searchParams.getAll("code").length !== 1 || !code || code.length > 16384) throw new OneDriveAuthorizationError();
    return this.exchange({ grant_type: "authorization_code", code, redirect_uri: redirect.href, code_verifier: verifier }, undefined, options.signal);
  }

  async refresh(refreshToken: string, signal?: AbortSignal): Promise<OneDriveTokens> {
    if (!validSecret(refreshToken)) throw new OneDriveAuthorizationError();
    return this.exchange({ grant_type: "refresh_token", refresh_token: refreshToken }, refreshToken, signal);
  }

  private async exchange(parameters: Record<string, string>, previousRefreshToken?: string, signal?: AbortSignal): Promise<OneDriveTokens> {
    return resilientFetch(`${AUTHORITY}/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, scope: ONEDRIVE_SCOPES, ...parameters }),
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal
    }, { operation: "OneDrive 授权", fetcher: this.fetcher, idempotent: false, maxAttempts: 1 }, async (response, requestSignal) => {
      if (!response.ok) {
        // Microsoft error_description can echo request values; never surface it in runtime responses or logs.
        if ([400, 401, 403].includes(response.status)) throw new OneDriveAuthorizationError("OneDrive 登录未完成或已过期，请检查授权配置后重新登录。");
        throw providerHttpError("OneDrive 授权失败", response);
      }
      const value = await readBoundedJsonObject(response, MAX_TOKEN_BYTES, "OneDrive 授权响应", requestSignal);
      const refreshToken = value.refresh_token === undefined ? previousRefreshToken : value.refresh_token;
      const expiresIn = value.expires_in;
      if (value.token_type !== "Bearer" || !validSecret(value.access_token) || !validSecret(refreshToken) ||
        typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn < 60 || expiresIn > 86400 ||
        typeof value.scope !== "string" || !hasFileWriteScope(value.scope)) throw new OneDriveAuthorizationError("OneDrive 没有授予文件同步权限，请重新登录并完成授权。");
      signal?.throwIfAborted();
      return { accessToken: value.access_token, refreshToken, expiresAt: this.now() + expiresIn * 1000, scope: value.scope };
    });
  }
}

function extensionRedirect(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !/^[a-p]{32}\.chromiumapp\.org$/.test(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/onedrive") {
    throw new OneDriveAuthorizationError("OneDrive 扩展回调地址无效。");
  }
  return url;
}

function validSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 32768 && !/[\x00-\x20\x7f]/.test(value);
}
function hasFileWriteScope(scope: string): boolean {
  return scope.split(/\s+/).some(value => value.toLowerCase() === "files.readwrite" || value.toLowerCase() === "https://graph.microsoft.com/files.readwrite");
}
function urlBase64(value: Uint8Array): string { return bytesToBase64(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function randomUrlToken(): string { return urlBase64(crypto.getRandomValues(new Uint8Array(32))); }
