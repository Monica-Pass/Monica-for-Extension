import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { LoginItem, PasskeyItem, ProviderAccount, VaultItem } from "../../core/model";
import { readAndroidBackup } from "./android-backup-codec";
import { decryptAndroidBackup, encryptAndroidBackup, isAndroidEncryptedBackup } from "./android-backup-crypto";
import { MonicaWebDavProvider } from "./monica-webdav-provider";

const PROVIDER_ID = "webdav-provider";
const PATH = "folders/_root/passwords/password_42_1700000000000.json";
const PASSKEY_PATH = "folders/_root/passkeys/passkey_portable.json";
const P256_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsloK6aKNvj0CZMYdBdSZs+AUAsFy1t66q4tq5SvyeJahRANCAASlCTbHlIcaKQ2lzoEFhtjkLEO++f3cYq6FMYG7eH3BmuLQPz71FAtWq4z+tIb7oequwhUJL3xos1nA8jFqpkDs";

function androidZip(password = "android-secret", updatedAt = 1_700_000_001_000) {
  return zipSync({
    [PATH]: strToU8(JSON.stringify({
      id: 42,
      title: "Android Login",
      username: "joy@example.com",
      password,
      website: "https://accounts.example.com",
      notes: "fixture",
      isFavorite: true,
      createdAt: 1_700_000_000_000,
      updatedAt
    })),
    "future/unknown.bin": Uint8Array.of(9, 8, 7)
  });
}

function portablePasskeyZip() {
  return zipSync({ [PASSKEY_PATH]: strToU8(JSON.stringify({
    credentialId: "portable", rpId: "example.com", rpName: "Example", userId: "user", userName: "joy", userDisplayName: "Joy",
    publicKeyAlgorithm: -7, publicKey: "public", privateKeyAlias: P256_PKCS8, signCount: 0, isDiscoverable: true, createdAt: 1_700_000_000_000
  })) });
}

function account(config: Record<string, unknown> = {}): ProviderAccount {
  return {
    id: PROVIDER_ID,
    kind: "monica-webdav",
    name: "Android WebDAV",
    enabled: true,
    isDefaultSaveTarget: false,
    config: { baseUrl: "https://cloud.example.com/dav", username: "joy", password: "secret", ...config }
  };
}

