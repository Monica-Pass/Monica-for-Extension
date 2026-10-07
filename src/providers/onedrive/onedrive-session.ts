import type { ProviderAccount } from "../../core/model";
import { sameProviderBinding } from "../../core/provider";
import { OneDriveAuthClient, OneDriveAuthorizationError, MONICA_ONEDRIVE_CLIENT_ID } from "./onedrive-auth";
import { OneDriveGraphClient, OneDriveKeePassFileClient, type OneDriveDrive, type OneDriveItem, type OneDriveItemIdentity, type OneDriveProfile } from "./onedrive-graph-client";
import { OneDriveTokenManager, oneDriveConnectionBinding, parseOneDriveConnection, type OneDriveConnection } from "./onedrive-token-manager";

export interface OneDriveSessionVault {
  sessionId(): Promise<string | undefined>;
  getProvider(providerId: string): Promise<ProviderAccount | undefined>;
  rotateOneDriveTokens(providerId: string, previous: OneDriveConnection, tokens: OneDriveConnection["tokens"], signal?: AbortSignal): Promise<void>;
}
export interface OneDriveLoginSummary { loginId: string; profile: OneDriveProfile; drive: OneDriveDrive }
export interface OneDriveBrowserInput { loginId?: string; providerId?: string; parentId?: string }
export interface OneDriveBrowserPage { profile: OneDriveProfile; drive: OneDriveDrive; items: OneDriveItem[] }
interface PendingLogin {
  sessionId: string;
  expiresAt: number;
  controller: AbortController;
  connection?: OneDriveConnection;
  drive?: OneDriveDrive;
}

/** All values carrying tokens stay in the background. Pending login handles expire without persistence. */
export class OneDriveSessionService {
  private readonly pending = new Map<string, PendingLogin>();
  private readonly tokens: OneDriveTokenManager;
  private epoch = 0;
  private lifetime = new AbortController();
  constructor(
    private readonly vault: OneDriveSessionVault,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now
  ) {
    this.tokens = new OneDriveTokenManager({
      read: async id => {
        const account = await this.vault.getProvider(id);
        return account?.enabled && account.kind === "keepass" && account.config.sourceMode === "onedrive" ? parseOneDriveConnection(account.config.oneDriveConnection) : undefined;
      },
      rotate: (id, previous, tokens, signal) => this.vault.rotateOneDriveTokens(id, previous, tokens, signal)
    }, clientId => new OneDriveAuthClient(clientId, this.fetcher, this.now), now);
  }

  clear(): void {
    this.epoch++;
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.tokens.clear();
    for (const pending of this.pending.values()) pending.controller.abort();
    this.pending.clear();
  }

  cancel(loginId: string): void {
    this.pending.get(loginId)?.controller.abort();
    this.pending.delete(loginId);
  }

