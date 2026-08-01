import { createSHA256, sha256 } from "hash-wasm";
import type { WebDavCredentials } from "../webdav/webdav-client";
import { normalizeServerUrl } from "../webdav/webdav-client";
import { base64ToBytes } from "../../security/encoding";
import {
  MDBX2_MAX_BINARY_CHUNK_BYTES,
  MDBX2_MAX_INBOUND_FILE_BYTES,
  MDBX2_MAX_REMOTE_BLOB_BYTES,
  type Mdbx2ExternalBlobChunk,
  type Mdbx2ExternalBlobReceiveState,
  type Mdbx2ExternalBlobReferencePage,
  type Mdbx2RemoteStreamSummary,
  type Mdbx2SyncBootstrapPrepareResult,
  type Mdbx2SyncSegmentApplyResult,
  type Mdbx2SyncSegmentDescriptor,
  type Mdbx2SyncSegmentPrepareResult,
  type Mdbx2SyncStateStatus,
  type Mdbx2TransferBeginResult,
  type Mdbx2TransferChunkResult,
  type Mdbx2TransferFinishResult,
  type Mdbx2TransferReadResult
} from "./native-contract";
import {
  mdbx2BlobPath,
  mdbx2BlobsRoot,
  mdbx2SegmentPath,
  mdbx2StreamsRoot,
  normalizeMdbx2RemoteComponent,
  normalizeMdbx2RemotePath,
  parseMdbx2RemoteSegmentPath,
  type Mdbx2RemoteSegmentDescriptor
} from "./mdbx2-sync-paths";
import { Mdbx2WebDavClient, type Mdbx2WebDavObject } from "./mdbx2-webdav-client";

const MAX_SEGMENTS_PER_SYNC = 10_000;
const MAX_RECEIVE_PASSES = 4;

export interface Mdbx2WebDavSyncConfig extends WebDavCredentials {
  remotePath: string;
  syncStateHandle?: string;
}

export interface Mdbx2CloudSyncInput extends Mdbx2WebDavSyncConfig {
  vaultHandle: string;
  syncStateHandle: string;
}

export interface Mdbx2CloudSyncReport {
  uploadedSegments: number;
  downloadedSegments: number;
  uploadedBlobs: number;
  downloadedBlobs: number;
  appliedCommits: number;
  skippedCommits: number;
  conflicts: number;
  blockedStreams: number;
}

