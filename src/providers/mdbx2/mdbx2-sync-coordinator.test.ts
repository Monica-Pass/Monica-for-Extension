import { sha256 } from "hash-wasm";
import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../../security/encoding";
import {
  MDBX2_MAX_BINARY_CHUNK_BYTES,
  type Mdbx2ExternalBlobReferencePage,
  type Mdbx2SyncSegmentPrepareResult,
  type Mdbx2SyncStateStatus,
  type Mdbx2TransferFinishResult
} from "./native-contract";
import { Mdbx2SyncCoordinator, type Mdbx2CloudRuntime } from "./mdbx2-sync-coordinator";
import { mdbx2BlobPath, mdbx2SegmentPath } from "./mdbx2-sync-paths";

interface Entry {
  directory: boolean;
  bytes?: Uint8Array;
  version: number;
}

class MemoryRemote {
  readonly entries = new Map<string, Entry>([["", { directory: true, version: 1 }]]);
  readonly writes: string[] = [];

  addFile(path: string, bytes: Uint8Array): void {
    const components = path.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const directory = components.slice(0, index).join("/");
      if (!this.entries.has(directory)) this.entries.set(directory, { directory: true, version: 1 });
    }
    this.entries.set(path, { directory: false, bytes: bytes.slice(), version: 1 });
  }

  readonly fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init.method || "GET").toUpperCase();
    const path = this.path(url.pathname);
    if (method === "PROPFIND") return this.propfind(path, new Headers(init.headers).get("depth") || "0");
    if (method === "MKCOL") {
      if (this.entries.has(path)) return new Response(null, { status: 405 });
      const parent = path.split("/").slice(0, -1).join("/");
      if (!this.entries.get(parent)?.directory) return new Response(null, { status: 409 });
      this.entries.set(path, { directory: true, version: 1 });
      return new Response(null, { status: 201 });
    }
    if (method === "GET") {
      const entry = this.entries.get(path);
      if (!entry?.bytes || entry.directory) return new Response(null, { status: 404 });
      return new Response(entry.bytes.slice(), { status: 200, headers: { "content-length": String(entry.bytes.length), etag: `"v${entry.version}"` } });
    }
    if (method === "PUT") {
      const existing = this.entries.get(path);
      const headers = new Headers(init.headers);
      if (headers.get("if-none-match") === "*" && existing) return new Response(null, { status: 412 });
      const parent = path.split("/").slice(0, -1).join("/");
      if (!this.entries.get(parent)?.directory) return new Response(null, { status: 409 });
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      this.entries.set(path, { directory: false, bytes, version: (existing?.version || 0) + 1 });
      this.writes.push(path);
      return new Response(null, { status: existing ? 204 : 201, headers: { etag: `"v${(existing?.version || 0) + 1}"` } });
    }
    return new Response(null, { status: 405 });
  };

  private propfind(path: string, depth: string): Response {
    const entry = this.entries.get(path);
    if (!entry) return new Response(null, { status: 404 });
    const paths = [path];
    if (depth === "1") {
      const prefix = path ? `${path}/` : "";
      for (const candidate of this.entries.keys()) {
        if (candidate !== path && candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/")) paths.push(candidate);
      }
    }
    const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${paths.map((candidate) => this.xml(candidate)).join("")}</d:multistatus>`;
    return new Response(xml, { status: 207 });
  }

  private xml(path: string): string {
    const entry = this.entries.get(path)!;
    const href = `/dav/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}${entry.directory && path ? "/" : ""}`;
    return `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${entry.directory ? "<d:collection/>" : ""}</d:resourcetype>${entry.directory ? "" : `<d:getcontentlength>${entry.bytes?.length || 0}</d:getcontentlength>`}<d:getetag>"v${entry.version}"</d:getetag></d:prop></d:propstat></d:response>`;
  }

  private path(pathname: string): string {
    if (pathname === "/dav" || pathname === "/dav/") return "";
    return pathname.slice("/dav/".length).replace(/\/$/, "").split("/").filter(Boolean).map(decodeURIComponent).join("/");
  }
}

const vaultHandle = "11111111-1111-4111-8111-111111111111";
const stateHandle = "22222222-2222-4222-8222-222222222222";
const fileHandle = "33333333-3333-4333-8333-333333333333";
const transferId = "44444444-4444-4444-8444-444444444444";
const credentials = { baseUrl: "https://vault.test/dav", username: "joyins", password: "secret", remotePath: "vaults/main.mdbx" };

function status(deviceId: string): Mdbx2SyncStateStatus {
  return {
    stateHandle,
    vaultHandle,
    vaultId: "vault-a",
    deviceId,
    initialized: true,
    hasLocalChanges: false,
    pendingBootstrap: false,
    pendingSegment: false,
    pendingRemoteAcknowledgement: false,
    remoteStreamCount: 0,
    blockedStreamCount: 0,
    blobTransferCount: 0,
    verifiedRemoteBlobCount: 0
  };
}

describe("MDBX2 Android-compatible WebDAV coordinator", () => {
  it("publishes verified Blobs before the segment that can reference them", async () => {
    const remote = new MemoryRemote();
    remote.addFile(credentials.remotePath, new TextEncoder().encode("bootstrap"));
    const segmentBytes = new TextEncoder().encode("authenticated-segment");
    const segmentFileSha = await sha256(segmentBytes);
    const payloadSha = "ab".repeat(32);
    const blobBytes = new TextEncoder().encode("encrypted-blob");
    const blobId = await sha256(blobBytes);
    let prepared = false;
    let blobVerified = false;
    const segment: Mdbx2SyncSegmentPrepareResult = {
      hasSegment: true,
      stateHandle,
      file: { fileHandle, purpose: "sync-segment", sizeBytes: segmentBytes.length, sha256: segmentFileSha },
      vaultId: "vault-a",
      sourceDeviceId: "device-a",
      transferId: "generation-a",
      segmentIndex: 0,
      isLast: true,
      commitCount: 1,
      deltaCount: 1,
      payloadSha256: payloadSha
    };
    const runtime = {
      syncStateStatus: async () => status("device-a"),
      prepareSyncSegment: async () => prepared ? { hasSegment: false, stateHandle } : segment,
      listExternalBlobs: async (): Promise<Mdbx2ExternalBlobReferencePage> => ({
        rawReferenceCount: 1,
        uniqueReferenceCount: 1,
        items: [{ blobId, totalSize: blobBytes.length, state: "available", remoteVerified: blobVerified }]
      }),
      readExternalBlob: async (_vault: string, _state: string, _binding: string, _id: string, totalSize: number, offset: number) => {
        const bytes = blobBytes.slice(offset);
        return { blobId, totalSize, offset, dataBase64: bytesToBase64(bytes), nextOffset: totalSize, isLast: true };
      },
      markRemoteBlobVerified: async () => { blobVerified = true; },
      readOutputFile: async (_vault: string, _state: string, _binding: string, _file: string, offset: number) => ({
        ...segment.file,
        offset,
        dataBase64: bytesToBase64(segmentBytes.slice(offset)),
        nextOffset: segmentBytes.length,
        eof: true
      }),
      commitSyncSegment: async () => { prepared = true; return { committed: true as const, hasMore: false }; },
      listSyncStreams: async () => [],
      beginInboundTransfer: async () => { throw new Error("unexpected download"); },
      sendInboundChunk: async () => { throw new Error("unexpected download"); },
      finishInboundTransfer: async () => { throw new Error("unexpected download"); },
      abortInboundTransfer: async () => false,
      releaseFile: async () => false,
      registerSyncState: async () => status("device-a"),
      prepareSyncBootstrap: async () => { throw new Error("unused"); },
      commitSyncBootstrap: async () => status("device-a"),
      blockSyncStream: async () => { throw new Error("unused"); },
      inspectSyncSegment: async () => { throw new Error("unused"); },
      applySyncSegment: async () => { throw new Error("unused"); },
      acknowledgeSyncSegment: async () => { throw new Error("unused"); },
      beginExternalBlobReceive: async () => { throw new Error("unused"); },
      writeExternalBlobReceiveChunk: async () => { throw new Error("unused"); }
    } satisfies Mdbx2CloudRuntime;
    const coordinator = new Mdbx2SyncCoordinator(runtime, remote.fetch);
    await expect(coordinator.status({ ...credentials, vaultHandle, syncStateHandle: stateHandle })).resolves.toMatchObject({
      initialized: true,
      deviceId: "device-a"
    });
    const report = await coordinator.synchronize({ ...credentials, vaultHandle, syncStateHandle: stateHandle });
    const blobPath = mdbx2BlobPath(credentials.remotePath, blobId);
    const segmentPath = mdbx2SegmentPath(credentials.remotePath, "device-a", "generation-a", 0, payloadSha);
    expect(report).toMatchObject({ uploadedBlobs: 1, uploadedSegments: 1 });
    expect(remote.writes.indexOf(blobPath)).toBeGreaterThanOrEqual(0);
    expect(remote.writes.indexOf(segmentPath)).toBeGreaterThan(remote.writes.indexOf(blobPath));
  });

  it("downloads, authenticates and applies a remote segment before acknowledging its Blob", async () => {
    const remote = new MemoryRemote();
    remote.addFile(credentials.remotePath, new TextEncoder().encode("bootstrap"));
    const segmentBytes = new TextEncoder().encode("android-segment");
    const segmentFileSha = await sha256(segmentBytes);
    const payloadSha = "cd".repeat(32);
    const segmentPath = mdbx2SegmentPath(credentials.remotePath, "device-a", "generation-a", 0, payloadSha);
    remote.addFile(segmentPath, segmentBytes);
    const blobBytes = new TextEncoder().encode("android-encrypted-blob");
    const blobId = await sha256(blobBytes);
    remote.addFile(mdbx2BlobPath(credentials.remotePath, blobId), blobBytes);
    let inbound = new Uint8Array();
    let applied = false;
    let acknowledged = false;
    let receivedBlob = new Uint8Array();
    const runtime = {
      syncStateStatus: async () => ({ ...status("device-b"), blockedStreamCount: 0 }),
      prepareSyncSegment: async () => ({ hasSegment: false as const, stateHandle }),
      listSyncStreams: async () => [],
      beginInboundTransfer: async (sizeBytes: number) => ({ transferId, nextOffset: 0, maxChunkBytes: MDBX2_MAX_BINARY_CHUNK_BYTES }),
      sendInboundChunk: async (_id: string, offset: number, bytes: Uint8Array) => {
        expect(offset).toBe(inbound.length);
        const next = new Uint8Array(inbound.length + bytes.length);
        next.set(inbound);
        next.set(bytes, inbound.length);
        inbound = next;
        return { nextOffset: inbound.length, acceptedBytes: bytes.length, repeated: false };
      },
      finishInboundTransfer: async (): Promise<Mdbx2TransferFinishResult> => ({ fileHandle, purpose: "sync-segment", sizeBytes: inbound.length, sha256: await sha256(inbound) }),
      abortInboundTransfer: async () => false,
      releaseFile: async () => false,
      inspectSyncSegment: async () => ({
        file: { fileHandle, purpose: "sync-segment", sizeBytes: inbound.length, sha256: segmentFileSha },
        vaultId: "vault-a",
        sourceDeviceId: "device-a",
        transferId: "generation-a",
        segmentIndex: 0,
        isLast: true,
        commitCount: 1,
        deltaCount: 1,
        payloadSha256: payloadSha
      }),
      applySyncSegment: async () => {
        applied = true;
        return { status: "applied" as const, appliedCommits: 1, skippedCommits: 0, conflictCount: 0, missingParentCount: 0, pendingAcknowledgement: true };
      },
      listExternalBlobs: async (): Promise<Mdbx2ExternalBlobReferencePage> => ({
        rawReferenceCount: 1,
        uniqueReferenceCount: 1,
        items: [{ blobId, state: receivedBlob.length === blobBytes.length ? "available" : "missing", totalSize: receivedBlob.length ? receivedBlob.length : undefined, remoteVerified: receivedBlob.length === blobBytes.length }]
      }),
      beginExternalBlobReceive: async () => ({ blobId, totalSize: blobBytes.length, nextOffset: receivedBlob.length, complete: receivedBlob.length === blobBytes.length }),
      writeExternalBlobReceiveChunk: async (_vault: string, _state: string, _binding: string, _blob: string, totalSize: number, offset: number, bytes: Uint8Array, finalize: boolean) => {
        expect(applied).toBe(true);
        expect(acknowledged).toBe(false);
        expect(offset).toBe(receivedBlob.length);
        const next = new Uint8Array(receivedBlob.length + bytes.length);
        next.set(receivedBlob);
        next.set(bytes, receivedBlob.length);
        receivedBlob = next;
        return { blobId, totalSize, nextOffset: receivedBlob.length, complete: finalize };
      },
      acknowledgeSyncSegment: async () => {
        expect(receivedBlob).toEqual(blobBytes);
        acknowledged = true;
        return { streamId: "device-a/generation-a", deviceId: "device-a", generationId: "generation-a", nextSequence: 1, lastAppliedDigest: payloadSha };
      },
      registerSyncState: async () => status("device-b"),
      prepareSyncBootstrap: async () => { throw new Error("unused"); },
      commitSyncBootstrap: async () => status("device-b"),
      readOutputFile: async () => { throw new Error("unused"); },
      commitSyncSegment: async () => ({ committed: true as const, hasMore: false }),
      blockSyncStream: async () => { throw new Error("unused"); },
      readExternalBlob: async () => { throw new Error("unused"); },
      markRemoteBlobVerified: async () => undefined
    } satisfies Mdbx2CloudRuntime;
    const coordinator = new Mdbx2SyncCoordinator(runtime, remote.fetch);
    const report = await coordinator.synchronize({ ...credentials, vaultHandle, syncStateHandle: stateHandle });
    expect(report).toMatchObject({ downloadedSegments: 1, downloadedBlobs: 1, appliedCommits: 1, blockedStreams: 0 });
    expect(applied).toBe(true);
    expect(acknowledged).toBe(true);
  });
});
