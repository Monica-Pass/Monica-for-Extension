import type { ProviderAccount, ProviderReference, VaultItem } from "../../core/model";
import type { ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { BitwardenClient, type BitwardenSessionConfig } from "./bitwarden-client";
import { decodeBitwardenCipher, encodeBitwardenCipher, resolveBitwardenCipherKey } from "./bitwarden-cipher-codec";

export class BitwardenProvider implements ProviderAdapter {
  readonly kind = "bitwarden" as const;
  private readonly client: BitwardenClient;

  constructor(fetcher: typeof fetch = fetch) {
    this.client = new BitwardenClient(fetcher);
  }

  async testConnection(account: ProviderAccount, signal?: AbortSignal): Promise<void> {
    const config = readSession(account);
    await this.client.prelogin(config.vaultUrl, config.email, signal);
  }

  async sync(account: ProviderAccount, context: ProviderSyncContext): Promise<ProviderSyncResult> {
    let session = readSession(account);
    const synced = await this.client.sync(session, context.signal);
    session = synced.session;
    const rawCiphers = arrayValue(synced.payload, "Ciphers", "ciphers").map(record);
    const localScoped = context.localItems.filter((item) => hasProviderReference(item, account.id));
    const unrelated = context.localItems.filter((item) => !hasProviderReference(item, account.id));
    const hasExistingBaseline = localScoped.some((item) => Boolean(providerReference(item, account.id)?.revision));
    if (!rawCiphers.length && hasExistingBaseline) {
      return {
        items: context.localItems,
        accountPatch: { lastError: "Bitwarden 返回空密码库，已启用防误删保护。", config: session },
        conflicts: [{ itemId: account.id, reason: "Bitwarden 返回空密码库，但本地存在已同步项目。" }],
        warnings: ["Bitwarden 返回空密码库，未删除本地缓存；请确认服务器状态后重试。"]
      };
    }

    const vaultKey = this.client.vaultKey(session);
    const remoteItems: VaultItem[] = [];
    const rawByCipherId = new Map<string, Record<string, unknown>>();
    const skippedCipherIds = new Set<string>();
    const warnings: string[] = [];
    for (const rawCipher of rawCiphers) {
      const cipherId = stringValue(rawCipher, "Id", "id");
      if (cipherId) rawByCipherId.set(cipherId, rawCipher);
      try {
        const decoded = await decodeBitwardenCipher(rawCipher, account.id, vaultKey);
        remoteItems.push(...decoded.items);
        if (decoded.warning) {
          warnings.push(decoded.warning);
          if (cipherId) skippedCipherIds.add(cipherId);
        }
      } catch (error) {
        warnings.push(`Bitwarden Cipher ${cipherId || "unknown"} 解密失败：${errorMessage(error)}`);
        if (cipherId) skippedCipherIds.add(cipherId);
      }
    }

    const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
    const localById = new Map(localScoped.map((item) => [item.id, item]));
    const allIds = new Set([...remoteById.keys(), ...localById.keys()]);
    const merged: VaultItem[] = [];
    const conflicts: ProviderSyncResult["conflicts"] = [];

    for (const itemId of allIds) {
      const local = localById.get(itemId);
      const remote = remoteById.get(itemId);
      if (!local && remote) {
        merged.push(remote);
        continue;
      }
      if (!local) continue;
      const reference = providerReference(local, account.id);
      const cipherId = baseCipherId(reference?.remoteId);
      if (cipherId && skippedCipherIds.has(cipherId)) {
        merged.push(local);
        continue;
      }
      if (!remote) {
        if (!reference?.remoteId) {
          if (local.deletedAt) continue;
          try {
            const created = await this.createWithSession(session, account.id, local, context.signal);
            session = created.session;
            merged.push(created.item);
          } catch (error) {
            conflicts.push({ itemId: local.id, reason: errorMessage(error), local });
            merged.push(local);
          }
        } else if (local.updatedAt !== reference.revision || local.deletedAt) {
          conflicts.push({ itemId: local.id, reason: "此项目已在 Bitwarden 删除，但浏览器中也有未同步修改。", local });
          merged.push(local);
        }
        continue;
      }

      const localChanged = local.updatedAt !== reference?.revision || Boolean(local.deletedAt);
      const remoteChanged = remote.updatedAt !== reference?.revision;
      if (localChanged && remoteChanged && !sameVaultPayload(local, remote)) {
        conflicts.push({ itemId: local.id, reason: "浏览器和 Bitwarden 在上次同步后都修改了此项目。", local, remote });
        merged.push(local);
        continue;
      }
      if (!localChanged) {
        merged.push(remote);
        continue;
      }
      if (local.kind === "passkey") {
        conflicts.push({ itemId: local.id, reason: "Bitwarden Passkey 的独立更新将在 Passkey 阶段启用。", local, remote });
        merged.push(local);
        continue;
      }
      if (!cipherId) {
        conflicts.push({ itemId: local.id, reason: "Bitwarden 项目缺少远端 Cipher ID。", local, remote });
        merged.push(local);
        continue;
      }
      try {
        if (local.deletedAt) {
          session = await this.client.deleteCipher(session, cipherId, context.signal);
        } else {
          const raw = rawByCipherId.get(cipherId);
          if (!raw) throw new Error("Bitwarden 远端 Cipher 不存在。");
          const cipherKey = await resolveBitwardenCipherKey(raw, vaultKey);
          const payload = await encodeBitwardenCipher(local, cipherKey, raw);
          const updated = await this.client.updateCipher(session, cipherId, payload, context.signal);
          session = updated.session;
          const decoded = await decodeBitwardenCipher(updated.payload, account.id, vaultKey);
          const primary = decoded.items.find((item) => item.kind === local.kind);
          if (!primary) throw new Error("Bitwarden 更新响应无法映射回 Monica 项目。");
          merged.push(primary);
        }
      } catch (error) {
        conflicts.push({ itemId: local.id, reason: errorMessage(error), local, remote });
        merged.push(local);
      }
    }

    return {
      items: [...unrelated, ...merged.filter((item) => !item.deletedAt)],
      accountPatch: { config: session, lastSyncAt: context.now, lastError: conflicts.length ? `发现 ${conflicts.length} 个 Bitwarden 同步冲突。` : undefined },
      conflicts,
      warnings
    };
  }

  async create(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<VaultItem> {
    return (await this.createWithSession(readSession(account), account.id, item, signal)).item;
  }

  async update(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<VaultItem> {
    const session = readSession(account);
    const reference = providerReference(item, account.id);
    const cipherId = baseCipherId(reference?.remoteId);
    if (!cipherId) throw new Error("Bitwarden 项目缺少远端 Cipher ID。");
    if (item.kind === "passkey") throw new Error("Bitwarden Passkey 更新将在 Passkey 阶段启用。");
    const current = await this.client.sync(session, signal);
    const raw = arrayValue(current.payload, "Ciphers", "ciphers").map(record).find((cipher) => stringValue(cipher, "Id", "id") === cipherId);
    if (!raw) throw new Error("Bitwarden 远端 Cipher 不存在。");
    const vaultKey = this.client.vaultKey(current.session);
    const cipherKey = await resolveBitwardenCipherKey(raw, vaultKey);
    const response = await this.client.updateCipher(current.session, cipherId, await encodeBitwardenCipher(item, cipherKey, raw), signal);
    const decoded = await decodeBitwardenCipher(response.payload, account.id, vaultKey);
    return decoded.items.find((candidate) => candidate.kind === item.kind) || item;
  }

  async remove(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<void> {
    if (item.kind === "passkey") throw new Error("单独删除 Bitwarden Passkey 将在 Passkey 阶段启用。");
    const cipherId = baseCipherId(providerReference(item, account.id)?.remoteId);
    if (cipherId) await this.client.deleteCipher(readSession(account), cipherId, signal);
  }

  private async createWithSession(session: BitwardenSessionConfig, providerId: string, item: VaultItem, signal?: AbortSignal): Promise<{ session: BitwardenSessionConfig; item: VaultItem }> {
    if (item.kind === "passkey") throw new Error("Bitwarden Passkey 创建将在 Passkey 阶段启用。");
    const vaultKey = this.client.vaultKey(session);
    const response = await this.client.createCipher(session, await encodeBitwardenCipher(item, vaultKey), signal);
    const decoded = await decodeBitwardenCipher(response.payload, providerId, vaultKey);
    const created = decoded.items.find((candidate) => candidate.kind === item.kind);
    if (!created) throw new Error("Bitwarden 创建响应无法映射回 Monica 项目。");
    return { session: response.session, item: created };
  }
}

function readSession(account: ProviderAccount): BitwardenSessionConfig {
  const config = account.config as Partial<BitwardenSessionConfig>;
  const required = [config.vaultUrl, config.apiUrl, config.identityUrl, config.email, config.deviceId, config.accessToken, config.vaultKeyEnc, config.vaultKeyMac];
  if (required.some((value) => typeof value !== "string" || !value)) throw new Error("Bitwarden 密码源尚未完成登录。");
  if (!config.kdf || typeof config.expiresAt !== "number") throw new Error("Bitwarden 会话配置不完整。");
  return config as BitwardenSessionConfig;
}

function providerReference(item: VaultItem, providerId: string): ProviderReference | undefined {
  return item.providerRefs.find((reference) => reference.providerId === providerId);
}

function hasProviderReference(item: VaultItem, providerId: string): boolean {
  return Boolean(providerReference(item, providerId));
}

function baseCipherId(remoteId?: string): string | undefined {
  return remoteId?.split("#fido2:")[0] || undefined;
}

function sameVaultPayload(left: VaultItem, right: VaultItem): boolean {
  const { providerRefs: _leftRefs, updatedAt: _leftUpdated, deletedAt: _leftDeleted, ...leftPayload } = left;
  const { providerRefs: _rightRefs, updatedAt: _rightUpdated, deletedAt: _rightDeleted, ...rightPayload } = right;
  return JSON.stringify(leftPayload) === JSON.stringify(rightPayload);
}

function value(raw: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (name in raw) return raw[name];
  return undefined;
}

function stringValue(raw: Record<string, unknown>, ...names: string[]): string {
  const result = value(raw, ...names);
  return typeof result === "string" ? result : "";
}

function arrayValue(raw: Record<string, unknown>, ...names: string[]): unknown[] {
  const result = value(raw, ...names);
  return Array.isArray(result) ? result : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Bitwarden 操作失败。";
}
