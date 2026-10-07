import { describe, expect, it, vi } from "vitest";
import * as kdbxweb from "kdbxweb";
import { ProviderTransportError } from "../provider-transport";
import { buildKeePassFixture, keePassCredentials } from "./keepass-fixture";
import {
  KeePassRemoteRebaseSessionError,
  KeePassRemoteSessionService,
  type KeePassRemoteFileClient
} from "./keepass-remote-session";
import { MemoryKeePassWorkingCopyStorage } from "./keepass-working-copy-store";
import { KeePassProvider } from "./keepass-provider";
import type { ProviderAccount } from "../../core/model";
import { PROJECT_CREDENTIAL_FIELD } from '../../core/project-credentials';

const PASSWORD = "publish fixture password";

describe("KeePass remote conditional publication", () => {
  it.each(['remote-hash', 'local-hash', 'missing-etag', 'cancelled'] as const)('rejects a conflict review with %s and preserves all stored bytes', async mode => {
    const bytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: 'Synthetic' }] });
    const state = createRemoteState(bytes, '"etag-1"'), provider = new KeePassProvider();
    const storage = new MemoryKeePassWorkingCopyStorage();
    const sessions = new KeePassRemoteSessionService(provider, storage, () => state.client);
    const account = await openRemote(sessions), before = await storage.read(account.id);
    if (mode === 'remote-hash') {
      const read = state.client.read.bind(state.client);
      vi.spyOn(state.client, 'read').mockImplementation(async () => ({ ...await read(), sha256: '0'.repeat(64) }));
    }
    if (mode === 'local-hash') {
      const read = storage.read.bind(storage);
      vi.spyOn(storage, 'read').mockImplementationOnce(async id => ({ ...(await read(id))!, workingSha256: '0'.repeat(64) }));
    }
    if (mode === 'missing-etag') state.etag = '';
    const controller = new AbortController(); if (mode === 'cancelled') controller.abort();
    await expect(sessions.reviewProjectConflicts(account, controller.signal)).rejects.toThrow();
    expect(await storage.read(account.id)).toEqual(before); expect(state.bytes).toEqual(bytes); expect(state.expectedEtags).toEqual([]);
    expect(provider.isUnlocked(account.id)).toBe(true);
  });

  it('returns only project identities and member changes when publication meets a concurrent project edit', async () => {
    const projectId = '00000000-0000-4000-8000-000000000099';
    const initialBytes = await buildKeePassFixture({ password: PASSWORD, entries: [0, 1].map(n => ({ title: 'Private title',
      protectedFields: { Password: 'Private password', [PROJECT_CREDENTIAL_FIELD]: JSON.stringify({ version: 1, projectId,
        groupId: '00000000-0000-4000-8000-000000000001', passwordId: `00000000-0000-4000-8000-00000000001${n}`,
        label: 'Main', primary: true, groupOrder: 0, passwordOrder: n }) } })) });
    const state = createRemoteState(initialBytes, '"etag-1"'), provider = new KeePassProvider();
    const storage = new MemoryKeePassWorkingCopyStorage();
    const sessions = new KeePassRemoteSessionService(provider, storage, () => state.client);
    const account = await openRemote(sessions);
    const localBytes = await rewrite(initialBytes, database => { database.remove(database.getDefaultGroup().entries[0]); });
    await provider.unlock(account, localBytes, { password: PASSWORD, sourceMode: 'webdav', sourceName: 'vault.kdbx', dirty: true });
    await sessions.persistWorkingCopy(account);
    const before = await storage.read(account.id);
    const peerBytes = await rewrite(initialBytes, database => { database.getDefaultGroup().entries[1].fields.set('Notes', 'Private peer note'); });
    state.bytes = peerBytes; state.etag = '"etag-2"';
    const liveBefore = provider.summarize(account.id);
    const review = await sessions.reviewProjectConflicts(account);
    expect(review).toMatchObject({ providerId: account.id, revision: before!.revision, baseSha256: before!.baseSha256,
      workingSha256: before!.workingSha256, remoteSha256: await digest(peerBytes), remoteEtag: '"etag-2"',
      projects: [expect.objectContaining({ projectId })] });
    expect(review.reviewToken).toMatch(/^[a-f0-9]{64}$/);
    expect(await sessions.reviewProjectConflicts(account)).toEqual(review);
    expect(provider.summarize(account.id)).toEqual(liveBefore);
    expect(await storage.read(account.id)).toEqual(before); expect(state.expectedEtags).toEqual([]);
    state.etag = '"etag-3"';
    expect((await sessions.reviewProjectConflicts(account)).reviewToken).not.toBe(review.reviewToken);
    state.etag = '"etag-2"';
    await expect(sessions.publishWorkingCopy(account)).rejects.toMatchObject({ code: 'remote-rebase-conflict',
      conflicts: [expect.objectContaining({ kind: 'password-project', projectId })],
      projects: [expect.objectContaining({ projectId, local: expect.objectContaining({ activeCount: 1, trashCount: 1 }),
        remote: expect.objectContaining({ activeCount: 2, trashCount: 0 }) })] });
    expect(await storage.read(account.id)).toEqual(before); expect(state.bytes).toEqual(peerBytes);
    expect(state.expectedEtags).toEqual([]);
  });

  it("uploads the working copy with the stored ETag and reloads the provider", async () => {
    const initialBytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Before" }] });
    const state = createRemoteState(initialBytes, '"etag-1"');
    const provider = new KeePassProvider();
    const storage = new MemoryKeePassWorkingCopyStorage();
    const sessions = new KeePassRemoteSessionService(provider, storage, () => state.client);
    const account = await openRemote(sessions);
    const initial = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items;
    const changed = { ...initial[0], title: "Local title", updatedAt: new Date().toISOString() };
    await provider.update(account, changed);
    await sessions.persistWorkingCopy(account);

    const published = await sessions.publishWorkingCopy(account);

    expect(published?.status).toBe("uploaded");
    expect(state.expectedEtags).toEqual(['"etag-1"']);
    const snapshot = await provider.snapshotFile(account.id);
    const reopened = await kdbxweb.Kdbx.load(snapshot.slice().buffer, keePassCredentials(PASSWORD));
    expect(reopened.getDefaultGroup().entries[0].fields.get("Title")).toBe("Local title");
  });

  it("rebases an unrelated remote field and preserves the local field", async () => {
    const initialBytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Before", fields: { UserName: "base" } }] });
    const remoteBytes = await rewrite(initialBytes, (database) => {
      database.getDefaultGroup().entries[0].fields.set("UserName", "remote");
    });
    const state = createRemoteState(initialBytes, '"etag-1"');
    const provider = new KeePassProvider();
    const storage = new MemoryKeePassWorkingCopyStorage();
    const sessions = new KeePassRemoteSessionService(provider, storage, () => state.client);
    const account = await openRemote(sessions);
    state.bytes = remoteBytes;
    state.etag = '"etag-2"';
    const initial = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items;
    await provider.update(account, { ...initial[0], title: "local", updatedAt: new Date().toISOString() });
    await sessions.persistWorkingCopy(account);

    const published = await sessions.publishWorkingCopy(account);

    expect(published?.status).toBe("rebased");
    const merged = await kdbxweb.Kdbx.load(state.bytes.slice().buffer, keePassCredentials(PASSWORD));
    const entry = merged.getDefaultGroup().entries[0];
    expect(entry.fields.get("Title")).toBe("local");
    expect(entry.fields.get("UserName")).toBe("remote");
    expect(state.expectedEtags).toEqual(['"etag-2"']);
  });

  it("leaves the working copy dirty when a structural rebase conflicts", async () => {
    const initialBytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Entry", group: "Base" }] });
    const remoteBytes = await rewrite(initialBytes, (database) => {
      const target = database.createGroup(database.getDefaultGroup(), "Remote");
      database.move(database.getDefaultGroup().groups.find((group) => group.name === "Base")!.entries[0], target);
    });
    const state = createRemoteState(initialBytes, '"etag-1"');
    const provider = new KeePassProvider();
    const storage = new MemoryKeePassWorkingCopyStorage();
    const sessions = new KeePassRemoteSessionService(provider, storage, () => state.client);
    const account = await openRemote(sessions);
    const initial = (await provider.sync(account, { now: new Date().toISOString(), localItems: [] })).items;
    void initial;
    const localBytes = await provider.snapshotFile(account.id);
    const localDatabase = await kdbxweb.Kdbx.load(localBytes.slice().buffer, keePassCredentials(PASSWORD));
    const localGroup = localDatabase.createGroup(localDatabase.getDefaultGroup(), "Local");
    localDatabase.move(localDatabase.getDefaultGroup().groups.find((group) => group.name === "Base")!.entries[0], localGroup);
    const movedBytes = new Uint8Array(await localDatabase.save());
    await provider.unlock(account, movedBytes, { password: PASSWORD, sourceMode: "webdav", sourceName: "vault.kdbx", dirty: true });
    state.bytes = remoteBytes;
    state.etag = '"etag-2"';
    await sessions.persistWorkingCopy(account);

    await expect(sessions.publishWorkingCopy(account)).rejects.toBeInstanceOf(KeePassRemoteRebaseSessionError);
    expect(state.expectedEtags).toEqual([]);
    const record = await storage.read(account.id);
    expect(record?.workingSha256).not.toBe(record?.baseSha256);
  });
});

