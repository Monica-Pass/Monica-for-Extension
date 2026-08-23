import type { LoginItem, PendingMutation, ProviderAccount, ProviderMutationReceipt, ProviderReference, ProviderSourceRecord, VaultItem } from "../../core/model";
import type { ProviderAcknowledgedMutation, ProviderAdapter, ProviderSyncContext, ProviderSyncResult } from "../../core/provider";
import { BitwardenClient, type BitwardenSessionConfig } from "./bitwarden-client";
import { bitwardenSshComparableData, decodeBitwardenCipher, encodeBitwardenCipher, encodeBitwardenPasskeyCipher, mergeBitwardenCipherProjection, mergeBitwardenCustomFieldOccurrences, mergeBitwardenSshLocalMetadata, resolveBitwardenCipherKey } from "./bitwarden-cipher-codec";
import { bitwardenOrganizationRecords, resolveBitwardenOrganizationKeys } from "./bitwarden-organization";
import { decryptBitwardenString, encryptBitwardenString, type BitwardenSymmetricKey } from "./bitwarden-crypto";
import { generateOtpUri } from "../../core/totp";
import { parametersFromItem } from "../../core/login-otp";
import { bytesToBase64 } from "../../security/encoding";
import { createSourceRecord } from "../../core/source-records";
import { bitwardenMutationFingerprint } from "./bitwarden-durable-sync";
import { BitwardenAttachmentDownloadService } from "./bitwarden-attachments";
import { isSteamMaFileLogin, isSteamMaFileName, parseSteamMaFile, STEAM_MAFILE_MAX_BYTES } from "./bitwarden-steam-mafile";
import { PROVIDER_ATTACHMENT_CHUNK_BYTES, type ProviderAttachmentSummary } from "../attachments/attachment-contract";

export class BitwardenProvider implements ProviderAdapter {
  readonly kind = "bitwarden" as const;
  private readonly client: BitwardenClient;
  private readonly attachmentDownloads: BitwardenAttachmentDownloadService;

