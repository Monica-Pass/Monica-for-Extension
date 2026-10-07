import type { ProviderAccount } from "../core/model";
import type { SecureVaultService } from "../security/secure-vault-service";
import { VaultLockedError } from "../security/secure-vault-service";
import type { KeePassProvider, KeePassSessionSummary } from "../providers/keepass/keepass-provider";
import type { KeePassRemoteSessionService, KeePassOneDriveOpenInput } from "../providers/keepass/keepass-remote-session";
import type { KeePassWorkingCopyStorage, KeePassRemoteWorkingCopyRecord } from "../providers/keepass/keepass-working-copy-store";
import type { OneDriveSessionService } from "../providers/onedrive/onedrive-session";
import { normalizeOneDriveIdentity } from "../providers/onedrive/onedrive-graph-client";
import { parseOneDriveConnection } from "../providers/onedrive/onedrive-token-manager";

export interface KeePassOneDriveConnectInput extends KeePassOneDriveOpenInput {
  providerId?: string;
  loginId?: string;
  name: string;
  isDefaultSaveTarget?: boolean;
}
export interface KeePassOneDriveConnectResult {
  account: ProviderAccount;
  session: KeePassSessionSummary;
  workingCopyPreserved: boolean;
}

/** The caller serializes this with both provider sync and KDBX mutations. */
export class OneDriveKeePassConnections {
  constructor(
    private readonly vault: Pick<SecureVaultService, "getProvider" | "readState" | "upsertProvider" | "passkeySessionId">,
    private readonly provider: KeePassProvider,
    private readonly remote: KeePassRemoteSessionService,
    private readonly storage: KeePassWorkingCopyStorage,
    private readonly oneDrive: OneDriveSessionService,
    private readonly flushPendingMutations: (account: ProviderAccount) => Promise<void>
  ) {}

  async connect(input: KeePassOneDriveConnectInput): Promise<KeePassOneDriveConnectResult> {
    try { return await this.connectInSession(input); }
    finally { input.databasePassword = ""; input.keyFile = undefined; }
  }