interface RemoteState {
  bytes: Uint8Array;
  etag: string;
  expectedEtags: string[];
  client: KeePassRemoteFileClient;
}

function createRemoteState(bytes: Uint8Array, etag: string): RemoteState {
  const state = {} as RemoteState;
  state.bytes = bytes.slice();
  state.etag = etag;
  state.expectedEtags = [];
  state.client = {
    async testConnection() {},
    async stat() { return stat(state); },
    async read() { return { ...stat(state), bytes: state.bytes.slice(), sha256: await digest(state.bytes) }; },
    async write(inputBytes: Uint8Array, expectedEtag: string | null) {
      if (expectedEtag !== state.etag) {
        throw new ProviderTransportError("conflict", "precondition failed", { retryable: false, operation: "fixture-write", attempts: 1, status: 412 });
      }
      state.expectedEtags.push(expectedEtag);
      state.bytes = inputBytes.slice();
      state.etag = `"etag-${state.expectedEtags.length + 1}"`;
      return { ...stat(state), bytes: state.bytes.slice(), sha256: await digest(state.bytes), alreadyApplied: false };
    }
  };
  return state;
}

function stat(state: RemoteState) {
  return { url: "http://127.0.0.1:8787/dav/rebase/vault.kdbx", fileName: "vault.kdbx", etag: state.etag, sizeBytes: state.bytes.length };
}

async function openRemote(sessions: KeePassRemoteSessionService): Promise<ProviderAccount> {
  const account: ProviderAccount = { id: "keepass-publish", kind: "keepass", name: "Publish fixture", enabled: true, isDefaultSaveTarget: false, config: { databaseId: 42 } };
  const opened = await sessions.open(account, {
    baseUrl: "http://127.0.0.1:8787/dav/rebase",
    username: "fixture",
    webDavPassword: "webdav",
    remotePath: "vault.kdbx",
    databasePassword: PASSWORD
  });
  return { ...account, config: opened.accountConfig };
}

async function rewrite(bytes: Uint8Array, mutate: (database: kdbxweb.Kdbx) => void): Promise<Uint8Array> {
  const database = await kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
  mutate(database);
  return new Uint8Array(await database.save());
}

async function digest(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
