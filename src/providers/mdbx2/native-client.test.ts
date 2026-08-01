import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MDBX2_CORE_REVISION,
  MDBX2_ENGINE_VERSION,
  MDBX2_FORMAT_VERSION,
  MDBX2_MAX_ACTIVE_TRANSFERS,
  MDBX2_MAX_BINARY_CHUNK_BYTES,
  MDBX2_MAX_INBOUND_FILE_BYTES,
  MDBX2_MAX_OBJECT_PAYLOAD_BYTES,
  MDBX2_MAX_SUMMARY_PAGE_SIZE,
  MDBX2_NATIVE_HOST_NAME,
  MDBX2_NATIVE_PROTOCOL_VERSION,
  MDBX2_SYNC_PROTOCOL_VERSION,
  Mdbx2NativeHostError,
  validateMdbx2HostCapabilities
} from "./native-contract";
import { Mdbx2NativeClient, type Mdbx2NativePort, type Mdbx2NativeRuntime } from "./native-client";

class FakeEvent<Listener extends (...args: never[]) => void> {
  readonly listeners = new Set<Listener>();
  addListener(listener: Listener): void { this.listeners.add(listener); }
  removeListener(listener: Listener): void { this.listeners.delete(listener); }
  emit(...args: Parameters<Listener>): void { for (const listener of this.listeners) listener(...args); }
}

class FakePort implements Mdbx2NativePort {
  readonly onMessage = new FakeEvent<(message: never) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly messages: unknown[] = [];
  disconnected = false;
  onPost?: (message: unknown) => void;

  postMessage(message: unknown): void {
    this.messages.push(message);
    this.onPost?.(message);
  }

  disconnect(): void { this.disconnected = true; }
}

class FakeRuntime implements Mdbx2NativeRuntime {
  lastError?: string;
  constructor(readonly port = new FakePort(), readonly connectError?: Error) {}
  connectNative(hostName: string): Mdbx2NativePort {
    expect(hostName).toBe(MDBX2_NATIVE_HOST_NAME);
    if (this.connectError) throw this.connectError;
    return this.port;
  }
  disconnectErrorMessage(): string | undefined { return this.lastError; }
}

const HELLO = {
  hostName: MDBX2_NATIVE_HOST_NAME,
  hostVersion: "0.1.0",
  protocolVersion: MDBX2_NATIVE_PROTOCOL_VERSION,
  mdbxCoreRevision: MDBX2_CORE_REVISION,
  mdbxEngineVersion: MDBX2_ENGINE_VERSION,
  mdbxFormatVersion: MDBX2_FORMAT_VERSION,
  supportsMdbx1: false,
  maxBinaryChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES,
  maxInboundFileBytes: MDBX2_MAX_INBOUND_FILE_BYTES,
  maxActiveTransfers: MDBX2_MAX_ACTIVE_TRANSFERS,
  maxObjectPayloadBytes: MDBX2_MAX_OBJECT_PAYLOAD_BYTES,
  maxSummaryPageSize: MDBX2_MAX_SUMMARY_PAGE_SIZE,
  supportedUnlockMethods: ["password", "security-key", "password-security-key"],
  storageProfile: "full",
  syncProfile: "full",
  syncProtocolVersion: MDBX2_SYNC_PROTOCOL_VERSION,
  enabledStorageCapabilityIds: ["object-record-v2"],
  enabledSyncCapabilityIds: ["authenticated-state-delta-v8"]
} as const;

afterEach(() => vi.useRealTimers());