  private async connectInSession(input: KeePassOneDriveConnectInput): Promise<KeePassOneDriveConnectResult> {
    const sessionId = await this.vault.passkeySessionId();
    if (!sessionId) throw new VaultLockedError();
    const identity = normalizeOneDriveIdentity(input);
    const existing = input.providerId ? await this.vault.getProvider(input.providerId) : undefined;
    if (input.providerId && !existing) throw new Error("密码源已被移除，请重新打开连接设置。");
    if (existing && (existing.kind !== "keepass" || existing.config.sourceMode !== "onedrive" ||
      existing.config.oneDriveDriveId !== identity.driveId || existing.config.oneDriveItemId !== identity.itemId)) {
      throw new Error("此连接对应另一个数据库。请新增 OneDrive 密码源以保留原数据库与修改。");
    }
    const previousConnection = parseOneDriveConnection(existing?.config.oneDriveConnection);
    const connection = input.loginId ? await this.oneDrive.connectionForLogin(input.loginId) : previousConnection;
    if (!connection) throw new Error("请先登录 OneDrive。");
    if (existing && (!previousConnection || connection.profile.id !== previousConnection.profile.id || connection.clientId !== previousConnection.clientId)) {
      throw new Error("登录账号与当前数据库不一致。请使用原账号登录，或新增密码源。");
    }
    // A same-account reauthorization keeps durable journals bound to this source.
    // The new interactive handle is discarded only after the encrypted commit.
    const savedConnection = { ...connection, id: previousConnection?.id || connection.id };
    // Failed durable writes may still live in the unlocked database. Persist their
    // receipts before taking the rollback snapshot or replacing that session.
    if (existing) {
      await this.flushPendingMutations(existing);
      if (this.provider.isUnlocked(existing.id) && this.provider.summarize(existing.id).dirty) {
        await this.remote.persistWorkingCopy(existing);
      }
    }
    const password = input.databasePassword || (typeof existing?.config.databasePassword === "string" ? existing.config.databasePassword : "");
    const keyFile = input.keyFile ?? (typeof existing?.config.keyFile === "string" ? existing.config.keyFile : undefined);
    const account: ProviderAccount = {
      id: existing?.id || crypto.randomUUID(), kind: "keepass", name: input.name.trim().slice(0, 256) || "KeePass OneDrive",
      enabled: true, isDefaultSaveTarget: Boolean(input.isDefaultSaveTarget), lastSyncAt: existing?.lastSyncAt,
      config: { ...existing?.config, databaseId: existing?.config.databaseId || Date.now(), sourceMode: "onedrive",
        oneDriveDriveId: identity.driveId, oneDriveItemId: identity.itemId, oneDriveConnection: connection }
    };
    const before = await this.storage.read(account.id);
    let savedRevision: number | undefined;
    let sessionReplaced = false;
    try {
      const credentialsChanged = existing && (password !== existing.config.databasePassword || keyFile !== existing.config.keyFile);
      const preserve = !!existing && !!before && !credentialsChanged;
      let session: KeePassSessionSummary;
      let config: Record<string, unknown>;
      if (preserve) {
        if (input.loginId && !await this.oneDrive.fileClient(account, identity).stat()) throw new Error("OneDrive 中找不到原数据库，本机修改已保留。");
        if (this.provider.isUnlocked(account.id)) {
          session = this.provider.summarize(account.id);
          config = { ...await this.remote.reconcileAccountConfig(existing!), oneDriveConnection: savedConnection };
        } else {
          sessionReplaced = true;
          const restored = await this.remote.restore(existing!);
          session = restored.session;
          config = { ...restored.accountConfig, oneDriveConnection: savedConnection };
        }
      } else {
        if (existing) {
          const state = await this.vault.readState(false);
          if ((before && before.baseSha256 !== before.workingSha256) || await this.storage.hasReceipts(account.id) ||
            state.mutationQueue.some(row => row.providerId === account.id) || state.providerConflicts.some(row => row.providerId === account.id)) {
            throw new Error("数据库仍有待同步修改。请先沿用现有数据库凭据重新登录并同步，再更改解锁凭据。");
          }
        }
        sessionReplaced = true;
        const opened = await this.remote.openOneDrive(account, { ...identity, databasePassword: password, keyFile });
        savedRevision = Number(opened.accountConfig.workingCopyRevision);
        session = opened.session;
        config = { ...opened.accountConfig, oneDriveConnection: savedConnection };
      }
      // Cancellation/lock after file decryption must still prevent a provider commit.
      if (input.loginId) await this.oneDrive.connectionForLogin(input.loginId);
      if (input.loginId) {
        delete config.remoteLastErrorCode;
        delete config.remoteLastErrorRetryable;
        delete config.remoteLastErrorAt;
      }
      const result = await this.vault.upsertProvider({ ...account, config, lastError: undefined }, true, existing,
        { sessionId, oneDriveReauthorization: !!existing && !!input.loginId });
      if (input.loginId) this.oneDrive.cancel(input.loginId);
      return { account: result, session, workingCopyPreserved: preserve };
    } catch (error) {
      if (sessionReplaced) this.provider.lockAccount(account.id);
      if (savedRevision !== undefined) await this.restoreWorkingCopy(account.id, savedRevision, before);
      throw error;
    } finally {
      before?.baseBytes.fill(0); before?.workingBytes.fill(0);
    }
  }

  private async restoreWorkingCopy(providerId: string, expectedRevision: number, previous?: KeePassRemoteWorkingCopyRecord): Promise<void> {
    const current = await this.storage.read(providerId);
    try {
      if (current?.revision !== expectedRevision) throw new Error("OneDrive 工作副本已变化，已保留最新副本，请重新打开密码源。");
      if (previous && current) {
        const restored = await this.storage.save(previous, current.revision);
        restored.baseBytes.fill(0); restored.workingBytes.fill(0);
      } else if (!previous) await this.storage.delete(providerId);
    } finally { current?.baseBytes.fill(0); current?.workingBytes.fill(0); }
  }
}