function multiStatus(name = "monica_backup_20260715_020202.zip", etag = '"remote"') {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/dav/Monica_Backups/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
    <d:response><d:href>/dav/Monica_Backups/${name}</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag><d:getlastmodified>Wed, 15 Jul 2026 02:02:02 GMT</d:getlastmodified></d:prop></d:propstat></d:response>
  </d:multistatus>`;
}

function server(remote: Uint8Array, latest = multiStatus()) {
  let uploaded: Uint8Array | undefined;
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method || "GET";
    const headers = new Headers(init?.headers);
    if (method === "PROPFIND" && headers.get("Depth") === "1") return new Response(latest, { status: 207 });
    if (method === "PROPFIND") return new Response(null, { status: 207 });
    if (method === "GET") return new Response(remote as unknown as BodyInit, { status: 200 });
    if (method === "PUT") {
      uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return new Response(null, { status: 201, headers: { etag: '"uploaded"' } });
    }
    throw new Error(`Unexpected ${method}`);
  }) as unknown as typeof fetch;
  return { fetcher, uploaded: () => uploaded };
}

describe("Monica WebDAV provider", () => {
  it("lists and reads a real Android portable attachment manifest", async () => {
    const payload = new TextEncoder().encode("portable payload");
    const digest = await crypto.subtle.digest("SHA-256", payload);
    const sha256Hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const remote = zipSync({
      [PATH]: strToU8(JSON.stringify({ id: 42, title: "Android Login", username: "joy" })),
      "attachments_portable/attachments_portable.json": strToU8(JSON.stringify({ version: 2, entries: [{ parentPasswordId: 42, fileName: "note.txt", mimeType: "text/plain", sizeBytes: payload.byteLength, sha256Hex, payloadPath: "attachments_portable/cGF5bG9hZA.bin" }] })),
      "attachments_portable/cGF5bG9hZA.bin": payload
    });
    const provider = new MonicaWebDavProvider(server(remote).fetcher);
    const item = (await provider.sync(account(), { now: "2026-07-15T03:00:00.000Z", localItems: [] })).items[0];
    const page = await provider.listAttachments(account(), item);
    expect(page.items).toMatchObject([{ fileName: "note.txt", sizeBytes: payload.byteLength, providerKind: "monica-webdav", protected: true }]);
    const read = await provider.readAttachment(account(), item, page.items[0].attachmentId);
    expect(read.bytes).toEqual(payload);
  });

  it("writes portable attachments only into an encrypted Android backup", async () => {
    const backupPassword = "portable-write";
    const payload = new TextEncoder().encode("original");
    const mock = server(await encryptAndroidBackup(androidZip(), backupPassword));
    const provider = new MonicaWebDavProvider(mock.fetcher);
    const first = await provider.sync(account({ backupPassword }), { now: "2026-07-15T03:00:00.000Z", localItems: [] });
    const item = first.items[0];
    const digest = await crypto.subtle.digest("SHA-256", payload);
    const sha256Hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
    const added = await provider.addAttachment(account({ backupPassword }), item, { fileName: "secret.txt", mediaType: "text/plain", sizeBytes: payload.byteLength, sha256Hex }, payload);
    expect(added.providerKind).toBe("monica-webdav");
    expect(isAndroidEncryptedBackup(mock.uploaded()!)).toBe(true);
    const decrypted = await decryptAndroidBackup(mock.uploaded()!, backupPassword);
    const entries = unzipSync(decrypted);
    const manifest = JSON.parse(new TextDecoder().decode(entries["attachments_portable/attachments_portable.json"]));
    expect(manifest.entries).toEqual(expect.arrayContaining([expect.objectContaining({ fileName: "secret.txt", sizeBytes: payload.byteLength })]));
  });

  it("imports the latest Android snapshot and records an item baseline", async () => {
    const mock = server(androidZip());
    const provider = new MonicaWebDavProvider(mock.fetcher);
    const localOnly = localLogin();
    const result = await provider.sync(account(), { now: "2026-07-15T03:00:00.000Z", localItems: [localOnly] });

    expect(result.conflicts).toEqual([]);
    expect(result.items).toHaveLength(2);
    const imported = result.items.find((item) => item.id.startsWith("android:"));
    expect(imported).toMatchObject({ kind: "login", password: "android-secret" });
    expect(imported?.providerRefs[0]).toMatchObject({ providerId: PROVIDER_ID, remoteId: PATH, revision: "2023-11-14T22:13:21.000Z", etag: '"remote"' });
    expect(result.accountPatch?.config).toMatchObject({ lastFileName: "monica_backup_20260715_020202.zip", lastEtag: '"remote"' });
    expect(mock.uploaded()).toBeUndefined();
  });

  it("does not mutate the sync snapshot while first creating an Android backup", async () => {
    let uploaded: Uint8Array | undefined;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || "GET";
      const headers = new Headers(init?.headers);
      if (method === "PROPFIND" && headers.get("Depth") === "1") return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>`, { status: 207 });
      if (method === "PROPFIND") return new Response(null, { status: 207 });
      if (method === "PUT") { uploaded = new Uint8Array(await new Response(init?.body).arrayBuffer()); return new Response(null, { status: 201, headers: { etag: '"created"' } }); }
      throw new Error(`Unexpected ${method}`);
    }) as unknown as typeof fetch;
    const local = { ...localLogin(), providerRefs: [{ providerId: PROVIDER_ID }] };
    const snapshot = structuredClone([local]);

    const result = await new MonicaWebDavProvider(fetcher).sync(account(), { now: "2026-07-15T03:00:00.000Z", localItems: snapshot });

    expect(snapshot).toEqual([local]);
    expect(result.items[0]).toMatchObject({ id: local.id, providerRefs: [expect.objectContaining({ remoteId: local.id, etag: '"created"' })] });
    expect(uploaded).toBeDefined();
  });

  it("uploads a lossless new snapshot when a WebDAV item changed locally", async () => {
    const mock = server(androidZip());
    const provider = new MonicaWebDavProvider(mock.fetcher);
    const first = await provider.sync(account(), { now: "2026-07-15T03:00:00.000Z", localItems: [] });
    const imported = first.items[0] as LoginItem;
    const changed: LoginItem = { ...imported, password: "browser-secret", updatedAt: "2026-07-15T03:01:00.000Z" };
    const configured = account(first.accountPatch?.config);
    const result = await provider.sync(configured, { now: "2026-07-15T03:02:00.000Z", localItems: [changed] });

    expect(result.conflicts).toEqual([]);
    expect(result.items[0]).toMatchObject({ password: "browser-secret" });
    expect(result.items[0].providerRefs[0]).toMatchObject({ revision: "2026-07-15T03:01:00.000Z", etag: '"uploaded"' });
    const uploaded = mock.uploaded();
    expect(uploaded).toBeDefined();
    expect(unzipSync(uploaded!)["future/unknown.bin"]).toEqual(Uint8Array.of(9, 8, 7));
    expect(readAndroidBackup(uploaded!, PROVIDER_ID).items[0]).toMatchObject({ password: "browser-secret" });
  });

  it("imports and writes an encrypted Android snapshot without losing opaque entries", async () => {
    const backupPassword = "x";
    const encryptedRemote = await encryptAndroidBackup(androidZip(), backupPassword);
    const mock = server(encryptedRemote, multiStatus("monica_backup_20260715_020202.enc.zip", '"remote-encrypted"'));
    const provider = new MonicaWebDavProvider(mock.fetcher);
    const firstAccount = account({ backupPassword });
    const first = await provider.sync(firstAccount, { now: "2026-07-15T03:00:00.000Z", localItems: [] });
    const imported = first.items[0] as LoginItem;
    const changed: LoginItem = { ...imported, password: "encrypted-browser-secret", updatedAt: "2026-07-15T03:01:00.000Z" };

    const result = await provider.sync(account({ ...first.accountPatch?.config, backupPassword }), {
      now: "2026-07-15T03:02:00.000Z",
      localItems: [changed]
    });

    expect(result.conflicts).toEqual([]);
    const uploaded = mock.uploaded();
    expect(uploaded).toBeDefined();
    expect(isAndroidEncryptedBackup(uploaded!)).toBe(true);
    const decrypted = await decryptAndroidBackup(uploaded!, backupPassword);
    expect(unzipSync(decrypted)["future/unknown.bin"]).toEqual(Uint8Array.of(9, 8, 7));
    expect(readAndroidBackup(decrypted, PROVIDER_ID).items[0]).toMatchObject({ password: "encrypted-browser-secret" });
  });

  it("promotes portable Passkeys only after encrypted WebDAV decryption and keeps them encrypted on write", async () => {
    const backupPassword = "portable-backup";
    const encryptedRemote = await encryptAndroidBackup(portablePasskeyZip(), backupPassword);
    const mock = server(encryptedRemote, multiStatus("monica_backup_portable.enc.zip", '"portable"'));
    const provider = new MonicaWebDavProvider(mock.fetcher);
    const first = await provider.sync(account({ backupPassword }), { now: "2026-08-23T00:00:00.000Z", localItems: [] });
    const imported = first.items[0] as PasskeyItem;
    expect(imported).toMatchObject({ sourceMode: "browser-local", privateKeyPkcs8: P256_PKCS8 });

    const changed = { ...imported, notes: "edited", updatedAt: "2026-08-23T00:01:00.000Z" };
    await provider.sync(account({ ...first.accountPatch?.config, backupPassword }), { now: "2026-08-23T00:02:00.000Z", localItems: [changed] });
    expect(isAndroidEncryptedBackup(mock.uploaded()!)).toBe(true);
    const decrypted = await decryptAndroidBackup(mock.uploaded()!, backupPassword);
    expect(JSON.parse(new TextDecoder().decode(unzipSync(decrypted)[PASSKEY_PATH])).privateKeyAlias).toBe(P256_PKCS8);
  });

  it("never promotes or rewrites a portable key from an unencrypted WebDAV snapshot", async () => {
    const mock = server(portablePasskeyZip());
    const provider = new MonicaWebDavProvider(mock.fetcher);
    const first = await provider.sync(account(), { now: "2026-08-23T00:00:00.000Z", localItems: [] });
    const imported = first.items[0] as PasskeyItem;
    expect(imported).toMatchObject({ sourceMode: "android-metadata-only" });
    expect(imported).not.toHaveProperty("privateKeyPkcs8");

    await provider.sync(account(first.accountPatch?.config), { now: "2026-08-23T00:02:00.000Z", localItems: [{ ...imported, notes: "edited", updatedAt: "2026-08-23T00:01:00.000Z" }] });
    expect(JSON.parse(new TextDecoder().decode(unzipSync(mock.uploaded()!)[PASSKEY_PATH])).privateKeyAlias).toBe("");
  });

  it("reports a three-way conflict and does not overwrite a newer Android snapshot", async () => {
    const initialMock = server(androidZip());
    const provider = new MonicaWebDavProvider(initialMock.fetcher);
    const first = await provider.sync(account(), { now: "2026-07-15T03:00:00.000Z", localItems: [] });
    const imported = first.items[0] as LoginItem;
    const local: LoginItem = { ...imported, password: "browser-secret", updatedAt: "2026-07-15T03:05:00.000Z" };
    const changedServer = server(androidZip("new-android-secret", 1_783_742_640_000), multiStatus("monica_backup_20260715_030303.zip", '"new-remote"'));
    const changedProvider = new MonicaWebDavProvider(changedServer.fetcher);
    const result = await changedProvider.sync(account(first.accountPatch?.config), { now: "2026-07-15T03:06:00.000Z", localItems: [local] });

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({ itemId: imported.id, local: { password: "browser-secret" }, remote: { password: "new-android-secret" } });
    expect(result.accountPatch).toMatchObject({ lastError: "发现 1 个 WebDAV 同步冲突。" });
    expect(changedServer.uploaded()).toBeUndefined();
  });

  it("writes a local tombstone as an Android snapshot deletion", async () => {
    const mock = server(androidZip());
    const provider = new MonicaWebDavProvider(mock.fetcher);
    const first = await provider.sync(account(), { now: "2026-07-15T03:00:00.000Z", localItems: [] });
    const imported = first.items[0];
    const deleted = { ...imported, updatedAt: "2026-07-15T03:04:00.000Z", deletedAt: "2026-07-15T03:04:00.000Z" } as VaultItem;
    const result = await provider.sync(account(first.accountPatch?.config), { now: "2026-07-15T03:05:00.000Z", localItems: [deleted] });

    expect(result.conflicts).toEqual([]);
    expect(result.items).toEqual([]);
    expect(readAndroidBackup(mock.uploaded()!, PROVIDER_ID).items).toEqual([]);
    expect(unzipSync(mock.uploaded()!)["future/unknown.bin"]).toEqual(Uint8Array.of(9, 8, 7));
  });

  it("stops an upload when the server drops the latest backup ETag during the concurrency check", async () => {
    const initial = server(androidZip());
    const first = await new MonicaWebDavProvider(initial.fetcher).sync(account(), { now: "2026-07-15T03:00:00.000Z", localItems: [] });
    const changed = { ...first.items[0], password: "browser-secret", updatedAt: "2026-07-15T03:06:00.000Z" } as LoginItem;
    let directoryReads = 0;
    let putCount = 0;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method || "GET";
      const headers = new Headers(init?.headers);
      if (method === "PROPFIND" && headers.get("Depth") === "1") {
        directoryReads += 1;
        return new Response(directoryReads === 1 ? multiStatus() : multiStatus(undefined, ""), { status: 207 });
      }
      if (method === "PROPFIND") return new Response(null, { status: 207 });
      if (method === "GET") return new Response(androidZip() as unknown as BodyInit, { status: 200 });
      if (method === "PUT") { putCount += 1; return new Response(null, { status: 201 }); }
      throw new Error(`Unexpected ${method}`);
    }) as unknown as typeof fetch;

    await expect(new MonicaWebDavProvider(fetcher).sync(account(first.accountPatch?.config), {
      now: "2026-07-15T03:07:00.000Z",
      localItems: [changed]
    })).rejects.toThrow("同步期间发生变化");
    expect(directoryReads).toBe(2);
    expect(putCount).toBe(0);
  });
});

function localLogin(): LoginItem {
  return {
    id: "local-only",
    kind: "login",
    title: "Local",
    favorite: false,
    notes: "",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    providerRefs: [],
    username: "local",
    password: "local-secret",
    uris: ["https://local.example.com"],
    customFields: []
  };
}
