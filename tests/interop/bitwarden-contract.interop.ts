import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CardItem, LoginItem, PasskeyItem, ProviderAccount, VaultItem } from "../../src/core/model";
import { createLoginItem } from "../../src/core/model";
import type { ProviderSyncResult } from "../../src/core/provider";
import { MemoryBitwardenAttachmentMutationStore } from "../../src/providers/bitwarden/bitwarden-attachment-mutation-store";
import {
  BitwardenAttachmentMutationService,
  bitwardenAttachmentSha256
} from "../../src/providers/bitwarden/bitwarden-attachment-mutations";
import { decodeBitwardenCipher } from "../../src/providers/bitwarden/bitwarden-cipher-codec";
import { BitwardenClient, type BitwardenSessionConfig } from "../../src/providers/bitwarden/bitwarden-client";
import { BitwardenCollectionService } from "../../src/providers/bitwarden/bitwarden-collections";
import { BitwardenProvider } from "../../src/providers/bitwarden/bitwarden-provider";
import {
  BITWARDEN_INTEROP_EMAIL,
  BITWARDEN_INTEROP_MASTER_PASSWORD,
  RecordedBitwardenContractServer,
  type BitwardenContractEvidence,
  type BitwardenContractProfile
} from "./bitwarden-contract-server";

const PROFILES: BitwardenContractProfile[] = ["official", "vaultwarden"];
const evidence: BitwardenContractEvidence[] = [];

afterAll(async () => {
  process.stdout.write(`BITWARDEN_SERVER_CONTRACT_INTEROP ${JSON.stringify(evidence)}\n`);
  if (process.env.MONICA_BITWARDEN_INTEROP_KEEP !== "1") return;
  const target = resolve(".tmp", "bitwarden-contract-interop");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "evidence.json"), JSON.stringify({ generatedAt: new Date().toISOString(), profiles: evidence }, null, 2));
});