  constructor(fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {
    this.client = new BitwardenClient(fetcher);
    this.attachmentDownloads = new BitwardenAttachmentDownloadService({ fetcher });
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
    const pendingByItemId = context.pendingMutations === undefined
      ? undefined
      : boundedPendingMutations(context.pendingMutations, account.id);
    const receiptsByMutationId = boundedMutationReceipts(context.mutationReceipts || [], account.id);
    const acknowledgedByMutationId = boundedAcknowledgedMutations(context.acknowledgedMutations || []);
    const hasExistingBaseline = localScoped.some((item) => Boolean(providerReference(item, account.id)?.revision));
    const unsynchronizedForEmptyRemote = pendingByItemId === undefined
      ? localScoped.filter((item) => {
          const reference = providerReference(item, account.id);
          return !reference?.remoteId || item.updatedAt !== reference.revision;
        })
      : localScoped.filter((item) => pendingByItemId.has(item.id));
    if (!rawCiphers.length && hasExistingBaseline && !context.allowEmptyRemote) {
      return {
        items: context.localItems,
        accountPatch: { lastError: "Bitwarden 返回空密码库，已启用防误删保护。", config: bitwardenAccountConfig(session, synced.payload), requiresEmptyRemoteConfirmation: true },
        conflicts: [{ itemId: account.id, reason: "Bitwarden 返回空密码库，但本地存在已同步项目。" }],
        warnings: ["Bitwarden 返回空密码库，未删除本地缓存；请确认服务器状态后重试。"],
        sourceRecords: await bitwardenSourceRecords(rawCiphers, account.id)
      };
    }
    if (!rawCiphers.length && hasExistingBaseline && context.allowEmptyRemote && unsynchronizedForEmptyRemote.length) {
      return {
        items: context.localItems,
        accountPatch: {
          lastError: "Bitwarden 空密码库确认已暂停：浏览器仍有未同步修改。",
          config: bitwardenAccountConfig(session, synced.payload),
          requiresEmptyRemoteConfirmation: true
        },
        conflicts: unsynchronizedForEmptyRemote.map((local) => ({
          itemId: local.id,
          reason: "服务器为空，但此项目仍有未同步修改；已保留完整本地缓存。",
          local
        })),
        warnings: ["Bitwarden 空密码库确认未生效；请先处理本地修改或同步冲突。"],
        sourceRecords: await bitwardenSourceRecords(rawCiphers, account.id)
      };
    }

    const vaultKey = this.client.vaultKey(session);
    const resolvedFolderNames = await bitwardenFolderNames(synced.payload, vaultKey);
    const organizations = await resolveBitwardenOrganizationKeys(synced.payload, vaultKey);
    const remoteItems: VaultItem[] = [];
    const rawByCipherId = new Map<string, Record<string, unknown>>();
    const skippedCipherIds = new Set<string>();
    const warnings: string[] = [...organizations.warnings];
    let preservedUnsupportedRecords = 0;
    let unreadableRecords = 0;
    for (const rawCipher of rawCiphers) {
      const cipherId = stringValue(rawCipher, "Id", "id");
      if (cipherId) rawByCipherId.set(cipherId, rawCipher);
      try {
        const ownerKey = cipherOwnerKey(rawCipher, vaultKey, organizations.keys);
        if (!ownerKey) {
          warnings.push(missingOrganizationKeyWarning(rawCipher, cipherId));
          unreadableRecords += 1;
          if (cipherId) skippedCipherIds.add(cipherId);
          continue;
        }
        const folderId = stringValue(rawCipher, "FolderId", "folderId");
        const decoded = await decodeBitwardenCipher(rawCipher, account.id, ownerKey, resolvedFolderNames.get(folderId));
        const steamCarrier = decoded.items.find((item): item is LoginItem => item.kind === "login" && isSteamMaFileLogin(item));
        if (steamCarrier) {
          try {
            const hydrated = await hydrateBitwardenSteamMaFile(
              this.attachmentDownloads,
              account.id,
              steamCarrier,
              rawCipher,
              session,
              organizations.keys,
              context.signal
            );
            session = hydrated.session;
            const index = decoded.items.indexOf(steamCarrier);
            decoded.items[index] = { ...steamCarrier, ...hydrated.fields };
          } catch (error) {
            warnings.push(`Bitwarden Steam 项目 ${steamCarrier.title} 的 maFile 附件读取失败：${errorMessage(error)}`);
          }
        }
        remoteItems.push(...decoded.items);
        if (decoded.warning) {
          warnings.push(decoded.warning);
          if (decoded.unsupported) preservedUnsupportedRecords += 1;
          else unreadableRecords += 1;
          if (cipherId) skippedCipherIds.add(cipherId);
        }
      } catch (error) {
        warnings.push(`Bitwarden Cipher ${cipherId || "unknown"} 解密失败：${errorMessage(error)}`);
        unreadableRecords += 1;
        if (cipherId) skippedCipherIds.add(cipherId);
      }
    }

    const acknowledgedMutations: ProviderAcknowledgedMutation[] = [];
    const acknowledgedByItemId = new Map<string, ProviderAcknowledgedMutation>();
    const recoveredRemoteByItemId = new Map<string, VaultItem>();
    const claimedRemoteIds = new Set(localScoped.flatMap((item) => {
      const remoteId = providerReference(item, account.id)?.remoteId;
      return remoteId ? [baseCipherId(remoteId)!] : [];
    }));
    const blockedMutationIds = new Set<string>();
    const recoveryConflicts: ProviderSyncResult["conflicts"] = [];
    const requestedMutations: NonNullable<ProviderSyncResult["requestedMutations"]> = [];
    const fingerprintCache = new Map<string, string>();
    const remoteFingerprint = async (item: VaultItem): Promise<string> => {
      const key = `${item.id}:${item.updatedAt}`;
      const cached = fingerprintCache.get(key);
      if (cached) return cached;
      const value = await bitwardenMutationFingerprint(item);
      fingerprintCache.set(key, value);
      return value;
    };
    const registerAcknowledgement = async (
      receipt: ProviderMutationReceipt | undefined,
      mutation: ProviderAcknowledgedMutation,
      remote?: VaultItem
    ): Promise<void> => {
      if (acknowledgedByItemId.has(mutation.itemId)) return;
      const local = localScoped.find((item) => item.id === mutation.itemId);
      const followUp = Boolean(receipt && local && (
        (receipt.operation === "delete" && !local.deletedAt)
        || (await bitwardenMutationFingerprint(local)) !== receipt.intentFingerprint
      ));
      const acknowledged = followUp ? { ...mutation, followUp: true } : mutation;
      acknowledgedMutations.push(acknowledged);
      acknowledgedByItemId.set(mutation.itemId, acknowledged);
      if (remote) recoveredRemoteByItemId.set(mutation.itemId, remote);
    };

    for (const [mutationId, acknowledgement] of acknowledgedByMutationId) {
      const receipt = receiptsByMutationId.get(mutationId);
      const remoteId = acknowledgement.remoteId;
      const remote = remoteItems.find((item) => baseCipherId(providerReference(item, account.id)?.remoteId) === baseCipherId(remoteId)
        && (acknowledgement.operation === "delete" || !receipt || item.kind === (localScoped.find((candidate) => candidate.id === acknowledgement.itemId)?.kind)));
      if (!remote && acknowledgement.operation !== "delete") {
        blockedMutationIds.add(mutationId);
        recoveryConflicts.push({ itemId: acknowledgement.itemId, reason: "Bitwarden 持久同步回执指向的 Cipher 已无法在远端确认。", local: localScoped.find((item) => item.id === acknowledgement.itemId) });
        continue;
      }
      await registerAcknowledgement(receipt, acknowledgement, remote);
    }

    for (const receipt of receiptsByMutationId.values()) {
      if (acknowledgedByItemId.has(receipt.itemId) || receipt.stage !== "attempted") continue;
      const local = localScoped.find((item) => item.id === receipt.itemId);
      const remoteId = receipt.remoteId ? baseCipherId(receipt.remoteId) : undefined;
      if (receipt.operation === "delete") {
        const raw = remoteId ? rawByCipherId.get(remoteId) : undefined;
        if ((!raw || Boolean(stringValue(raw, "DeletedDate", "deletedDate"))) && receipt.remoteId) {
          await registerAcknowledgement(receipt, { mutationId: receipt.mutationId, itemId: receipt.itemId, operation: "delete", remoteId: receipt.remoteId });
        }
        continue;
      }
      if (receipt.operation === "update" && remoteId) {
        const candidate = remoteItems.find((item) => baseCipherId(providerReference(item, account.id)?.remoteId) === remoteId && (!local || findEquivalent(local, [item])));
        if (candidate && await remoteFingerprint(candidate) === receipt.intentFingerprint) {
          await registerAcknowledgement(receipt, { mutationId: receipt.mutationId, itemId: receipt.itemId, operation: "update", remoteId: providerReference(candidate, account.id)?.remoteId || receipt.remoteId! }, candidate);
        }
        continue;
      }
      if (receipt.operation === "create") {
        const matches: VaultItem[] = [];
        for (const candidate of remoteItems) {
          if (local && candidate.kind !== local.kind) continue;
          const candidateRemoteId = providerReference(candidate, account.id)?.remoteId;
          if (!candidateRemoteId || (claimedRemoteIds.has(baseCipherId(candidateRemoteId)!) && baseCipherId(candidateRemoteId) !== remoteId)) continue;
          if (await remoteFingerprint(candidate) === receipt.intentFingerprint) matches.push(candidate);
          if (matches.length > 1) break;
        }
        if (matches.length === 1) {
          const candidate = matches[0];
          const candidateRemoteId = providerReference(candidate, account.id)?.remoteId;
          if (candidateRemoteId) await registerAcknowledgement(receipt, { mutationId: receipt.mutationId, itemId: receipt.itemId, operation: "create", remoteId: candidateRemoteId }, candidate);
        } else if (matches.length > 1 || receipt.attemptCount > 0) {
          blockedMutationIds.add(receipt.mutationId);
          recoveryConflicts.push({
            itemId: receipt.itemId,
            reason: matches.length > 1
              ? "Bitwarden 创建操作的远端匹配不唯一，已停止重试以避免重复 Cipher。"
              : "Bitwarden 创建操作的结果未知，已停止重试以避免重复 Cipher。",
            local
          });
        }
      }
    }

    const scopedForMerge = localScoped.map((item) => {
      const acknowledgement = acknowledgedByItemId.get(item.id);
      const remote = recoveredRemoteByItemId.get(item.id);
      return acknowledgement ? withRecoveredReference(item, account.id, acknowledgement.remoteId, remote) : item;
    });
    const deferredCreations = localScoped.filter((item) =>
      !providerReference(item, account.id)?.remoteId
      && !acknowledgedByItemId.has(item.id)
      && !item.deletedAt
      && Boolean(pendingByItemId && !pendingByItemId.has(item.id))
    );
    const localNew = localScoped.filter((item) =>
      !providerReference(item, account.id)?.remoteId
      && !acknowledgedByItemId.has(item.id)
      && (!pendingByItemId || pendingByItemId.has(item.id))
    );
    const localByCipher = groupByCipher(scopedForMerge.filter((item) => Boolean(providerReference(item, account.id)?.remoteId)), account.id);
    const remoteByCipher = groupByCipher(remoteItems, account.id);
    const cipherIds = new Set([...rawByCipherId.keys(), ...localByCipher.keys(), ...remoteByCipher.keys()]);
    const merged: VaultItem[] = [...unrelated, ...deferredCreations];
    const conflicts: ProviderSyncResult["conflicts"] = [...recoveryConflicts];

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
      const customFieldMigration = prepareBitwardenCustomFieldMigration(locals, remotes, account.id, context.now, pendingByItemId);
      requestedMutations.push(...customFieldMigration.requestedMutations);
      const workingLocals = customFieldMigration.locals;
      const raw = rawByCipherId.get(cipherId);
      if (!raw) {
        for (const local of workingLocals.filter((item) => itemChanged(item, account.id))) {
          const pending = pendingByItemId?.get(local.id);
          if (local.deletedAt && pending && providerReference(local, account.id)?.remoteId) {
            await registerAcknowledgement(
              receiptsByMutationId.get(pending.id),
              { mutationId: pending.id, itemId: local.id, operation: "delete", remoteId: providerReference(local, account.id)!.remoteId! }
            );
          } else {
            conflicts.push({ itemId: local.id, reason: "此项目已在 Bitwarden 删除，但浏览器中也有未同步修改。", local });
          }
        }
        merged.push(...workingLocals.filter((item) => itemChanged(item, account.id)));
        continue;
      }
      const changes = workingLocals.filter((item) => {
        if (acknowledgedByItemId.has(item.id) || blockedMutationIds.has(pendingByItemId?.get(item.id)?.id || "")) return false;
        if (pendingByItemId && !pendingByItemId.has(item.id)) return false;
        return itemChanged(item, account.id) || customFieldMigration.forcedItemIds.has(item.id);
      });
      const deferredChanges = workingLocals.filter((item) => {
        if (acknowledgedByItemId.has(item.id) || blockedMutationIds.has(pendingByItemId?.get(item.id)?.id || "")) return false;
        if (!itemChanged(item, account.id) && !customFieldMigration.forcedItemIds.has(item.id)) return false;
        return Boolean(pendingByItemId && !pendingByItemId.has(item.id));
      });
      for (const deferred of deferredChanges) {
        const remote = findEquivalent(deferred, remotes);
        const reference = providerReference(deferred, account.id);
        if (remote && reference?.revision && remote.updatedAt !== reference.revision && !sameVaultPayload(deferred, remote)) {
          conflicts.push({ itemId: deferred.id, reason: "Bitwarden 在浏览器修改排队期间又修改了同一项目。", local: deferred, remote });
        }
      }
      if (!changes.length) {
        merged.push(...rebaseRemoteItems(remotes, workingLocals, account.id, deferredChanges));
        continue;
      }
      const concurrent = changes.flatMap((local) => {
        const remote = findEquivalent(local, remotes);
        const reference = providerReference(local, account.id);
        return remote && remote.updatedAt !== reference?.revision && !sameVaultPayload(local, remote) ? [{ local, remote }] : [];
      });
      if (concurrent.length) {
        for (const entry of concurrent) conflicts.push({ itemId: entry.local.id, reason: "浏览器和 Bitwarden 在上次同步后都修改了此项目。", local: entry.local, remote: entry.remote });
        merged.push(...workingLocals, ...remotes.filter((remote) => !workingLocals.some((local) => Boolean(findEquivalent(local, [remote])))));
        continue;
      }
      try {
        const changedTotp = changes.find((item): item is Extract<VaultItem, { kind: "totp" }> => item.kind === "totp");
        let primary = changes.find((item): item is Extract<VaultItem, { kind: "login" }> => item.kind === "login");
        if (!primary && changedTotp) {
          const remoteLogin = remotes.find((item): item is LoginItem => item.kind === "login");
          if (remoteLogin) primary = projectTotpIntoLogin(remoteLogin, changedTotp);
        } else if (primary && changedTotp) {
          primary = projectTotpIntoLogin(primary, changedTotp);
        }
        const trashedRemotely = Boolean(stringValue(raw, "DeletedDate", "deletedDate"));
        if (primary?.deletedAt) {
          // Monica's local delete is a recycle-bin tombstone, so the remote copy has to land in
          // Bitwarden's recycle bin as well. `DELETE /ciphers/{id}` purges it irreversibly.
          await markMutationsAttempted(context, changes, pendingByItemId);
          if (!trashedRemotely) {
            session = await this.client.softDeleteCipher(session, cipherId, context.signal);
            rawByCipherId.set(cipherId, withBitwardenDeletedDate(raw, context.now));
          }
          for (const change of changes) {
            const pending = pendingByItemId?.get(change.id);
            const remoteId = providerReference(change, account.id)?.remoteId;
            if (pending && remoteId) {
              await registerAcknowledgement(receiptsByMutationId.get(pending.id), { mutationId: pending.id, itemId: change.id, operation: "delete", remoteId });
            }
          }
          const deletedAt = primary.deletedAt || context.now;
          const tombstones = (remotes.length ? remotes : workingLocals).map((item) => ({ ...item, deletedAt })) as VaultItem[];
          merged.push(...rebaseRemoteItems(tombstones, workingLocals, account.id));
          continue;
        }
        // A live local item over a trashed Cipher means the item came back; Bitwarden rejects
        // edits to trashed Ciphers, so restore before writing rather than silently dropping.
        const current = trashedRemotely ? await this.restoreCipher(session, cipherId, raw, context.signal) : { session, raw };
        session = current.session;
        rawByCipherId.set(cipherId, current.raw);
        const ownerKey = requireCipherOwnerKey(current.raw, vaultKey, organizations.keys);
        const cipherKey = await resolveBitwardenCipherKey(current.raw, ownerKey);
        let payload = primary ? await encodeBitwardenCipher(primary, cipherKey, current.raw) : current.raw;
        for (const passkey of changes.filter((item): item is Extract<VaultItem, { kind: "passkey" }> => item.kind === "passkey")) {
          payload = await encodeBitwardenPasskeyCipher(passkey, cipherKey, payload, passkey.deletedAt ? "delete" : "upsert");
        }
        await markMutationsAttempted(context, changes, pendingByItemId);
        const updated = await this.client.updateCipher(session, cipherId, payload, context.signal);
        session = updated.session;
        requireBitwardenMutationRevision(updated.payload, stringValue(current.raw, "RevisionDate", "revisionDate"), "更新");
        // The encoded request already contains the complete preserved Cipher
        // with the current plaintext changes. Merge a possibly reduced server
        // acknowledgement over that projection, never over the stale pre-write
        // Cipher or PascalCase nested values could shadow the update.
        const finalRaw = mergeBitwardenCipherProjection(payload, updated.payload);
        rawByCipherId.set(cipherId, finalRaw);
        const decoded = await decodeBitwardenCipher(finalRaw, account.id, ownerKey);
        if (!decoded.items.length) throw new Error("Bitwarden 更新响应无法映射回 Monica 项目。");
        merged.push(...rebaseRemoteItems(decoded.items, workingLocals, account.id));
        for (const change of changes) {
          const pending = pendingByItemId?.get(change.id);
          const candidate = decoded.items.find((item) => findEquivalent(change, [item]));
          const remoteId = candidate && providerReference(candidate, account.id)?.remoteId;
          if (pending && remoteId) {
            await registerAcknowledgement(receiptsByMutationId.get(pending.id), { mutationId: pending.id, itemId: change.id, operation: pending.operation, remoteId }, candidate);
          }
        }
      } catch (error) {
        for (const local of changes) conflicts.push({ itemId: local.id, reason: errorMessage(error), local, remote: findEquivalent(local, remotes) });
        merged.push(...workingLocals);
      }
    }

    for (const local of localNew) {
      if (local.deletedAt || blockedMutationIds.has(pendingByItemId?.get(local.id)?.id || "")) {
        if (local.deletedAt) merged.push(local);
        continue;
      }
      try {
        await markMutationsAttempted(context, [local], pendingByItemId);
        const created = await this.createWithSession(session, account.id, local, context.signal);
        session = created.session;
        const createdCipherId = baseCipherId(providerReference(created.item, account.id)?.remoteId);
        if (createdCipherId) rawByCipherId.set(createdCipherId, created.raw);
        merged.push(...created.items);
        const pending = pendingByItemId?.get(local.id);
        const createdItem = created.items.find((item) => findEquivalent(local, [item]));
        const remoteId = createdItem && providerReference(createdItem, account.id)?.remoteId;
        if (pending && remoteId) {
          await registerAcknowledgement(receiptsByMutationId.get(pending.id), { mutationId: pending.id, itemId: local.id, operation: pending.operation, remoteId }, createdItem);
        }
      } catch (error) {
        conflicts.push({ itemId: local.id, reason: errorMessage(error), local });
        merged.push(local);
      }
    }

    return {
      items: merged,
      accountPatch: {
        config: bitwardenAccountConfig(session, synced.payload),
        lastSyncAt: context.now,
        lastError: conflicts.length ? `发现 ${conflicts.length} 个 Bitwarden 同步冲突。` : undefined,
        requiresEmptyRemoteConfirmation: false,
        compatibility: { preservedUnsupportedRecords, unreadableRecords }
      },
      conflicts,
      warnings,
      sourceRecords: await bitwardenSourceRecords([...rawByCipherId.values()], account.id),
      acknowledgedMutations,
      requestedMutations: requestedMutations.length ? requestedMutations : undefined,
      adoptRemoteRemovals: Boolean(context.allowEmptyRemote && !rawCiphers.length && hasExistingBaseline)
    };
  }