export interface Mdbx2CloudRuntime {
  beginInboundTransfer(sizeBytes: number, sha256?: string, purpose?: "vault-bootstrap" | "sync-segment"): Promise<Mdbx2TransferBeginResult>;
  sendInboundChunk(transferId: string, offset: number, bytes: Uint8Array): Promise<Mdbx2TransferChunkResult>;
  finishInboundTransfer(transferId: string): Promise<Mdbx2TransferFinishResult>;
  abortInboundTransfer(transferId: string): Promise<boolean>;
  releaseFile(fileHandle: string): Promise<boolean>;
  readOutputFile(vaultHandle: string, stateHandle: string, remoteBinding: string, fileHandle: string, offset: number, maxBytes?: number): Promise<Mdbx2TransferReadResult>;
  registerSyncState(vaultHandle: string, remoteBinding: string, stateHandle?: string): Promise<Mdbx2SyncStateStatus>;
  syncStateStatus(vaultHandle: string, stateHandle: string, remoteBinding: string): Promise<Mdbx2SyncStateStatus>;
  prepareSyncBootstrap(vaultHandle: string, remoteBinding: string, stateHandle?: string): Promise<Mdbx2SyncBootstrapPrepareResult>;
  commitSyncBootstrap(vaultHandle: string, stateHandle: string, remoteBinding: string, fileHandle: string): Promise<Mdbx2SyncStateStatus>;
  prepareSyncSegment(vaultHandle: string, stateHandle: string, remoteBinding: string): Promise<Mdbx2SyncSegmentPrepareResult>;
  commitSyncSegment(vaultHandle: string, stateHandle: string, remoteBinding: string, fileHandle: string, payloadSha256: string): Promise<{ committed: true; hasMore: boolean }>;
  listSyncStreams(vaultHandle: string, stateHandle: string, remoteBinding: string): Promise<Mdbx2RemoteStreamSummary[]>;
  blockSyncStream(vaultHandle: string, stateHandle: string, remoteBinding: string, descriptor: { deviceId: string; generationId: string; sequence: number; digest: string; reason: string }): Promise<Mdbx2RemoteStreamSummary>;
  inspectSyncSegment(vaultHandle: string, fileHandle: string): Promise<Mdbx2SyncSegmentDescriptor>;
  applySyncSegment(vaultHandle: string, stateHandle: string, remoteBinding: string, fileHandle: string, descriptor: { deviceId: string; generationId: string; sequence: number; digest: string }): Promise<Mdbx2SyncSegmentApplyResult>;
  acknowledgeSyncSegment(vaultHandle: string, stateHandle: string, remoteBinding: string, descriptor: { deviceId: string; generationId: string; sequence: number; digest: string }): Promise<Mdbx2RemoteStreamSummary>;
  listExternalBlobs(vaultHandle: string, stateHandle: string, remoteBinding: string, cursor?: string): Promise<Mdbx2ExternalBlobReferencePage>;
  readExternalBlob(vaultHandle: string, stateHandle: string, remoteBinding: string, blobId: string, totalSize: number, offset: number, maxBytes?: number): Promise<Mdbx2ExternalBlobChunk>;
  markRemoteBlobVerified(vaultHandle: string, stateHandle: string, remoteBinding: string, blobId: string, totalSize: number): Promise<void>;
  beginExternalBlobReceive(vaultHandle: string, stateHandle: string, remoteBinding: string, blobId: string, totalSize: number): Promise<Mdbx2ExternalBlobReceiveState>;
  writeExternalBlobReceiveChunk(vaultHandle: string, stateHandle: string, remoteBinding: string, blobId: string, totalSize: number, offset: number, bytes: Uint8Array, finalize: boolean): Promise<Mdbx2ExternalBlobReceiveState>;
}

interface PreparedContext {
  input: Mdbx2CloudSyncInput;
  remotePath: string;
  remoteBinding: string;
  webdav: Mdbx2WebDavClient;
  status: Mdbx2SyncStateStatus;
}