describe("MDBX2 Native Messaging client", () => {
  it("performs a pinned hello request and validates MDBX2-only capabilities", async () => {
    const runtime = new FakeRuntime();
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: true,
        result: HELLO
      } as never);
    };
    const client = new Mdbx2NativeClient(runtime, () => "request-1");

    await expect(client.hello()).resolves.toEqual(HELLO);
    expect(runtime.port.messages).toEqual([{
      protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
      requestId: "request-1",
      method: "host.hello",
      params: {}
    }]);
    client.close();
  });

  it("rejects a Host that claims MDBX1 support or a different chunk boundary", () => {
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, supportsMdbx1: true })).toThrowError(Mdbx2NativeHostError);
    expect(() => validateMdbx2HostCapabilities({ ...HELLO, maxBinaryChunkBytes: 64 * 1024 })).toThrow("分块限制");
  });

  it("preserves stable Host error codes and retryability", async () => {
    const runtime = new FakeRuntime();
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string };
      runtime.port.onMessage.emit({
        protocol: MDBX2_NATIVE_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: { code: "vault-locked", message: "Vault is locked.", retryable: true }
      } as never);
    };
    const client = new Mdbx2NativeClient(runtime, () => "request-2");

    await expect(client.hello()).rejects.toMatchObject({ code: "vault-locked", retryable: true });
    client.close();
  });

  it("uses bounded transfer and MDBX2-only vault lifecycle methods", async () => {
    const runtime = new FakeRuntime();
    const handle = "11111111-1111-4111-8111-111111111111";
    let requestNumber = 0;
    runtime.port.onPost = (message) => {
      const request = message as { requestId: string; method: string };
      const diagnostics = {
        commitCount: 0, tombstoneCount: 0, branchCount: 1, deviceCount: 1, snapshotCount: 0,
        unresolvedConflictCount: 0, projectCount: 0, deletedProjectCount: 0, entryCount: 0,
        deletedEntryCount: 0, attachmentCount: 0, deletedAttachmentCount: 0, externalAttachmentCount: 0,
        originalAttachmentBytes: 0, storedAttachmentBytes: 0
      };
      const result: Record<string, unknown> = {
        "transfer.begin": { transferId: handle, nextOffset: 0, maxChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES },
        "transfer.chunk": { nextOffset: 3, acceptedBytes: 3, repeated: false },
        "transfer.finish": { fileHandle: handle, sizeBytes: 3, sha256: "a".repeat(64) },
        "vault.inspect": {
          source: { kind: "file", handle }, initialized: true, formatVersion: MDBX2_FORMAT_VERSION, schemaVersion: 17,
          minReaderVersion: "MDBX-2", minWriterVersion: "MDBX-2", requiresUpgrade: false,
          unknownCriticalExtensions: false, targetFormatVersion: MDBX2_FORMAT_VERSION, targetSchemaVersion: 17
        },
        "vault.open": {
          vaultHandle: handle, vaultId: handle, deviceId: handle, formatVersion: MDBX2_FORMAT_VERSION, schemaVersion: 17,
          migrated: false, preUpgradeBackupCreated: false, health: { healthy: true, issueCount: 0 }, diagnostics
        },
        "vault.status": { vaultHandle: handle, open: true, available: true },
        "vault.lock": { locked: true },
        "collection.list": { items: [{ collectionId: handle, title: ".monica-root", collectionTypeId: null, profileSchemaVersion: null, groupId: null, iconRef: null, favorite: false, archived: false, attachmentCount: 0, headCommitId: "commit-1", deleted: false, updatedAt: "2026-08-02T00:00:00Z" }], nextCursor: null },
        "object.list": { items: [{ objectId: handle, collectionId: handle, objectTypeId: "login", title: "Example", payloadSchemaVersion: 1, headCommitId: "commit-2", deleted: false, updatedAt: "2026-08-02T00:00:00Z" }], nextCursor: null },
        "object.reveal": { objectId: handle, collectionId: handle, objectTypeId: "login", title: "Example", payloadJson: JSON.stringify({ kind: "password", monica_entry_id: "password:1" }), payloadSchemaVersion: 1, deleted: false },
        "object.upsert": { commitId: "commit-3", alreadyCommitted: false, logicalObjectId: "password:1", objectId: handle, collectionId: handle, objectTypeId: "login" },
        "object.delete": { changed: true, commitId: "commit-4", alreadyCommitted: false, logicalObjectId: "password:1", objectId: handle }
      }[request.method] as Record<string, unknown>;
      runtime.port.onMessage.emit({ protocol: MDBX2_NATIVE_PROTOCOL_VERSION, requestId: request.requestId, ok: true, result } as never);
    };
    const client = new Mdbx2NativeClient(runtime, () => `request-${++requestNumber}`);

    await expect(client.beginInboundTransfer(3, "a".repeat(64))).resolves.toMatchObject({ transferId: handle, nextOffset: 0 });
    await expect(client.sendInboundChunk(handle, 0, new Uint8Array([1, 2, 3]))).resolves.toMatchObject({ nextOffset: 3, acceptedBytes: 3 });
    await expect(client.finishInboundTransfer(handle)).resolves.toMatchObject({ fileHandle: handle, sizeBytes: 3 });
    await expect(client.inspectVault({ kind: "file", handle })).resolves.toMatchObject({ formatVersion: "MDBX-2", schemaVersion: 17 });
    await expect(client.openVault({ kind: "file", handle }, { method: "password", password: "" })).resolves.toMatchObject({ vaultHandle: handle, health: { healthy: true } });
    await expect(client.vaultStatus(handle)).resolves.toEqual({ vaultHandle: handle, open: true, available: true });
    await expect(client.listCollections(handle)).resolves.toMatchObject({ items: [{ collectionId: handle, title: ".monica-root" }] });
    await expect(client.listObjects(handle, handle)).resolves.toMatchObject({ items: [{ objectId: handle, objectTypeId: "login" }] });
    await expect(client.revealObject(handle, handle)).resolves.toMatchObject({ payloadSchemaVersion: 1, payloadJson: expect.stringContaining("password:1") });
    await expect(client.upsertObject(handle, handle, { logicalObjectId: "password:1", objectTypeId: "login", title: "Example", payloadJson: JSON.stringify({ kind: "password", monica_entry_id: "password:1" }) })).resolves.toMatchObject({ commitId: "commit-3", objectId: handle });
    await expect(client.deleteObject(handle, handle, "password:1")).resolves.toMatchObject({ changed: true, commitId: "commit-4" });
    await expect(client.lockVault(handle)).resolves.toBe(true);
    expect((runtime.port.messages[4] as { params: unknown }).params).toEqual({
      source: { kind: "file", handle },
      credential: { method: "password", password: "" }
    });
    client.close();
  });

  it("bounds request time and closes the native port after a timeout", async () => {
    vi.useFakeTimers();
    const runtime = new FakeRuntime();
    const client = new Mdbx2NativeClient(runtime, () => "request-3");
    const request = client.hello(100);
    const rejection = expect(request).rejects.toMatchObject({ code: "native-request-timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(101);

    await rejection;
    expect(runtime.port.disconnected).toBe(true);
  });

  it("reports a missing Host without exposing the browser error text", async () => {
    const runtime = new FakeRuntime(undefined, new Error("Specified native messaging host not found."));
    const client = new Mdbx2NativeClient(runtime, () => "request-4");

    await expect(client.probe()).resolves.toEqual({
      availability: "not-installed",
      hostName: MDBX2_NATIVE_HOST_NAME,
      message: "尚未安装 Monica MDBX2 Native Host。"
    });
  });
});