  async create(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<VaultItem> {
    return (await this.createWithSession(readSession(account), account.id, item, signal)).item;
  }

  async update(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<VaultItem> {
    let session = readSession(account);
    const routed = await this.ensureCategoryFolder(session, account.id, item, signal);
    session = routed.session;
    item = routed.item;
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
    const decodedCurrent = await decodeBitwardenCipher(raw, account.id, ownerKey);
    const payloadItem = item.kind === "totp"
      ? projectTotpIntoLogin(decodedCurrent.items.find((candidate): candidate is LoginItem => candidate.kind === "login") || createLoginFromTotp(item), item)
      : item;
    const payload = payloadItem.kind === "passkey" ? await encodeBitwardenPasskeyCipher(payloadItem, cipherKey, raw) : await encodeBitwardenCipher(payloadItem, cipherKey, raw);
    const response = await this.client.updateCipher(current.session, cipherId, payload, signal);
    const decoded = await decodeBitwardenCipher(response.payload, account.id, ownerKey);
    const result = item.kind === "passkey"
      ? decoded.items.find((candidate) => candidate.kind === "passkey" && candidate.credentialId === item.credentialId) || item
      : item.kind === "totp"
        ? decoded.items.find((candidate) => candidate.kind === "totp") || item
        : decoded.items.find((candidate) => candidate.kind === item.kind) || item;
    return { ...result, categoryName: item.categoryName, providerRefs: item.providerRefs } as VaultItem;
  }

  async remove(account: ProviderAccount, item: VaultItem, signal?: AbortSignal): Promise<void> {
    const cipherId = baseCipherId(providerReference(item, account.id)?.remoteId);
    if (!cipherId) return;
    if (item.kind !== "passkey") {
      await this.client.softDeleteCipher(readSession(account), cipherId, signal);
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

  private async restoreCipher(
    session: BitwardenSessionConfig,
    cipherId: string,
    raw: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<{ session: BitwardenSessionConfig; raw: Record<string, unknown> }> {
    const restored = await this.client.restoreCipher(session, cipherId, signal);
    // A 200 with an empty body is a valid restore acknowledgement on some server builds, so fall
    // back to the synced Cipher with its trash markers cleared rather than failing the write.
    const payload = stringValue(restored.payload, "Id", "id") ? restored.payload : { ...raw, DeletedDate: null, deletedDate: null };
    return { session: restored.session, raw: payload };
  }

  private async createWithSession(session: BitwardenSessionConfig, providerId: string, item: VaultItem, signal?: AbortSignal): Promise<{ session: BitwardenSessionConfig; item: VaultItem; items: VaultItem[]; raw: Record<string, unknown> }> {
    const routed = await this.ensureCategoryFolder(session, providerId, item, signal);
    session = routed.session;
    item = routed.item;
    const vaultKey = this.client.vaultKey(session);
    const payloadItem = item.kind === "totp" ? createLoginFromTotp(item) : item;
    const payload = payloadItem.kind === "passkey" ? await encodeBitwardenPasskeyCipher(payloadItem, vaultKey) : await encodeBitwardenCipher(payloadItem, vaultKey);
    const response = await this.client.createCipher(session, payload, signal);
    requireBitwardenMutationRevision(response.payload, undefined, "创建");
    const decoded = await decodeBitwardenCipher(response.payload, providerId, vaultKey);
    const created = item.kind === "passkey"
      ? decoded.items.find((candidate) => candidate.kind === "passkey" && candidate.credentialId === item.credentialId)
      : item.kind === "totp"
        ? decoded.items.find((candidate) => candidate.kind === "totp")
        : decoded.items.find((candidate) => candidate.kind === item.kind);
    if (!created) throw new Error("Bitwarden 创建响应无法映射回 Monica 项目。");
    // Bitwarden assigns the cipher ID, not Monica's item ID. Keep the latter
    // stable so an edit made while this request was in flight still targets the
    // same local record; only the provider reference is acknowledged here.
    const canonical = withCreatedReference(item, created, providerId);
    const items = item.kind === "passkey"
      ? decoded.items.map((candidate) => candidate.kind === "passkey" && candidate.credentialId === item.credentialId ? canonical : candidate)
      : item.kind === "totp"
        ? decoded.items.map((candidate) => candidate.kind === "totp" ? canonical : candidate)
      : [canonical];
    return { session: response.session, item: canonical, items, raw: response.payload };
  }

  private async ensureCategoryFolder(session: BitwardenSessionConfig, providerId: string, item: VaultItem, signal?: AbortSignal): Promise<{ session: BitwardenSessionConfig; item: VaultItem }> {
    const category = item.categoryName?.trim();
    if (!category) return { session, item };
    const vaultKey = this.client.vaultKey(session);
    const listed = await this.client.listFolders(session, signal);
    session = listed.session;
    for (const entry of arrayValue(listed.payload, "Data", "data", "Folders", "folders")) {
      const folder = record(entry);
      const id = stringValue(folder, "Id", "id");
      if (!id) continue;
      try {
        const name = (await decryptBitwardenString(stringValue(folder, "Name", "name"), vaultKey)).trim();
        if (name === category) return { session, item: withFolderReference(item, providerId, id) };
      } catch { /* Keep searching; malformed folder metadata must not block unrelated writes. */ }
    }
    const created = await this.client.createFolder(session, { name: await encryptBitwardenString(category, vaultKey) }, signal);
    const createdId = stringValue(created.payload, "Id", "id");
    if (!createdId) throw new Error("Bitwarden 文件夹创建响应缺少 ID。");
    return { session: created.session, item: withFolderReference(item, providerId, createdId) };
  }
}

function withFolderReference(item: VaultItem, providerId: string, folderId: string): VaultItem {
  const matched = item.providerRefs.some((reference) => reference.providerId === providerId);
  return {
    ...item,
    providerRefs: matched
      ? item.providerRefs.map((reference) => reference.providerId === providerId ? { ...reference, remoteFolderId: folderId } : reference)
      : [...item.providerRefs, { providerId, remoteFolderId: folderId }]
  } as VaultItem;
}

async function hydrateBitwardenSteamMaFile(
  downloads: BitwardenAttachmentDownloadService,
  providerId: string,
  item: LoginItem,
  rawCipher: Record<string, unknown>,
  initialSession: BitwardenSessionConfig,
  organizationKeys: ReadonlyMap<string, BitwardenSymmetricKey>,
  signal?: AbortSignal
): Promise<{ fields: Partial<LoginItem>; session: BitwardenSessionConfig }> {
  let cursor: string | undefined;
  const attachments: ProviderAttachmentSummary[] = [];
  do {
    const page = await downloads.listAttachments({ providerId, itemId: item.id, session: initialSession, rawCipher, organizationKeys }, { pageSize: 50, cursor });
    attachments.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  const candidates = attachments
    .filter((attachment) => attachment.sizeBytes > 0 && attachment.sizeBytes <= STEAM_MAFILE_MAX_BYTES)
    .sort((left, right) => Number(isSteamMaFileName(right.fileName)) - Number(isSteamMaFileName(left.fileName)) || right.sizeBytes - left.sizeBytes);
  if (!candidates.length) throw new Error("已标记 Steam 项目，但没有可读取的 maFile 附件。");

  let session = initialSession;
  let lastError: unknown;
  for (const attachment of candidates) {
    let readHandle = "";
    const chunks: Uint8Array[] = [];
    try {
      const started = await downloads.beginDownload({ providerId, itemId: item.id, session, rawCipher, organizationKeys, attachmentId: attachment.attachmentId, signal });
      session = started.session;
      readHandle = started.readHandle;
      let offset = 0;
      while (offset < started.sizeBytes) {
        const chunk = downloads.readChunk(providerId, readHandle, offset, Math.min(PROVIDER_ATTACHMENT_CHUNK_BYTES, started.sizeBytes - offset));
        chunks.push(chunk.bytes);
        offset = chunk.nextOffset;
        if (chunk.eof) break;
      }
      const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let writeOffset = 0;
      for (const chunk of chunks) { bytes.set(chunk, writeOffset); writeOffset += chunk.length; chunk.fill(0); }
      try {
        const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return { fields: await parseSteamMaFile(json, attachment.fileName), session };
      } finally {
        bytes.fill(0);
      }
    } catch (error) {
      lastError = error;
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      if (readHandle) downloads.release(providerId, readHandle);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Steam maFile 附件无法解析。");
}

function withCreatedReference(local: VaultItem, created: VaultItem, providerId: string): VaultItem {
  const reference = providerReference(created, providerId);
  if (!reference?.remoteId) throw new Error("Bitwarden 创建响应缺少远端 Cipher ID。");
  return {
    ...local,
    updatedAt: created.updatedAt,
    ...(local.kind === "login" && created.kind === "login"
      ? {
          bitwardenCustomFieldsVersion: created.bitwardenCustomFieldsVersion,
          bitwardenSshKeyMode: created.bitwardenSshKeyMode
        }
      : {}),
    providerRefs: [...local.providerRefs.filter((candidate) => candidate.providerId !== providerId), reference]
  } as VaultItem;
}

function prepareBitwardenCustomFieldMigration(
  locals: VaultItem[],
  remotes: VaultItem[],
  providerId: string,
  now: string,
  pendingByItemId: Map<string, PendingMutation> | undefined
): { locals: VaultItem[]; forcedItemIds: Set<string>; requestedMutations: NonNullable<ProviderSyncResult["requestedMutations"]> } {
  const local = locals.find((item): item is LoginItem => item.kind === "login");
  const remote = remotes.find((item): item is LoginItem => item.kind === "login");
  const forcedItemIds = new Set<string>();
  const requestedMutations: NonNullable<ProviderSyncResult["requestedMutations"]> = [];
  if (!local || !remote || local.bitwardenCustomFieldsVersion === 1) return { locals, forcedItemIds, requestedMutations };
  if (providerReference(local, providerId)?.revision !== remote.updatedAt) return { locals, forcedItemIds, requestedMutations };

  const migration = mergeBitwardenCustomFieldOccurrences(remote.customFields, local.customFields);
  const mustQueue = migration.needsUpload && pendingByItemId !== undefined && !pendingByItemId.has(local.id);
  const migrated: LoginItem = {
    ...local,
    customFields: migration.fields,
    ...(mustQueue ? { bitwardenCustomFieldsVersion: 1, updatedAt: now } : {})
  };
  if (migration.needsUpload && !mustQueue) forcedItemIds.add(local.id);
  if (mustQueue) requestedMutations.push({ itemId: local.id, operation: "update" });
  return {
    locals: locals.map((item) => item.id === local.id ? migrated : item),
    forcedItemIds,
    requestedMutations
  };
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

async function bitwardenSourceRecords(ciphers: Record<string, unknown>[], providerId: string): Promise<ProviderSourceRecord[]> {
  const records = ciphers.flatMap((cipher) => {
    const remoteId = stringValue(cipher, "Id", "id");
    if (!remoteId) return [];
    return [{ cipher, remoteId, payload: JSON.stringify(cipher) }];
  });
  return Promise.all(records.map(({ cipher, remoteId, payload }) => createSourceRecord({
    providerId,
    remoteId,
    revision: stringValue(cipher, "RevisionDate", "revisionDate") || undefined,
    format: "bitwarden-cipher",
    encoding: "json",
    payload
  })));
}

function hasProviderReference(item: VaultItem, providerId: string): boolean {
  return Boolean(providerReference(item, providerId));
}

function baseCipherId(remoteId?: string): string | undefined {
  return remoteId?.replace(/#(?:fido2:.*|totp)$/, "") || undefined;
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

function projectTotpIntoLogin(login: LoginItem, totp: Extract<VaultItem, { kind: "totp" }>): LoginItem {
  const parameters = parametersFromItem(totp);
  return {
    ...login,
    totpSecret: generateOtpUri(parameters, [totp.issuer, totp.accountName].filter(Boolean).join(":")),
    updatedAt: totp.updatedAt,
    deletedAt: totp.deletedAt,
    archivedAt: totp.archivedAt
  };
}

function createLoginFromTotp(totp: Extract<VaultItem, { kind: "totp" }>): LoginItem {
  return {
    id: totp.id,
    kind: "login",
    title: totp.title,
    favorite: totp.favorite,
    notes: totp.notes,
    createdAt: totp.createdAt,
    updatedAt: totp.updatedAt,
    username: totp.accountName || "",
    password: "",
    uris: [],
    uriRules: [],
    totpSecret: generateOtpUri(parametersFromItem(totp), [totp.issuer, totp.accountName].filter(Boolean).join(":")),
    customFields: [],
    providerRefs: totp.providerRefs.map((reference) => ({ ...reference, remoteId: undefined }))
  };
}

/**
 * A Bitwarden FIDO2 credential is a child of its login Cipher, so decoding a server response derives a
 * fresh deterministic item ID. Monica may already have assigned a different local ID when that Passkey
 * was created in the browser. Preserve that identity across every later sync or the secure-vault merge
 * sees one deletion plus one insertion, duplicates the credential, and a later delete becomes a false
 * concurrent-edit conflict.
 */
function rebaseRemoteItems(remotes: VaultItem[], locals: VaultItem[], providerId: string, deferred: VaultItem[] = []): VaultItem[] {
  return remotes.map((remote) => {
    const local = locals.find((candidate) => Boolean(findEquivalent(candidate, [remote])));
    if (!local) return remote;
    if (deferred.some((candidate) => candidate.id === local.id)) return withRecoveredReference(local, providerId, providerReference(remote, providerId)?.remoteId || "", remote);
    if (local.kind === "passkey" && remote.kind === "passkey") {
      return {
        ...remote,
        id: local.id,
        publicKey: remote.publicKey || local.publicKey,
        userVerificationRequired: local.userVerificationRequired,
        transports: local.transports,
        aaguid: local.aaguid,
        lastUsedAt: local.lastUsedAt,
        useCount: local.useCount,
        iconUrl: local.iconUrl,
        boundPasswordId: local.boundPasswordId,
        passkeyMode: local.passkeyMode
      };
    }
    if (local.kind === "login" && remote.kind === "login" && local.loginType === "SSH_KEY" && remote.loginType === "SSH_KEY") {
      return { ...remote, id: local.id, sshKeyData: mergeBitwardenSshLocalMetadata(local, remote) };
    }
    return { ...remote, id: local.id } as VaultItem;
  });
}

function withRecoveredReference(local: VaultItem, providerId: string, remoteId: string, remote?: VaultItem): VaultItem {
  if (!remoteId) return local;
  const remoteReference = remote?.providerRefs.find((reference) => reference.providerId === providerId);
  return {
    ...local,
    ...(local.kind === "login" && remote?.kind === "login"
      ? {
          bitwardenCustomFieldsVersion: remote.bitwardenCustomFieldsVersion,
          bitwardenSshKeyMode: remote.bitwardenSshKeyMode
        }
      : {}),
    providerRefs: [
      ...local.providerRefs.filter((reference) => reference.providerId !== providerId),
      {
        providerId,
        remoteId,
        revision: remoteReference?.revision || remote?.updatedAt,
        etag: remoteReference?.etag
      }
    ]
  } as VaultItem;
}

function sameVaultPayload(left: VaultItem, right: VaultItem): boolean {
  return JSON.stringify(comparableVaultPayload(left)) === JSON.stringify(comparableVaultPayload(right));
}

function comparableVaultPayload(item: VaultItem): Record<string, unknown> {
  const { providerRefs: _refs, updatedAt: _updated, deletedAt: _deleted, ...payload } = item;
  if (payload.kind !== "login") return payload;
  const { bitwardenCustomFieldsVersion: _version, bitwardenSshKeyMode: _sshMode, ...comparable } = payload;
  return comparable.loginType === "SSH_KEY"
    ? { ...comparable, sshKeyData: bitwardenSshComparableData(item as LoginItem) }
    : comparable;
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

/** Persist only non-sensitive account metadata from the latest sync response. */
function bitwardenAccountConfig(session: BitwardenSessionConfig, payload: Record<string, unknown>): Record<string, unknown> {
  const profile = record(value(payload, "Profile", "profile"));
  const organizations = bitwardenOrganizationRecords(payload).map((organization) => ({
    id: stringValue(organization, "Id", "id"),
    name: stringValue(organization, "Name", "name") || undefined,
    type: stringValue(organization, "Type", "type") || undefined,
    role: stringValue(organization, "KeyConnectorUrl", "keyConnectorUrl") ? "key-connector" : stringValue(organization, "Role", "role") || undefined,
    collections: arrayValue(organization, "Collections", "collections").length
  })).filter((organization) => organization.id);
  const policySources = [value(payload, "Policies", "policies"), value(profile, "Policies", "policies")];
  const policies = policySources.flatMap((source) => Array.isArray(source) ? source : []).map((entry) => record(entry)).map((policy) => ({
    id: stringValue(policy, "Id", "id"),
    name: stringValue(policy, "Name", "name") || undefined,
    type: stringValue(policy, "Type", "type") || undefined,
    enabled: typeof value(policy, "Enabled", "enabled") === "boolean" ? value(policy, "Enabled", "enabled") : undefined
  })).filter((policy) => policy.id);
  return {
    ...session,
    accountState: {
      userId: stringValue(profile, "Id", "id") || undefined,
      organizations,
      policies,
      serverRevision: stringValue(payload, "RevisionDate", "revisionDate", "ServerRevision", "serverRevision") || undefined,
      syncedAt: new Date().toISOString()
    }
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Bitwarden 操作失败。";
}

async function bitwardenFolderNames(payload: Record<string, unknown>, key: BitwardenSymmetricKey): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of arrayValue(payload, "Folders", "folders")) {
    const folder = record(entry);
    const id = stringValue(folder, "Id", "id");
    if (!id) continue;
    const encryptedName = stringValue(folder, "Name", "name");
    if (!encryptedName) continue;
    try {
      const name = (await decryptBitwardenString(encryptedName, key)).trim();
      if (name) result.set(id, name.slice(0, 256));
    } catch {
      // A folder name is presentation metadata; retain the ID and ignore an unreadable label.
    }
  }
  return result;
}

function requireBitwardenMutationRevision(response: Record<string, unknown>, previousRevision: string | undefined, operation: string): string {
  const revision = stringValue(response, "RevisionDate", "revisionDate");
  if (!revision || !Number.isFinite(Date.parse(revision))) {
    throw new Error(`Bitwarden ${operation}响应缺少可验证的新修订。`);
  }
  if (previousRevision && revision === previousRevision) {
    throw new Error(`Bitwarden ${operation}响应仍是旧修订，未确认远端写入。`);
  }
  return revision;
}

function withBitwardenDeletedDate(raw: Record<string, unknown>, deletedAt: string): Record<string, unknown> {
  const result = { ...raw };
  if (Object.prototype.hasOwnProperty.call(raw, "DeletedDate")) result.DeletedDate = deletedAt;
  else result.deletedDate = deletedAt;
  return result;
}

function boundedPendingMutations(input: PendingMutation[], providerId: string): Map<string, PendingMutation> {
  if (!Array.isArray(input) || input.length > 100) throw new Error("Bitwarden 单批项目同步超过 100 条上限。");
  const result = new Map<string, PendingMutation>();
  for (const mutation of input) {
    if (!mutation || mutation.providerId !== providerId || !mutation.id || !mutation.itemId || result.has(mutation.itemId)) {
      throw new Error("Bitwarden 项目同步批次包含无效或重复操作。");
    }
    result.set(mutation.itemId, structuredClone(mutation));
  }
  return result;
}

function boundedMutationReceipts(input: ProviderMutationReceipt[], providerId: string): Map<string, ProviderMutationReceipt> {
  if (!Array.isArray(input) || input.length > 100) throw new Error("Bitwarden 持久同步回执超过 100 条上限。");
  const result = new Map<string, ProviderMutationReceipt>();
  for (const receipt of input) {
    if (!receipt || receipt.version !== 1 || receipt.providerId !== providerId || !receipt.mutationId || !receipt.itemId || result.has(receipt.mutationId)) {
      throw new Error("Bitwarden 持久同步回执无效或重复。");
    }
    if (!/^[a-f0-9]{64}$/.test(receipt.intentFingerprint)) throw new Error("Bitwarden 持久同步指纹无效。");
    result.set(receipt.mutationId, structuredClone(receipt));
  }
  return result;
}

function boundedAcknowledgedMutations(input: ProviderAcknowledgedMutation[]): Map<string, ProviderAcknowledgedMutation> {
  if (!Array.isArray(input) || input.length > 100) throw new Error("Bitwarden 持久同步确认超过 100 条上限。");
  const result = new Map<string, ProviderAcknowledgedMutation>();
  for (const acknowledgement of input) {
    if (!acknowledgement || !acknowledgement.mutationId || !acknowledgement.itemId || !acknowledgement.remoteId || result.has(acknowledgement.mutationId)) {
      throw new Error("Bitwarden 持久同步确认无效或重复。");
    }
    result.set(acknowledgement.mutationId, { ...acknowledgement });
  }
  return result;
}

async function markMutationsAttempted(
  context: ProviderSyncContext,
  items: VaultItem[],
  pendingByItemId: Map<string, PendingMutation> | undefined
): Promise<void> {
  if (!context.markMutationsAttempted || !pendingByItemId) return;
  const mutationIds = [...new Set(items.flatMap((item) => {
    const mutation = pendingByItemId.get(item.id);
    return mutation ? [mutation.id] : [];
  }))];
  if (mutationIds.length) await context.markMutationsAttempted(mutationIds);
}
