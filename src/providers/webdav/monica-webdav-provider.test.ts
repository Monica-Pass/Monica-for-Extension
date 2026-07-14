import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { LoginItem, ProviderAccount, VaultItem } from "../../core/model";
import { readAndroidBackup } from "./android-backup-codec";
import { MonicaWebDavProvider } from "./monica-webdav-provider";

const PROVIDER_ID = "webdav-provider";
const PATH = "folders/_root/passwords/password_42_1700000000000.json";

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