describe("Bitwarden official and Vaultwarden server-contract interoperability", () => {
  it.each(PROFILES)("round-trips the %s response profile without losing encrypted structures", async (profile) => {
    const server = await new RecordedBitwardenContractServer(profile).initialize();
    try {
      const client = new BitwardenClient(server.fetcher, fastTransport());
      const login = await client.login({
        vaultUrl: server.vaultUrl,
        email: BITWARDEN_INTEROP_EMAIL,
        masterPassword: BITWARDEN_INTEROP_MASTER_PASSWORD,
        deviceId: `contract-device-${profile}`
      });
      expect(login.status).toBe("authenticated");
      if (login.status !== "authenticated") throw new Error(`${profile} contract login did not authenticate.`);
      let account = providerAccount(server, login.session);
      const provider = new BitwardenProvider(server.fetcher);

      const imported = await provider.sync(account, {
        now: "2026-08-08T08:02:00.000Z",
        localItems: []
      });
      account = patchAccount(account, imported);
      const personalLogin = requireLogin(imported.items, "Personal Contract Login");
      const organizationLogin = requireLogin(imported.items, "Organization Contract Login");
      const passkey = requirePasskey(imported.items, "recorded-passkey-credential");
      const personalCard = requireCard(imported.items, "Personal Contract Card");
      expect(personalLogin).toMatchObject({ username: "personal-user", password: "personal-server-secret" });
      expect(organizationLogin).toMatchObject({ username: "organization-user", password: "organization-server-secret" });
      expect(passkey).toMatchObject({ signCount: 4, sourceMode: "bitwarden", privateKeyPkcs8: "recorded-pkcs8-material" });
      expect(personalCard).toMatchObject({
        number: "4111111111111111",
        cardholderName: "Personal Card Holder",
        expiryMonth: "12",
        expiryYear: "2030",
        securityCode: "123"
      });
      expect(organizationLogin.providerRefs[0]).toMatchObject({ remoteCollectionIds: [server.oldCollectionId] });

      const createdLocal: LoginItem = {
        ...createLoginItem({
          title: `Created through ${profile}`,
          username: "created-user",
          password: "created-secret",
          uris: ["https://created.example.test"],
          providerRefs: [{ providerId: server.providerId }]
        }),
        id: `local-created-${profile}`,
        createdAt: "2026-08-08T08:02:10.000Z",
        updatedAt: "2026-08-08T08:02:10.000Z"
      };
      const created = await provider.sync(account, {
        now: "2026-08-08T08:02:20.000Z",
        localItems: [...imported.items, createdLocal]
      });
      account = patchAccount(account, created);
      expect(server.stats.createCipher).toBe(1);
      expect(created.items.find((item) => item.id === createdLocal.id)).toMatchObject({
        kind: "login",
        password: "created-secret",
        providerRefs: [expect.objectContaining({ providerId: server.providerId, remoteId: expect.stringContaining("cipher-created-") })]
      });

      const editedAt = "2026-08-08T08:03:00.000Z";
      const editedItems = created.items.map((item) => {
        if (item.id === personalLogin.id && item.kind === "login") return { ...item, password: "browser-updated-secret", updatedAt: editedAt };
        if (item.id === passkey.id && item.kind === "passkey") return { ...item, signCount: 9, updatedAt: editedAt };
        return item;
      });
      const updated = await provider.sync(account, {
        now: "2026-08-08T08:03:10.000Z",
        localItems: editedItems
      });
      account = patchAccount(account, updated);
      expect(server.stats.updateCipher).toBe(1);
      const updatedRaw = server.cipher(server.personalCipherId);
      const decoded = await decodeBitwardenCipher(updatedRaw, server.providerId, server.vaultKey);
      expect(requireLogin(decoded.items, "Personal Contract Login").password).toBe("browser-updated-secret");
      expect(requirePasskey(decoded.items, "recorded-passkey-credential").signCount).toBe(9);
      expect(updatedRaw.futureServerField ?? updatedRaw.FutureServerField).toEqual({ keep: true, profile });
      expect(Array.isArray(updatedRaw.passwordHistory) ? updatedRaw.passwordHistory : updatedRaw.PasswordHistory).toHaveLength(1);

      const collections = new BitwardenCollectionService(new BitwardenClient(server.fetcher, fastTransport()));
      const listed = await collections.list(session(account));
      expect(listed.page.organizations).toEqual(expect.arrayContaining([
        expect.objectContaining({ organizationId: server.organizationId, name: "Monica Contract Organization", keyAvailable: true })
      ]));
      expect(listed.page.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ collectionId: server.targetCollectionId, name: "Target Collection", targetable: true })
      ]));
      const organizationRevision = revisionOf(server.cipher(server.organizationCipherId));
      const moved = await collections.moveCipher(
        listed.session,
        server.organizationCipherId,
        [server.targetCollectionId],
        organizationRevision
      );
      expect(moved.result).toMatchObject({
        changed: true,
        previousCollectionIds: [server.oldCollectionId],
        collectionIds: [server.targetCollectionId],
        rawCipher: expect.objectContaining({ FutureOrganizationField: { keep: true } })
      });
      expect(collectionIdsOf(server.cipher(server.organizationCipherId))).toEqual([server.targetCollectionId]);

      const attachmentService = new BitwardenAttachmentMutationService({
        fetcher: server.fetcher,
        transportPolicy: fastTransport(),
        store: new MemoryBitwardenAttachmentMutationStore(),
        now: () => Date.parse("2026-08-08T08:04:00.000Z"),
        randomness: deterministicRandom(profile === "official" ? 31 : 61)
      });
      const attachmentBytes = new TextEncoder().encode(`attachment-${profile}-中文`);
      const uploaded = await attachmentService.upload({
        providerId: server.providerId,
        itemId: personalLogin.id,
        session: moved.session,
        rawCipher: server.cipher(server.personalCipherId),
        operationId: operationId(profile, 1),
        fileName: `${profile}-evidence.txt`,
        bytes: attachmentBytes.slice(),
        sha256: await bitwardenAttachmentSha256(attachmentBytes)
      });
      expect(uploaded.attachment).toMatchObject({
        providerKind: "bitwarden",
        fileName: `${profile}-evidence.txt`,
        sizeBytes: attachmentBytes.length
      });
      expect(server.attachmentCount()).toBe(1);
      expect(server.stats.prepareAttachment).toBe(1);
      expect(server.stats.uploadAttachment).toBe(1);
      expect(server.stats.downloadAttachment).toBeGreaterThanOrEqual(1);
      expect(server.signedAuthorizationHeaders.every((value) => value === null)).toBe(true);

      const deleted = await attachmentService.delete({
        providerId: server.providerId,
        itemId: personalLogin.id,
        session: uploaded.session,
        rawCipher: uploaded.rawCipher,
        operationId: operationId(profile, 2),
        attachmentId: uploaded.attachment!.attachmentId
      });
      expect(deleted.changed).toBe(true);
      expect(server.attachmentCount()).toBe(0);
      expect(server.stats.deleteAttachment).toBe(1);

      const cardAttachmentBytes = new TextEncoder().encode(`secure-item-card-attachment-${profile}-中文`);
      const cardUploaded = await attachmentService.upload({
        providerId: server.providerId,
        itemId: personalCard.id,
        session: deleted.session,
        rawCipher: server.cipher(server.personalCardCipherId),
        operationId: operationId(profile, 3),
        fileName: `${profile}-card-evidence.jpg`,
        bytes: cardAttachmentBytes.slice(),
        sha256: await bitwardenAttachmentSha256(cardAttachmentBytes)
      });
      expect(cardUploaded.attachment).toMatchObject({
        providerKind: "bitwarden",
        fileName: `${profile}-card-evidence.jpg`,
        sizeBytes: cardAttachmentBytes.length
      });
      expect(server.attachmentCount(server.personalCardCipherId)).toBe(1);
      const cardDeleted = await attachmentService.delete({
        providerId: server.providerId,
        itemId: personalCard.id,
        session: cardUploaded.session,
        rawCipher: cardUploaded.rawCipher,
        operationId: operationId(profile, 4),
        attachmentId: cardUploaded.attachment!.attachmentId
      });
      expect(cardDeleted.changed).toBe(true);
      expect(server.attachmentCount(server.personalCardCipherId)).toBe(0);
      expect(server.stats.prepareAttachment).toBe(2);
      expect(server.stats.uploadAttachment).toBe(2);
      expect(server.stats.downloadAttachment).toBeGreaterThanOrEqual(2);
      expect(server.stats.deleteAttachment).toBe(2);

      const baseline = await provider.sync(account, {
        now: "2026-08-08T08:05:00.000Z",
        localItems: updated.items
      });
      account = patchAccount(account, baseline);
      server.clearCiphers();
      const protectedEmpty = await provider.sync(account, {
        now: "2026-08-08T08:05:10.000Z",
        localItems: baseline.items
      });
      expect(protectedEmpty.items).toEqual(baseline.items);
      expect(protectedEmpty.accountPatch).toMatchObject({ requiresEmptyRemoteConfirmation: true });
      expect(protectedEmpty.conflicts).not.toHaveLength(0);

      const adoptedEmpty = await provider.sync(account, {
        now: "2026-08-08T08:05:20.000Z",
        localItems: baseline.items,
        allowEmptyRemote: true
      });
      expect(adoptedEmpty.items).toEqual([]);
      expect(adoptedEmpty.conflicts).toEqual([]);
      expect(adoptedEmpty.adoptRemoteRemovals).toBe(true);
      expect(adoptedEmpty.accountPatch).toMatchObject({ requiresEmptyRemoteConfirmation: false });
      expect(server.stats.emptySync).toBe(2);
      expect(server.stats.prelogin).toBe(1);
      expect(server.stats.login).toBe(1);
      expect(server.stats.moveCollections).toBe(1);

      evidence.push({ ...server.evidence(), secureItemAttachmentVerified: true });
    } finally {
      server.dispose();
    }
  }, 60_000);
});