export class Mdbx2SyncCoordinator {
  constructor(
    private readonly runtime: Mdbx2CloudRuntime,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  async publishBootstrap(input: Omit<Mdbx2CloudSyncInput, "syncStateHandle"> & { syncStateHandle?: string }, signal?: AbortSignal): Promise<{ stateHandle: string; status: Mdbx2SyncStateStatus }> {
    signal?.throwIfAborted();
    const remotePath = normalizeMdbx2RemotePath(input.remotePath);
    const remoteBinding = await mdbx2RemoteBinding(input, remotePath);
    const webdav = this.webdav(input);
    await webdav.testConnection(signal);
    const prepared = await this.runtime.prepareSyncBootstrap(input.vaultHandle, remoteBinding, input.syncStateHandle);
    try {
      const body = await this.readOutputBlob(input.vaultHandle, prepared.stateHandle, remoteBinding, prepared.file, signal);
      await webdav.putImmutable(remotePath, body, prepared.file.sha256, signal);
      await webdav.ensureDirectory(mdbx2StreamsRoot(remotePath), signal);
      await webdav.ensureDirectory(mdbx2BlobsRoot(remotePath), signal);
      const status = await this.runtime.commitSyncBootstrap(input.vaultHandle, prepared.stateHandle, remoteBinding, prepared.file.fileHandle);
      return { stateHandle: prepared.stateHandle, status };
    } catch (error) {
      throw error;
    }
  }

  async downloadBootstrap(input: Mdbx2WebDavSyncConfig, signal?: AbortSignal): Promise<Mdbx2TransferFinishResult> {
    signal?.throwIfAborted();
    const remotePath = normalizeMdbx2RemotePath(input.remotePath);
    const webdav = this.webdav(input);
    await webdav.testConnection(signal);
    const remote = await requireRemoteFile(webdav, remotePath, MDBX2_MAX_INBOUND_FILE_BYTES, signal);
    return this.downloadToHost(webdav, remote, "vault-bootstrap", signal);
  }

  async registerDownloadedBootstrap(vaultHandle: string, input: Mdbx2WebDavSyncConfig): Promise<Mdbx2SyncStateStatus> {
    const remotePath = normalizeMdbx2RemotePath(input.remotePath);
    return this.runtime.registerSyncState(vaultHandle, await mdbx2RemoteBinding(input, remotePath), input.syncStateHandle);
  }

  async status(input: Mdbx2CloudSyncInput): Promise<Mdbx2SyncStateStatus> {
    const remotePath = normalizeMdbx2RemotePath(input.remotePath);
    return this.runtime.syncStateStatus(
      input.vaultHandle,
      input.syncStateHandle,
      await mdbx2RemoteBinding(input, remotePath)
    );
  }

  async synchronize(input: Mdbx2CloudSyncInput, signal?: AbortSignal): Promise<Mdbx2CloudSyncReport> {
    const context = await this.prepare(input, signal);
    const report: Mdbx2CloudSyncReport = {
      uploadedSegments: 0,
      downloadedSegments: 0,
      uploadedBlobs: 0,
      downloadedBlobs: 0,
      appliedCommits: 0,
      skippedCommits: 0,
      conflicts: 0,
      blockedStreams: 0
    };
    await this.publishLocal(context, report, signal);
    await this.receiveRemote(context, report, signal);
    const status = await this.runtime.syncStateStatus(input.vaultHandle, input.syncStateHandle, context.remoteBinding);
    report.blockedStreams = status.blockedStreamCount;
    return report;
  }

  private async prepare(input: Mdbx2CloudSyncInput, signal?: AbortSignal): Promise<PreparedContext> {
    signal?.throwIfAborted();
    const remotePath = normalizeMdbx2RemotePath(input.remotePath);
    const remoteBinding = await mdbx2RemoteBinding(input, remotePath);
    const webdav = this.webdav(input);
    await webdav.testConnection(signal);
    const status = await this.runtime.syncStateStatus(input.vaultHandle, input.syncStateHandle, remoteBinding);
    if (!status.initialized) throw new Error("MDBX2 WebDAV 同步尚未注册可移植 bootstrap。");
    const bootstrap = await webdav.stat(remotePath, signal);
    if (!bootstrap || bootstrap.isDirectory || !bootstrap.sizeBytes) throw new Error("MDBX2 WebDAV 可移植 bootstrap 不存在或无效。");
    return { input, remotePath, remoteBinding, webdav, status };
  }

  private async publishLocal(context: PreparedContext, report: Mdbx2CloudSyncReport, signal?: AbortSignal): Promise<void> {
    for (let index = 0; index < MAX_SEGMENTS_PER_SYNC; index += 1) {
      signal?.throwIfAborted();
      const prepared = await this.runtime.prepareSyncSegment(
        context.input.vaultHandle,
        context.input.syncStateHandle,
        context.remoteBinding
      );
      if (!prepared.hasSegment) return;
      report.uploadedBlobs += await this.uploadReferencedBlobs(context, signal);
      if (prepared.commitCount > 0 || prepared.deltaCount > 0) {
        const body = await this.readOutputBlob(
          context.input.vaultHandle,
          context.input.syncStateHandle,
          context.remoteBinding,
          prepared.file,
          signal
        );
        const path = mdbx2SegmentPath(
          context.remotePath,
          prepared.sourceDeviceId,
          prepared.transferId,
          prepared.segmentIndex,
          prepared.payloadSha256
        );
        await context.webdav.putImmutable(path, body, prepared.file.sha256, signal);
        report.uploadedSegments += 1;
      }
      await this.runtime.commitSyncSegment(
        context.input.vaultHandle,
        context.input.syncStateHandle,
        context.remoteBinding,
        prepared.file.fileHandle,
        prepared.payloadSha256
      );
    }
    throw new Error(`MDBX2 单次同步产生的增量段超过 ${MAX_SEGMENTS_PER_SYNC} 个。`);
  }

  private async uploadReferencedBlobs(context: PreparedContext, signal?: AbortSignal): Promise<number> {
    let cursor: string | undefined;
    let uploaded = 0;
    do {
      signal?.throwIfAborted();
      const page = await this.runtime.listExternalBlobs(
        context.input.vaultHandle,
        context.input.syncStateHandle,
        context.remoteBinding,
        cursor
      );
      for (const reference of page.items) {
        signal?.throwIfAborted();
        if (reference.state !== "available" || !reference.totalSize) throw new Error(`MDBX2 Blob ${reference.blobId} 在本机不可用。`);
        if (reference.remoteVerified) continue;
        const remotePath = mdbx2BlobPath(context.remotePath, reference.blobId);
        const existing = await context.webdav.stat(remotePath, signal);
        if (existing) {
          if (existing.isDirectory || existing.sizeBytes !== undefined && existing.sizeBytes !== reference.totalSize) {
            throw new Error(`MDBX2 WebDAV Blob 元数据不一致: ${reference.blobId}`);
          }
          const verified = await context.webdav.download(remotePath, reference.totalSize, () => undefined, signal);
          if (verified.sizeBytes !== reference.totalSize || verified.sha256 !== reference.blobId) {
            throw new Error(`MDBX2 WebDAV Blob 内容摘要不一致: ${reference.blobId}`);
          }
          await this.runtime.markRemoteBlobVerified(
            context.input.vaultHandle,
            context.input.syncStateHandle,
            context.remoteBinding,
            reference.blobId,
            reference.totalSize
          );
          continue;
        }
        const body = await this.readExternalBlobBody(context, reference.blobId, reference.totalSize, signal);
        await context.webdav.putImmutable(remotePath, body, reference.blobId, signal);
        await this.runtime.markRemoteBlobVerified(
          context.input.vaultHandle,
          context.input.syncStateHandle,
          context.remoteBinding,
          reference.blobId,
          reference.totalSize
        );
        uploaded += 1;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return uploaded;
  }

  private async receiveRemote(context: PreparedContext, report: Mdbx2CloudSyncReport, signal?: AbortSignal): Promise<void> {
    const descriptors = (await listRemoteSegments(context.webdav, context.remotePath, signal))
      .filter((descriptor) => descriptor.deviceId !== context.status.deviceId);
    let streams = new Map((await this.runtime.listSyncStreams(
      context.input.vaultHandle,
      context.input.syncStateHandle,
      context.remoteBinding
    )).map((stream) => [stream.streamId, stream]));
    for (let pass = 0; pass < MAX_RECEIVE_PASSES; pass += 1) {
      signal?.throwIfAborted();
      let progressed = false;
      for (const [streamId, files] of groupSegments(descriptors)) {
        let stream = streams.get(streamId);
        for (const descriptor of files) {
          signal?.throwIfAborted();
          const expected = stream?.nextSequence || 0;
          if (descriptor.sequence < expected) {
            if (descriptor.sequence === expected - 1 && stream?.lastAppliedDigest && stream.lastAppliedDigest !== descriptor.digestHex) {
              stream = await this.runtime.blockSyncStream(
                context.input.vaultHandle,
                context.input.syncStateHandle,
                context.remoteBinding,
                { ...hostDescriptor(descriptor), reason: `conflicting digest for segment ${descriptor.sequence}` }
              );
              streams.set(streamId, stream);
              break;
            }
            continue;
          }
          if (descriptor.sequence > expected) {
            stream = await this.runtime.blockSyncStream(
              context.input.vaultHandle,
              context.input.syncStateHandle,
              context.remoteBinding,
              { ...hostDescriptor(descriptor), reason: `missing segment ${expected}` }
            );
            streams.set(streamId, stream);
            break;
          }
          const remote = await requireRemoteFile(context.webdav, descriptor.path, MDBX2_MAX_INBOUND_FILE_BYTES, signal);
          const transferred = await this.downloadToHost(context.webdav, remote, "sync-segment", signal);
          report.downloadedSegments += 1;
          try {
            const inspected = await this.runtime.inspectSyncSegment(context.input.vaultHandle, transferred.fileHandle);
            requireAuthenticatedDescriptor(inspected, descriptor);
          } catch (error) {
            await this.runtime.releaseFile(transferred.fileHandle).catch(() => undefined);
            throw error;
          }
          let applied: Mdbx2SyncSegmentApplyResult;
          try {
            applied = await this.runtime.applySyncSegment(
              context.input.vaultHandle,
              context.input.syncStateHandle,
              context.remoteBinding,
              transferred.fileHandle,
              hostDescriptor(descriptor)
            );
          } catch (error) {
            await this.runtime.releaseFile(transferred.fileHandle).catch(() => undefined);
            throw error;
          }
          report.appliedCommits += applied.appliedCommits;
          report.skippedCommits += applied.skippedCommits;
          report.conflicts += applied.conflictCount;
          if (applied.status === "blocked") {
            streams = new Map((await this.runtime.listSyncStreams(
              context.input.vaultHandle,
              context.input.syncStateHandle,
              context.remoteBinding
            )).map((candidate) => [candidate.streamId, candidate]));
            break;
          }
          if (applied.pendingAcknowledgement) {
            report.downloadedBlobs += await this.downloadMissingBlobs(context, signal);
            stream = await this.runtime.acknowledgeSyncSegment(
              context.input.vaultHandle,
              context.input.syncStateHandle,
              context.remoteBinding,
              hostDescriptor(descriptor)
            );
            streams.set(streamId, stream);
          }
          progressed = true;
        }
      }
      if (!progressed) break;
    }
  }

  private async downloadMissingBlobs(context: PreparedContext, signal?: AbortSignal): Promise<number> {
    let cursor: string | undefined;
    let downloaded = 0;
    do {
      signal?.throwIfAborted();
      const page = await this.runtime.listExternalBlobs(
        context.input.vaultHandle,
        context.input.syncStateHandle,
        context.remoteBinding,
        cursor
      );
      for (const reference of page.items) {
        signal?.throwIfAborted();
        if (reference.state === "available" && reference.totalSize) continue;
        const remotePath = mdbx2BlobPath(context.remotePath, reference.blobId);
        const remote = await requireRemoteFile(context.webdav, remotePath, MDBX2_MAX_REMOTE_BLOB_BYTES, signal);
        if (reference.totalSize !== undefined && reference.totalSize !== remote.sizeBytes) throw new Error(`MDBX2 WebDAV Blob 大小不一致: ${reference.blobId}`);
        let receive = await this.runtime.beginExternalBlobReceive(
          context.input.vaultHandle,
          context.input.syncStateHandle,
          context.remoteBinding,
          reference.blobId,
          remote.sizeBytes
        );
        if (receive.complete) continue;
        const result = await context.webdav.download(remotePath, remote.sizeBytes, async (chunk, offset) => {
          const nextOffset = offset + chunk.length;
          receive = await this.runtime.writeExternalBlobReceiveChunk(
            context.input.vaultHandle,
            context.input.syncStateHandle,
            context.remoteBinding,
            reference.blobId,
            remote.sizeBytes,
            offset,
            chunk,
            nextOffset === remote.sizeBytes
          );
        }, signal);
        if (result.sha256 !== reference.blobId || result.sizeBytes !== remote.sizeBytes || !receive.complete) {
          throw new Error(`MDBX2 WebDAV Blob 完整性检查失败: ${reference.blobId}`);
        }
        downloaded += 1;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return downloaded;
  }

  private async readOutputBlob(
    vaultHandle: string,
    stateHandle: string,
    remoteBinding: string,
    file: Mdbx2SyncBootstrapPrepareResult["file"] | Mdbx2SyncSegmentDescriptor["file"],
    signal?: AbortSignal
  ): Promise<Blob> {
    const hasher = await createSHA256();
    hasher.init();
    const parts: Blob[] = [];
    let offset = 0;
    while (offset < file.sizeBytes) {
      signal?.throwIfAborted();
      const chunk = await this.runtime.readOutputFile(vaultHandle, stateHandle, remoteBinding, file.fileHandle, offset);
      if (chunk.fileHandle !== file.fileHandle || chunk.sizeBytes !== file.sizeBytes || chunk.sha256 !== file.sha256 || chunk.offset !== offset) {
        throw new Error("MDBX2 Native Host 输出文件描述在读取期间发生变化。");
      }
      const bytes = base64ToBytes(chunk.dataBase64);
      hasher.update(bytes);
      parts.push(new Blob([Uint8Array.from(bytes).buffer]));
      offset = chunk.nextOffset;
      if (chunk.eof !== (offset === file.sizeBytes)) throw new Error("MDBX2 Native Host 输出文件边界无效。");
    }
    if (hasher.digest("hex") !== file.sha256) throw new Error("MDBX2 Native Host 输出文件摘要不一致。");
    const body = new Blob(parts, { type: "application/octet-stream" });
    if (body.size !== file.sizeBytes) throw new Error("MDBX2 Native Host 输出文件大小不一致。");
    return body;
  }

  private async readExternalBlobBody(context: PreparedContext, blobId: string, totalSize: number, signal?: AbortSignal): Promise<Blob> {
    const hasher = await createSHA256();
    hasher.init();
    const parts: Blob[] = [];
    let offset = 0;
    while (offset < totalSize) {
      signal?.throwIfAborted();
      const chunk = await this.runtime.readExternalBlob(
        context.input.vaultHandle,
        context.input.syncStateHandle,
        context.remoteBinding,
        blobId,
        totalSize,
        offset,
        MDBX2_MAX_BINARY_CHUNK_BYTES
      );
      if (chunk.blobId !== blobId || chunk.totalSize !== totalSize || chunk.offset !== offset) throw new Error(`MDBX2 Blob ${blobId} 分块描述无效。`);
      const bytes = base64ToBytes(chunk.dataBase64);
      hasher.update(bytes);
      parts.push(new Blob([Uint8Array.from(bytes).buffer]));
      offset = chunk.nextOffset;
      if (chunk.isLast !== (offset === totalSize)) throw new Error(`MDBX2 Blob ${blobId} 分块边界无效。`);
    }
    if (hasher.digest("hex") !== blobId) throw new Error(`MDBX2 Blob ${blobId} 摘要不一致。`);
    return new Blob(parts, { type: "application/octet-stream" });
  }

  private async downloadToHost(
    webdav: Mdbx2WebDavClient,
    remote: Required<Pick<Mdbx2WebDavObject, "path" | "sizeBytes">> & Mdbx2WebDavObject,
    purpose: "vault-bootstrap" | "sync-segment",
    signal?: AbortSignal
  ): Promise<Mdbx2TransferFinishResult> {
    const begun = await this.runtime.beginInboundTransfer(remote.sizeBytes, undefined, purpose);
    let finished = false;
    try {
      const downloaded = await webdav.download(remote.path, remote.sizeBytes, async (chunk, offset) => {
        const accepted = await this.runtime.sendInboundChunk(begun.transferId, offset, chunk);
        if (accepted.nextOffset < offset + chunk.length) throw new Error("MDBX2 Native Host 未完整接收下载分块。");
      }, signal);
      const result = await this.runtime.finishInboundTransfer(begun.transferId);
      finished = true;
      if (result.purpose !== purpose || result.sizeBytes !== downloaded.sizeBytes || result.sha256 !== downloaded.sha256) {
        await this.runtime.releaseFile(result.fileHandle).catch(() => undefined);
        throw new Error("MDBX2 WebDAV 下载与 Native Host 校验结果不一致。");
      }
      return result;
    } finally {
      if (!finished) await this.runtime.abortInboundTransfer(begun.transferId).catch(() => undefined);
    }
  }

  private webdav(input: WebDavCredentials): Mdbx2WebDavClient {
    return new Mdbx2WebDavClient({
      baseUrl: normalizeServerUrl(input.baseUrl),
      username: input.username,
      password: input.password
    }, this.fetcher);
  }
}

export async function mdbx2RemoteBinding(input: WebDavCredentials, remotePath: string): Promise<string> {
  return sha256(`${normalizeServerUrl(input.baseUrl)}\n${normalizeMdbx2RemotePath(remotePath)}`);
}

async function requireRemoteFile(
  webdav: Mdbx2WebDavClient,
  path: string,
  maximumBytes: number,
  signal?: AbortSignal
): Promise<Required<Pick<Mdbx2WebDavObject, "path" | "sizeBytes">> & Mdbx2WebDavObject> {
  const remote = await webdav.stat(path, signal);
  if (!remote || remote.isDirectory || !remote.sizeBytes || remote.sizeBytes > maximumBytes) throw new Error(`MDBX2 WebDAV 文件不存在或超过安全上限: ${path}`);
  return remote as Required<Pick<Mdbx2WebDavObject, "path" | "sizeBytes">> & Mdbx2WebDavObject;
}

async function listRemoteSegments(webdav: Mdbx2WebDavClient, remotePath: string, signal?: AbortSignal): Promise<Mdbx2RemoteSegmentDescriptor[]> {
  const streamsRoot = mdbx2StreamsRoot(remotePath);
  if (!(await webdav.stat(streamsRoot, signal))?.isDirectory) return [];
  const descriptors: Mdbx2RemoteSegmentDescriptor[] = [];
  for (const device of await webdav.list(streamsRoot, signal)) {
    if (!device.isDirectory) continue;
    normalizeMdbx2RemoteComponent(device.path.slice(`${streamsRoot}/`.length));
    for (const generation of await webdav.list(device.path, signal)) {
      if (!generation.isDirectory) continue;
      normalizeMdbx2RemoteComponent(generation.path.slice(`${device.path}/`.length));
      const segmentsPath = `${generation.path}/segments`;
      if (!(await webdav.stat(segmentsPath, signal))?.isDirectory) continue;
      for (const segment of await webdav.list(segmentsPath, signal)) {
        if (segment.isDirectory) continue;
        const descriptor = parseMdbx2RemoteSegmentPath(remotePath, segment.path);
        if (!descriptor) continue;
        descriptors.push(descriptor);
        if (descriptors.length > MAX_SEGMENTS_PER_SYNC) throw new Error(`MDBX2 远端增量段超过单次同步上限 ${MAX_SEGMENTS_PER_SYNC}。`);
      }
    }
  }
  return descriptors.sort((left, right) => left.streamId.localeCompare(right.streamId) || left.sequence - right.sequence || left.digestHex.localeCompare(right.digestHex));
}

function groupSegments(descriptors: Mdbx2RemoteSegmentDescriptor[]): Map<string, Mdbx2RemoteSegmentDescriptor[]> {
  const groups = new Map<string, Mdbx2RemoteSegmentDescriptor[]>();
  for (const descriptor of descriptors) {
    const current = groups.get(descriptor.streamId) || [];
    current.push(descriptor);
    groups.set(descriptor.streamId, current);
  }
  return new Map([...groups].sort(([left], [right]) => left.localeCompare(right)).map(([streamId, files]) => [streamId, files.sort((left, right) => left.sequence - right.sequence || left.digestHex.localeCompare(right.digestHex))]));
}

function hostDescriptor(descriptor: Mdbx2RemoteSegmentDescriptor): { deviceId: string; generationId: string; sequence: number; digest: string } {
  return {
    deviceId: descriptor.deviceId,
    generationId: descriptor.generationId,
    sequence: descriptor.sequence,
    digest: descriptor.digestHex
  };
}

function requireAuthenticatedDescriptor(inspected: Mdbx2SyncSegmentDescriptor, remote: Mdbx2RemoteSegmentDescriptor): void {
  if (
    inspected.sourceDeviceId !== remote.deviceId ||
    inspected.transferId !== remote.generationId ||
    inspected.segmentIndex !== remote.sequence ||
    inspected.payloadSha256 !== remote.digestHex
  ) {
    throw new Error("MDBX2 远端增量段名称与认证元数据不一致。");
  }
}
