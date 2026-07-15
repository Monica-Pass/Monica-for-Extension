import type { ProviderAccount, ProviderReference, VaultItem } from "../../core/model";
import type { ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { BitwardenClient, type BitwardenSessionConfig } from "./bitwarden-client";
import { decodeBitwardenCipher, encodeBitwardenCipher, encodeBitwardenPasskeyCipher, resolveBitwardenCipherKey } from "./bitwarden-cipher-codec";
import { resolveBitwardenOrganizationKeys } from "./bitwarden-organization";
import type { BitwardenSymmetricKey } from "./bitwarden-crypto";

export class BitwardenProvider implements ProviderAdapter {
  readonly kind = "bitwarden" as const;
  private readonly client: BitwardenClient;

  constructor(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
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
    const organizations = await resolveBitwardenOrganizationKeys(synced.payload, vaultKey);
    const remoteItems: VaultItem[] = [];
    const rawByCipherId = new Map<string, Record<string, unknown>>();
    const skippedCipherIds = new Set<string>();
    const warnings: string[] = [...organizations.warnings];
    for (const rawCipher of rawCiphers) {
      const cipherId = stringValue(rawCipher, "Id", "id");
      if (cipherId) rawByCipherId.set(cipherId, rawCipher);
      try {
        const ownerKey = cipherOwnerKey(rawCipher, vaultKey, organizations.keys);
        if (!ownerKey) {
          warnings.push(missingOrganizationKeyWarning(rawCipher, cipherId));
          if (cipherId) skippedCipherIds.add(cipherId);
          continue;
        }
        const decoded = await decodeBitwardenCipher(rawCipher, account.id, ownerKey);
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

    const localNew = localScoped.filter((item) => !providerReference(item, account.id)?.remoteId);
    const localByCipher = groupByCipher(localScoped.filter((item) => Boolean(providerReference(item, account.id)?.remoteId)), account.id);
    const remoteByCipher = groupByCipher(remoteItems, account.id);
    const cipherIds = new Set([...rawByCipherId.keys(), ...localByCipher.keys(), ...remoteByCipher.keys()]);
    const merged: VaultItem[] = [...unrelated];
    const conflicts: ProviderSyncResult["conflicts"] = [];

    for (const cipherId of cipherIds) {
      const locals = localByCipher.get(cipherId) || [];
      const remotes = remoteByCipher.get(cipherId) || [];
      if (skippedCipherIds.has(cipherId)) {
        merged.push(...locals);
        continue;
      }
      if (!locals.length) {
        merged.push(...remotes);
        continue;
      }
      const raw = rawByCipherId.get(cipherId);
      if (!raw) {
        for (const local of locals.filter((item) => itemChanged(item, account.id))) {
          conflicts.push({ itemId: local.id, reason: "此项目已在 Bitwarden 删除，但浏览器中也有未同步修改。", local });
        }
        merged.push(...locals.filter((item) => itemChanged(item, account.id)));
        continue;
      }
      const changes = locals.filter((item) => itemChanged(item, account.id));
      if (!changes.length) {
        merged.push(...remotes);
        continue;
      }
      const concurrent = changes.flatMap((local) => {
        const remote = findEquivalent(local, remotes);
        const reference = providerReference(local, account.id);
        return remote && remote.updatedAt !== reference?.revision && !sameVaultPayload(local, remote) ? [{ local, remote }] : [];
      });
      if (concurrent.length) {
        for (const entry of concurrent) conflicts.push({ itemId: entry.local.id, reason: "浏览器和 Bitwarden 在上次同步后都修改了此项目。", local: entry.local, remote: entry.remote });
        merged.push(...locals, ...remotes.filter((remote) => !locals.some((local) => Boolean(findEquivalent(local, [remote])))));
        continue;
      }
      try {
        const primary = changes.find((item) => item.kind !== "passkey");
        if (primary?.deletedAt) {
          session = await this.client.deleteCipher(session, cipherId, context.signal);
          continue;
        }
        const ownerKey = requireCipherOwnerKey(raw, vaultKey, organizations.keys);
        const cipherKey = await resolveBitwardenCipherKey(raw, ownerKey);
        let payload = primary ? await encodeBitwardenCipher(primary, cipherKey, raw) : raw;
        for (const passkey of changes.filter((item): item is Extract<VaultItem, { kind: "passkey" }> => item.kind === "passkey")) {
          payload = await encodeBitwardenPasskeyCipher(passkey, cipherKey, payload, passkey.deletedAt ? "delete" : "upsert");
        }
        const updated = await this.client.updateCipher(session, cipherId, payload, context.signal);
        session = updated.session;
        const decoded = await decodeBitwardenCipher(updated.payload, account.id, ownerKey);
        if (!decoded.items.length) throw new Error("Bitwarden 更新响应无法映射回 Monica 项目。");
        merged.push(...decoded.items);
      } catch (error) {
        for (const local of changes) conflicts.push({ itemId: local.id, reason: errorMessage(error), local, remote: findEquivalent(local, remotes) });
        merged.push(...locals);
      }
    }

    for (const local of localNew) {
      if (local.deletedAt) continue;
      try {
        const created = await this.createWithSession(session, account.id, local, context.signal);
        session = created.session;
        merged.push(...created.items);
      } catch (error) {
        conflicts.push({ itemId: local.id, reason: errorMessage(error), local });
        merged.push(local);
      }
    }

    return {
      items: merged.filter((item) => !item.deletedAt),
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
    const current = await this.client.sync(session, signal);
    const raw = arrayValue(current.payload, "Ciphers", "ciphers").map(record).find((cipher) => stringValue(cipher, "Id", "id") === cipherId);
    if (!raw) throw new Error("Bitwarden 远端 Cipher 不存在。");
    const vaultKey = this.client.vaultKey(current.session);
    const organizations = await resolveBitwardenOrganizationKeys(current.payload, vaultKey);
    const ownerKey = requireCipherOwnerKey(raw, vaultKey, organizations.keys);
    const cipherKey = await resolveBitwardenCipherKey(raw, ownerKey);
    const payload = item.kind === "passkey" ? await encodeBitwardenPasskeyCipher(item, cipherKey, raw) : await encodeBitwardenCipher(item, cipherKey, raw);
    const response = await this.client.updateCipher(current.session, cipherId, payload, signal);
    const decoded = await decodeBitwardenCipher(response.payload, account.id, ownerKey);
    return item.kind === "passkey"
      ? decoded.items.find((candidate) => candidate.kind === "passkey" && candidate.credentialId === item.credentialId) || item
      : decoded.items.find((candidate) => candidate.kind === item.kind) || item;
  }

  async remove(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<void> {
    const cipherId = baseCipherId(providerReference(item, account.id)?.remoteId);
    if (!cipherId) return;
    if (item.kind !== "passkey") {
      await this.client.deleteCipher(readSession(account), cipherId, signal);
      return;
    }
    const current = await this.client.sync(readSession(account), signal);
    const raw = arrayValue(current.payload, "Ciphers", "ciphers").map(record).find((cipher) => stringValue(cipher, "Id", "id") === cipherId);
    if (!raw) return;
    const vaultKey = this.client.vaultKey(current.session);
    const organizations = await resolveBitwardenOrganizationKeys(current.payload, vaultKey);
    const ownerKey = requireCipherOwnerKey(raw, vaultKey, organizations.keys);
    const cipherKey = await resolveBitwardenCipherKey(raw, ownerKey);
    await this.client.updateCipher(current.session, cipherId, await encodeBitwardenPasskeyCipher(item, cipherKey, raw, "delete"), signal);
  }

  private async createWithSession(session: BitwardenSessionConfig, providerId: string, item: VaultItem, signal?: AbortSignal): Promise<{ session: BitwardenSessionConfig; item: VaultItem; items: VaultItem[] }> {
    const vaultKey = this.client.vaultKey(session);
    const payload = item.kind === "passkey" ? await encodeBitwardenPasskeyCipher(item, vaultKey) : await encodeBitwardenCipher(item, vaultKey);
    const response = await this.client.createCipher(session, payload, signal);
    const decoded = await decodeBitwardenCipher(response.payload, providerId, vaultKey);
    const created = item.kind === "passkey"
      ? decoded.items.find((candidate) => candidate.kind === "passkey" && candidate.credentialId === item.credentialId)
      : decoded.items.find((candidate) => candidate.kind === item.kind);
    if (!created) throw new Error("Bitwarden 创建响应无法映射回 Monica 项目。");
    return { session: response.session, item: created, items: item.kind === "passkey" ? decoded.items : [created] };
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

function groupByCipher(items: VaultItem[], providerId: string): Map<string, VaultItem[]> {
  const groups = new Map<string, VaultItem[]>();
  for (const item of items) {
    const cipherId = baseCipherId(providerReference(item, providerId)?.remoteId);
    if (!cipherId) continue;
    groups.set(cipherId, [...(groups.get(cipherId) || []), item]);
  }
  return groups;
}

function itemChanged(item: VaultItem, providerId: string): boolean {
  const reference = providerReference(item, providerId);
  return Boolean(item.deletedAt) || item.updatedAt !== reference?.revision;
}

function findEquivalent(local: VaultItem, remotes: VaultItem[]): VaultItem | undefined {
  if (local.kind === "passkey") return remotes.find((remote) => remote.kind === "passkey" && remote.credentialId === local.credentialId);
  return remotes.find((remote) => remote.kind === local.kind);
}

function sameVaultPayload(left: VaultItem, right: VaultItem): boolean {
  const { providerRefs: _leftRefs, updatedAt: _leftUpdated, deletedAt: _leftDeleted, ...leftPayload } = left;
  const { providerRefs: _rightRefs, updatedAt: _rightUpdated, deletedAt: _rightDeleted, ...rightPayload } = right;
  return JSON.stringify(leftPayload) === JSON.stringify(rightPayload);
}

function cipherOwnerKey(
  raw: Record<string, unknown>,
  personalVaultKey: BitwardenSymmetricKey,
  organizationKeys: Map<string, BitwardenSymmetricKey>
): BitwardenSymmetricKey | undefined {
  const organizationId = stringValue(raw, "OrganizationId", "organizationId");
  return organizationId ? organizationKeys.get(organizationId) : personalVaultKey;
}

function requireCipherOwnerKey(
  raw: Record<string, unknown>,
  personalVaultKey: BitwardenSymmetricKey,
  organizationKeys: Map<string, BitwardenSymmetricKey>
): BitwardenSymmetricKey {
  const key = cipherOwnerKey(raw, personalVaultKey, organizationKeys);
  if (!key) throw new Error(missingOrganizationKeyWarning(raw, stringValue(raw, "Id", "id")));
  return key;
}

function missingOrganizationKeyWarning(raw: Record<string, unknown>, cipherId: string): string {
  const organizationId = stringValue(raw, "OrganizationId", "organizationId") || "unknown";
  return `Bitwarden 组织项目 ${cipherId || "unknown"} 的组织密钥 ${organizationId} 不可用，已保留本地缓存。`;
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