function providerAccount(server: RecordedBitwardenContractServer, config: BitwardenSessionConfig): ProviderAccount {
  return {
    id: server.providerId,
    kind: "bitwarden",
    name: server.profile === "official" ? "Recorded Bitwarden" : "Recorded Vaultwarden",
    enabled: true,
    isDefaultSaveTarget: false,
    config
  };
}

function patchAccount(account: ProviderAccount, result: ProviderSyncResult): ProviderAccount {
  const patch = result.accountPatch || {};
  return {
    ...account,
    ...patch,
    config: patch.config || account.config
  };
}

function session(account: ProviderAccount): BitwardenSessionConfig {
  return account.config as BitwardenSessionConfig;
}

function requireLogin(items: VaultItem[], title: string): LoginItem {
  const item = items.find((candidate): candidate is LoginItem => candidate.kind === "login" && candidate.title === title);
  if (!item) throw new Error(`Bitwarden contract login is missing: ${title}`);
  return item;
}

function requirePasskey(items: VaultItem[], credentialId: string): PasskeyItem {
  const item = items.find((candidate): candidate is PasskeyItem => candidate.kind === "passkey" && candidate.credentialId === credentialId);
  if (!item) throw new Error(`Bitwarden contract Passkey is missing: ${credentialId}`);
  return item;
}

function requireCard(items: VaultItem[], title: string): CardItem {
  const item = items.find((candidate): candidate is CardItem => candidate.kind === "card" && candidate.title === title);
  if (!item) throw new Error(`Bitwarden contract card is missing: ${title}`);
  return item;
}

function revisionOf(raw: Record<string, unknown>): string {
  const value = raw.revisionDate ?? raw.RevisionDate;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Bitwarden contract revision is missing.");
  return value;
}

function collectionIdsOf(raw: Record<string, unknown>): string[] {
  const value = raw.collectionIds ?? raw.CollectionIds;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function fastTransport() {
  return { baseDelayMs: 0, jitterRatio: 0, timeoutMs: 2_000, maxAttempts: 1 };
}

function deterministicRandom(initialSeed: number): (length: number) => Uint8Array {
  let seed = initialSeed;
  return (length) => {
    const bytes = Uint8Array.from({ length }, (_, index) => (seed + index) & 0xff);
    seed = (seed + length + 17) & 0xff;
    return bytes;
  };
}

function operationId(profile: BitwardenContractProfile, sequence: 1 | 2 | 3 | 4): string {
  if (profile === "official") return sequence === 1
    ? "11111111-1111-4111-8111-111111111111"
    : sequence === 2
      ? "22222222-2222-4222-8222-222222222222"
      : sequence === 3
        ? "55555555-5555-4555-8555-555555555555"
        : "66666666-6666-4666-8666-666666666666";
  return sequence === 1
    ? "33333333-3333-4333-8333-333333333333"
    : sequence === 2
      ? "44444444-4444-4444-8444-444444444444"
      : sequence === 3
        ? "77777777-7777-4777-8777-777777777777"
        : "88888888-8888-4888-8888-888888888888";
}