  async login(loginId: string, redirectUri: string, launch: (url: string) => Promise<string>, clientId = MONICA_ONEDRIVE_CLIENT_ID): Promise<OneDriveLoginSummary> {
    this.expire();
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(loginId) || this.pending.has(loginId) || this.pending.size >= 4) throw new OneDriveAuthorizationError("OneDrive 登录请求无效或仍在进行中。");
    const epoch = this.epoch;
    const sessionId = await this.requireSession();
    if (epoch !== this.epoch || this.pending.has(loginId) || this.pending.size >= 4) throw new OneDriveAuthorizationError();
    const pending: PendingLogin = { sessionId, expiresAt: this.now() + 10 * 60_000, controller: new AbortController() };
    this.pending.set(loginId, pending);
    try {
      const auth = new OneDriveAuthClient(clientId, this.fetcher, this.now);
      const tokens = await auth.authorize({ redirectUri, launch, signal: pending.controller.signal });
      await this.assertPending(loginId, pending);
      const graph = new OneDriveGraphClient(async () => { await this.assertPending(loginId, pending); return tokens.accessToken; }, this.fetcher);
      const profile = await graph.profile(pending.controller.signal);
      const drive = await graph.defaultDrive(pending.controller.signal);
      await this.assertPending(loginId, pending);
      pending.connection = { id: loginId, clientId, profile, tokens };
      pending.drive = drive;
      return { loginId, profile: { ...profile }, drive: { ...drive } };
    } catch (error) {
      if (this.pending.get(loginId) === pending) this.cancel(loginId);
      else pending.controller.abort();
      throw error;
    }
  }

  async browse(input: OneDriveBrowserInput): Promise<OneDriveBrowserPage> {
    if (Boolean(input.loginId) === Boolean(input.providerId)) throw new OneDriveAuthorizationError("请先选择 OneDrive 登录账号。");
    const sessionId = await this.requireSession();
    if (input.loginId) {
      const pending = await this.requirePending(input.loginId);
      const items = await this.pendingGraph(input.loginId, pending).children(pending.drive!.id, input.parentId, pending.controller.signal);
      await this.assertPending(input.loginId, pending);
      return { profile: { ...pending.connection!.profile }, drive: { ...pending.drive! }, items };
    }
    const account = await this.vault.getProvider(input.providerId!);
    if (!account || account.kind !== "keepass" || account.config.sourceMode !== "onedrive" || !account.enabled) throw new OneDriveAuthorizationError();
    const connection = parseOneDriveConnection(account.config.oneDriveConnection);
    if (!connection || typeof account.config.oneDriveDriveId !== "string") throw new OneDriveAuthorizationError();
    const graph = this.savedGraph(account, connection, sessionId);
    const items = await graph.children(account.config.oneDriveDriveId, input.parentId);
    await this.assertSaved(account, sessionId);
    return { profile: { ...connection.profile }, drive: { id: account.config.oneDriveDriveId, name: "OneDrive", driveType: "" }, items };
  }

  /** Internal only. The caller uses this in the draft provider before committing the encrypted account. */
  async connectionForLogin(loginId: string): Promise<OneDriveConnection> {
    const pending = await this.requirePending(loginId);
    return structuredClone(pending.connection!);
  }

  fileClient(account: ProviderAccount, identity: OneDriveItemIdentity): OneDriveKeePassFileClient {
    const connection = parseOneDriveConnection(account.config.oneDriveConnection);
    if (!connection) throw new OneDriveAuthorizationError();
    const pending = this.pending.get(connection.id);
    if (pending) {
      if (identity.driveId !== pending.drive?.id || !pending.connection || pending.connection.clientId !== connection.clientId || pending.connection.profile.id !== connection.profile.id) throw new OneDriveAuthorizationError("所选文件与 OneDrive 登录账号不一致。");
      return new OneDriveKeePassFileClient(identity, this.pendingGraph(connection.id, pending));
    }
    // The first token request captures the active session, before accessing a saved source.
    const epoch = this.epoch;
    let sessionId: string | undefined;
    const graph = new OneDriveGraphClient(async signal => {
      sessionId ||= await this.requireSession();
      if (epoch !== this.epoch) throw new OneDriveAuthorizationError();
      await this.assertSaved(account, sessionId);
      const token = await this.tokens.accessToken(account.id, oneDriveConnectionBinding(connection), signal);
      await this.assertSaved(account, sessionId);
      if (epoch !== this.epoch) throw new OneDriveAuthorizationError();
      return token;
    }, this.fetcher, undefined, undefined, this.lifetime.signal);
    return new OneDriveKeePassFileClient(identity, graph);
  }

  private savedGraph(account: ProviderAccount, connection: OneDriveConnection, sessionId: string): OneDriveGraphClient {
    const epoch = this.epoch;
    return new OneDriveGraphClient(async signal => {
      if (epoch !== this.epoch) throw new OneDriveAuthorizationError();
      await this.assertSaved(account, sessionId);
      const token = await this.tokens.accessToken(account.id, oneDriveConnectionBinding(connection), signal);
      await this.assertSaved(account, sessionId);
      if (epoch !== this.epoch) throw new OneDriveAuthorizationError();
      return token;
    }, this.fetcher, undefined, undefined, this.lifetime.signal);
  }

  private pendingGraph(loginId: string, pending: PendingLogin): OneDriveGraphClient {
    return new OneDriveGraphClient(async () => {
      await this.assertPending(loginId, pending);
      const connection = pending.connection;
      if (!connection || connection.tokens.expiresAt <= this.now() + 60_000) throw new OneDriveAuthorizationError("OneDrive 登录已过期，请重新登录。");
      return connection.tokens.accessToken;
    }, this.fetcher, undefined, undefined, pending.controller.signal);
  }

  private async requirePending(loginId: string): Promise<PendingLogin> {
    this.expire();
    const pending = this.pending.get(loginId);
    if (!pending?.connection || !pending.drive) throw new OneDriveAuthorizationError("OneDrive 登录已失效，请重新登录。");
    await this.assertPending(loginId, pending);
    return pending;
  }

  private async assertPending(loginId: string, pending: PendingLogin): Promise<void> {
    pending.controller.signal.throwIfAborted();
    if (this.pending.get(loginId) !== pending || pending.expiresAt <= this.now() || await this.vault.sessionId() !== pending.sessionId) {
      if (this.pending.get(loginId) === pending) this.cancel(loginId);
      else pending.controller.abort();
      throw new OneDriveAuthorizationError("密码库会话已变化，请重新登录 OneDrive。");
    }
    pending.controller.signal.throwIfAborted();
  }

  private async assertSaved(account: ProviderAccount, sessionId: string): Promise<void> {
    if (await this.requireSession() !== sessionId) throw new OneDriveAuthorizationError("密码库会话已变化，请重新解锁。");
    const current = await this.vault.getProvider(account.id);
    if (!current?.enabled || !sameProviderBinding(account, current)) throw new OneDriveAuthorizationError("OneDrive 密码源已变化，请重新连接。");
  }

  private async requireSession(): Promise<string> {
    const session = await this.vault.sessionId();
    if (!session) throw new OneDriveAuthorizationError("请先解锁 Monica 密码库。");
    return session;
  }
  private expire(): void { for (const [id, pending] of this.pending) if (pending.expiresAt <= this.now()) this.cancel(id); }
}
