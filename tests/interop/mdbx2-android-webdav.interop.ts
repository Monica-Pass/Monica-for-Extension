import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { base64ToBytes } from "../../src/security/encoding";
import {
  MDBX2_FORMAT_VERSION,
  MDBX2_MAX_BINARY_CHUNK_BYTES,
  MDBX2_CORE_REVISION,
  type Mdbx2AttachmentSummary,
  type Mdbx2ObjectRecord
} from "../../src/providers/mdbx2/native-contract";
import { Mdbx2NativeClient } from "../../src/providers/mdbx2/native-client";
import { Mdbx2SyncCoordinator } from "../../src/providers/mdbx2/mdbx2-sync-coordinator";
import {
  mdbx2BlobsRoot,
  parseMdbx2RemoteSegmentPath,
  type Mdbx2RemoteSegmentDescriptor
} from "../../src/providers/mdbx2/mdbx2-sync-paths";
import {
  acquireAndroidInteropPrerequisites,
  buildInjectedAndroidTest,
  clearAndroidFixture,
  ensureAndroidEnvironment,
  installAndroidFixture,
  LocalWebDavServer,
  ProcessNativeRuntime,
  pullAndroidFixtureFile,
  pullAndroidFixtureTree,
  pushAndroidFixtureFile,
  runAndroidFixtureMethod,
  sha256Hex,
  stopAndroidEnvironment
} from "./mdbx2-interop-support";

const FIXTURE_FORMAT = "monica-mdbx2-android-interop-v1";
const PASSWORD = "mdbx2-android-extension-interop-password";
const BROWSER_LOGICAL_ID = "password:browser-interop";
const BROWSER_ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";
const BROWSER_ATTACHMENT_NAME = "browser-fixture.bin";
const BROWSER_ATTACHMENT_SIZE = 710_000;
const ANDROID_ATTACHMENT_SIZE = 700_000;
const ANDROID_RETURN_ATTACHMENT_SIZE = 720_000;

interface SegmentManifest {
  path: string;
  deviceId: string;
  generationId: string;
  sequence: number;
  digest: string;
  sizeBytes: number;
}

interface BlobManifest {
  path: string;
  blobId: string;
  sizeBytes: number;
}

interface AndroidExportManifest {
  format: string;
  remotePath: string;
  vaultId: string;
  deviceId: string;
  androidProjectId: string;
  androidEntryId: string;
  androidLogicalObjectId: string;
  androidAttachmentId: string;
  androidAttachmentName: string;
  androidAttachmentPlaintextSha256: string;
  segments: SegmentManifest[];
  blobs: BlobManifest[];
}

interface AndroidReturnManifest {
  format: string;
  vaultId: string;
  deviceId: string;
  androidReturnEntryId: string;
  androidReturnLogicalObjectId: string;
  androidReturnAttachmentId: string;
  androidReturnAttachmentName: string;
  androidReturnAttachmentPlaintextSha256: string;
  segments: SegmentManifest[];
  blobs: BlobManifest[];
}

describe("MDBX2 current Android and browser WebDAV interoperability", () => {
  it("exchanges authenticated objects and external Blobs Android → browser → Android → browser", async () => {
    if (process.platform !== "win32") throw new Error("This interoperability acceptance currently requires Windows and the configured Android AVD.");
    const extensionRoot = resolve(process.cwd());
    const workspaceRoot = resolve(extensionRoot, "..");
    const androidRepository = process.env.MONICA_ANDROID_REPOSITORY || join(workspaceRoot, "Monica-main");
    const hostExecutable = join(extensionRoot, "native", "mdbx2-host", "target", "debug", "monica-mdbx2-host.exe");
    if (!existsSync(hostExecutable)) throw new Error("Build the MDBX2 Native Host before running Android interoperability acceptance.");
    const tempParent = join(extensionRoot, ".tmp", "mdbx2-android-interop");
    await mkdir(tempParent, { recursive: true });
    const runRoot = await mkdtemp(join(tempParent, "run-"));
    const server = new LocalWebDavServer("android-interop", "webdav-interop-password");
    let androidEnvironment: Awaited<ReturnType<typeof ensureAndroidEnvironment>> | undefined;
    let firstClient: Mdbx2NativeClient | undefined;
    let secondClient: Mdbx2NativeClient | undefined;
    try {
      const { apk, environment } = await acquireAndroidInteropPrerequisites(
        () => buildInjectedAndroidTest(extensionRoot, androidRepository),
        () => ensureAndroidEnvironment(androidRepository)
      );
      androidEnvironment = environment;
      await installAndroidFixture(environment, apk);
      await clearAndroidFixture(environment);
      await runAndroidFixtureMethod(environment, "exportAndroidBootstrapSegmentsAndBlob");

      const initialManifestPath = join(runRoot, "android-initial", "manifest.json");
      const initialRemoteRoot = join(runRoot, "android-initial", "remote");
      await pullAndroidFixtureFile(environment, "manifest.json", initialManifestPath);
      await pullAndroidFixtureTree(environment, "remote", initialRemoteRoot);
      const initialManifest = JSON.parse(await readFile(initialManifestPath, "utf8")) as AndroidExportManifest;
      validateAndroidExportManifest(initialManifest);

      await server.loadDirectory(initialRemoteRoot);
      await server.start();
      const bootstrapBefore = server.file(initialManifest.remotePath);
      const protectedRemoteBytes = new Map<string, Buffer>();
      for (const item of [...initialManifest.segments, ...initialManifest.blobs]) {
        protectedRemoteBytes.set(item.path, server.file(item.path));
      }

      const hostData = join(runRoot, "browser-host-data");
      await mkdir(hostData, { recursive: true });
      const webDavConfig = {
        baseUrl: server.baseUrl,
        username: server.username,
        password: server.password,
        remotePath: initialManifest.remotePath
      };
      firstClient = new Mdbx2NativeClient(new ProcessNativeRuntime(hostExecutable, hostData));
      const capabilities = await firstClient.hello(30_000);
      expect(capabilities.mdbxCoreRevision).toBe(MDBX2_CORE_REVISION);
      expect(capabilities.mdbxFormatVersion).toBe(MDBX2_FORMAT_VERSION);
      expect(capabilities.supportsMdbx1).toBe(false);

      const firstCoordinator = new Mdbx2SyncCoordinator(firstClient);
      const downloaded = await firstCoordinator.downloadBootstrap(webDavConfig);
      const inspection = await firstClient.inspectVault({ kind: "file", handle: downloaded.fileHandle }, 30_000);
      expect(inspection).toMatchObject({ formatVersion: MDBX2_FORMAT_VERSION, requiresUpgrade: false, unknownCriticalExtensions: false });
      const opened = await firstClient.openVault(
        { kind: "file", handle: downloaded.fileHandle },
        { method: "password", password: PASSWORD }
      );
      expect(opened.vaultId).toBe(initialManifest.vaultId);
      expect(opened.deviceId).not.toBe(initialManifest.deviceId);
      const registered = await firstCoordinator.registerDownloadedBootstrap(opened.vaultHandle, webDavConfig);
      const syncInput = { ...webDavConfig, vaultHandle: opened.vaultHandle, syncStateHandle: registered.stateHandle };
      const androidToBrowser = await firstCoordinator.synchronize(syncInput);
      expect(androidToBrowser.downloadedSegments).toBeGreaterThanOrEqual(initialManifest.segments.length);
      expect(androidToBrowser.downloadedBlobs).toBeGreaterThanOrEqual(initialManifest.blobs.length);
      expect(androidToBrowser.blockedStreams).toBe(0);

      const androidRecord = await findRecord(firstClient, opened.vaultHandle, initialManifest.androidLogicalObjectId);
      expect(androidRecord.record.objectId).toBe(initialManifest.androidEntryId);
      expect(JSON.parse(androidRecord.record.payloadJson)).toMatchObject({
        monica_entry_id: initialManifest.androidLogicalObjectId,
        username: "android-user",
        password_plain: "android-secret"
      });
      const androidAttachment = await findAttachment(
        firstClient,
        opened.vaultHandle,
        androidRecord.record.collectionId,
        androidRecord.record.objectId,
        initialManifest.androidAttachmentId
      );
      expect(androidAttachment.fileName).toBe(initialManifest.androidAttachmentName);
      const androidAttachmentContent = await readAttachment(firstClient, opened.vaultHandle, androidAttachment.attachmentId);
      expect(androidAttachmentContent.length).toBe(ANDROID_ATTACHMENT_SIZE);
      expect(sha256Hex(androidAttachmentContent)).toBe(initialManifest.androidAttachmentPlaintextSha256);
      expect(androidAttachmentContent).toEqual(androidAttachmentBytes());

      const browserWrite = await firstClient.upsertObject(opened.vaultHandle, randomUUID(), {
        logicalObjectId: BROWSER_LOGICAL_ID,
        collectionId: androidRecord.record.collectionId,
        objectTypeId: "login",
        title: "Browser WebDAV Login",
        payloadJson: JSON.stringify({
          kind: "password",
          monica_entry_id: BROWSER_LOGICAL_ID,
          website: "https://browser-interop.example",
          username: "browser-user",
          password_plain: "browser-secret"
        })
      });
      const browserAttachmentContent = browserAttachmentBytes();
      const upload = await firstClient.beginAttachmentUpload(opened.vaultHandle, {
        operationId: randomUUID(),
        attachmentId: BROWSER_ATTACHMENT_ID,
        collectionId: browserWrite.collectionId,
        objectId: browserWrite.objectId,
        fileName: BROWSER_ATTACHMENT_NAME,
        mediaType: "application/octet-stream",
        mode: "create",
        sizeBytes: browserAttachmentContent.length,
        sha256: sha256Hex(browserAttachmentContent)
      });
      let uploadOffset = upload.nextOffset;
      while (uploadOffset < browserAttachmentContent.length) {
        const chunk = browserAttachmentContent.slice(uploadOffset, Math.min(browserAttachmentContent.length, uploadOffset + upload.maxChunkBytes));
        uploadOffset = (await firstClient.sendAttachmentUploadChunk(upload.transferId, uploadOffset, chunk)).nextOffset;
      }
      const uploadedAttachment = await firstClient.finishAttachmentUpload(upload.transferId);
      expect(uploadedAttachment.attachment.attachmentId).toBe(BROWSER_ATTACHMENT_ID);
      expect(uploadedAttachment.attachment.storageMode).toBe("external-hash-ref");

      const browserToRemote = await firstCoordinator.synchronize(syncInput);
      expect(browserToRemote.uploadedSegments).toBeGreaterThan(0);
      expect(browserToRemote.uploadedBlobs).toBeGreaterThan(0);
      const browserSegments = server.filePaths()
        .map((path) => parseMdbx2RemoteSegmentPath(initialManifest.remotePath, path))
        .filter((descriptor): descriptor is Mdbx2RemoteSegmentDescriptor => Boolean(descriptor && descriptor.deviceId === registered.deviceId));
      expect(browserSegments.length).toBeGreaterThan(0);
      const initialBlobIds = new Set(initialManifest.blobs.map((blob) => blob.blobId));
      const browserBlobPaths = server.filePaths().filter((path) =>
        path.startsWith(`${mdbx2BlobsRoot(initialManifest.remotePath)}/`) && !initialBlobIds.has(basename(path))
      );
      expect(browserBlobPaths.length).toBeGreaterThan(0);

      const browserManifest = {
        format: FIXTURE_FORMAT,
        vaultId: initialManifest.vaultId,
        browserCollectionId: browserWrite.collectionId,
        browserObjectId: browserWrite.objectId,
        browserLogicalObjectId: BROWSER_LOGICAL_ID,
        browserAttachmentId: BROWSER_ATTACHMENT_ID,
        browserAttachmentName: BROWSER_ATTACHMENT_NAME,
        browserAttachmentPlaintextSha256: sha256Hex(browserAttachmentContent),
        segments: browserSegments
          .sort((left, right) => left.streamId.localeCompare(right.streamId) || left.sequence - right.sequence)
          .map((descriptor) => ({
            fileName: `segments/${basename(descriptor.path)}`,
            deviceId: descriptor.deviceId,
            generationId: descriptor.generationId,
            sequence: descriptor.sequence,
            digest: descriptor.digestHex,
            sizeBytes: server.file(descriptor.path).length
          })),
        blobs: browserBlobPaths.map((path) => ({ fileName: `blobs/${basename(path)}`, blobId: basename(path), sizeBytes: server.file(path).length }))
      };
      for (const descriptor of browserSegments) {
        await pushAndroidFixtureFile(environment, `browser-incoming/segments/${basename(descriptor.path)}`, server.file(descriptor.path));
      }
      for (const path of browserBlobPaths) {
        await pushAndroidFixtureFile(environment, `browser-incoming/blobs/${basename(path)}`, server.file(path));
      }
      await pushAndroidFixtureFile(environment, "browser-incoming/manifest.json", Buffer.from(JSON.stringify(browserManifest, null, 2), "utf8"));

      const persistedVaultHandle = opened.vaultHandle;
      const persistedStateHandle = registered.stateHandle;
      firstClient.close();
      firstClient = undefined;

      await runAndroidFixtureMethod(environment, "applyBrowserSegmentsAndExportAndroidReturn");
      const returnManifestPath = join(runRoot, "android-return", "manifest.json");
      const returnRemoteRoot = join(runRoot, "android-return", "remote");
      await pullAndroidFixtureFile(environment, "android-return/manifest.json", returnManifestPath);
      await pullAndroidFixtureTree(environment, "android-return/remote", returnRemoteRoot);
      const returnManifest = JSON.parse(await readFile(returnManifestPath, "utf8")) as AndroidReturnManifest;
      validateAndroidReturnManifest(returnManifest, initialManifest.vaultId);
      await server.loadDirectory(returnRemoteRoot);

      secondClient = new Mdbx2NativeClient(new ProcessNativeRuntime(hostExecutable, hostData));
      await secondClient.hello(30_000);
      const reopened = await secondClient.openVault(
        { kind: "vault", handle: persistedVaultHandle },
        { method: "password", password: PASSWORD }
      );
      expect(reopened.vaultId).toBe(initialManifest.vaultId);
      const secondCoordinator = new Mdbx2SyncCoordinator(secondClient);
      const resumedInput = { ...webDavConfig, vaultHandle: persistedVaultHandle, syncStateHandle: persistedStateHandle };
      const persistedStatus = await secondCoordinator.status(resumedInput);
      expect(persistedStatus).toMatchObject({ initialized: true, stateHandle: persistedStateHandle, vaultHandle: persistedVaultHandle });
      const androidReturnToBrowser = await secondCoordinator.synchronize(resumedInput);
      expect(androidReturnToBrowser.downloadedSegments).toBeGreaterThanOrEqual(returnManifest.segments.length);
      expect(androidReturnToBrowser.downloadedBlobs).toBeGreaterThanOrEqual(returnManifest.blobs.length);
      expect(androidReturnToBrowser.blockedStreams).toBe(0);

      const returnRecord = await findRecord(secondClient, persistedVaultHandle, returnManifest.androidReturnLogicalObjectId);
      expect(returnRecord.record.objectId).toBe(returnManifest.androidReturnEntryId);
      expect(JSON.parse(returnRecord.record.payloadJson)).toMatchObject({
        monica_entry_id: returnManifest.androidReturnLogicalObjectId,
        username: "android-return-user",
        password_plain: "android-return-secret"
      });
      const returnAttachment = await findAttachment(
        secondClient,
        persistedVaultHandle,
        returnRecord.record.collectionId,
        returnRecord.record.objectId,
        returnManifest.androidReturnAttachmentId
      );
      expect(returnAttachment.fileName).toBe(returnManifest.androidReturnAttachmentName);
      const returnContent = await readAttachment(secondClient, persistedVaultHandle, returnAttachment.attachmentId);
      expect(returnContent.length).toBe(ANDROID_RETURN_ATTACHMENT_SIZE);
      expect(sha256Hex(returnContent)).toBe(returnManifest.androidReturnAttachmentPlaintextSha256);
      expect(returnContent).toEqual(androidReturnAttachmentBytes());

      expect(server.file(initialManifest.remotePath)).toEqual(bootstrapBefore);
      expect(server.version(initialManifest.remotePath)).toBe(1);
      for (const [path, bytes] of protectedRemoteBytes) expect(server.file(path)).toEqual(bytes);
      const immutableWrites = server.requests.filter((request) => request.method === "PUT");
      expect(immutableWrites.length).toBeGreaterThan(0);
      expect(immutableWrites.every((request) => request.ifNoneMatch === "*" && request.path !== initialManifest.remotePath)).toBe(true);
      const remoteNames = server.filePaths().join("\n").toLocaleLowerCase("en-US");
      for (const forbidden of [
        "android webdav login",
        "browser webdav login",
        "android-fixture.bin",
        "browser-fixture.bin",
        "android-return.bin",
        "android-interop.example",
        "browser-interop.example"
      ]) expect(remoteNames).not.toContain(forbidden);

      const evidence = {
        androidDeviceId: initialManifest.deviceId,
        browserDeviceId: registered.deviceId,
        androidSegments: initialManifest.segments.length + returnManifest.segments.length,
        browserSegments: browserSegments.length,
        androidBlobs: initialManifest.blobs.length + returnManifest.blobs.length,
        browserBlobs: browserBlobPaths.length,
        remoteObjectCount: server.filePaths().length,
        bootstrapSha256: sha256Hex(bootstrapBefore)
      };
      await writeFile(join(runRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
      process.stdout.write(`MDBX2_ANDROID_BROWSER_INTEROP ${JSON.stringify(evidence)}\n`);
    } finally {
      firstClient?.close();
      secondClient?.close();
      await server.close().catch(() => undefined);
      if (androidEnvironment) await stopAndroidEnvironment(androidEnvironment);
      if (process.env.MONICA_MDBX2_INTEROP_KEEP !== "1") await rm(runRoot, { recursive: true, force: true });
    }
  });
});

function validateAndroidExportManifest(manifest: AndroidExportManifest): void {
  expect(manifest.format).toBe(FIXTURE_FORMAT);
  expect(manifest.remotePath).toBe("vaults/main.mdbx");
  expect(manifest.vaultId).toBeTruthy();
  expect(manifest.deviceId).toMatch(/^[a-f0-9-]{36}$/);
  expect(manifest.segments.length).toBeGreaterThan(0);
  expect(manifest.blobs.length).toBeGreaterThan(0);
  for (const segment of manifest.segments) {
    const parsed = parseMdbx2RemoteSegmentPath(manifest.remotePath, segment.path);
    expect(parsed).toMatchObject({
      deviceId: segment.deviceId,
      generationId: segment.generationId,
      sequence: segment.sequence,
      digestHex: segment.digest
    });
  }
  for (const blob of manifest.blobs) {
    expect(blob.path).toBe(`${mdbx2BlobsRoot(manifest.remotePath)}/${blob.blobId.slice(0, 2)}/${blob.blobId.slice(2, 4)}/${blob.blobId}`);
  }
}

function validateAndroidReturnManifest(manifest: AndroidReturnManifest, vaultId: string): void {
  expect(manifest.format).toBe(FIXTURE_FORMAT);
  expect(manifest.vaultId).toBe(vaultId);
  expect(manifest.segments.length).toBeGreaterThan(0);
  expect(manifest.blobs.length).toBeGreaterThan(0);
  expect(manifest.androidReturnAttachmentPlaintextSha256).toBe(sha256Hex(androidReturnAttachmentBytes()));
}

async function findRecord(client: Mdbx2NativeClient, vaultHandle: string, logicalObjectId: string): Promise<{ record: Mdbx2ObjectRecord }> {
  let collectionCursor: string | undefined;
  do {
    const collections = await client.listCollections(vaultHandle, { pageSize: 50, cursor: collectionCursor });
    for (const collection of collections.items) {
      let objectCursor: string | undefined;
      do {
        const objects = await client.listObjects(vaultHandle, collection.collectionId, { pageSize: 50, cursor: objectCursor });
        for (const summary of objects.items) {
          const record = await client.revealObject(vaultHandle, summary.objectId);
          const payload = JSON.parse(record.payloadJson) as Record<string, unknown>;
          if (payload.monica_entry_id === logicalObjectId) return { record };
        }
        objectCursor = objects.nextCursor;
      } while (objectCursor);
    }
    collectionCursor = collections.nextCursor;
  } while (collectionCursor);
  throw new Error(`MDBX2 object was not found: ${logicalObjectId}`);
}

async function findAttachment(
  client: Mdbx2NativeClient,
  vaultHandle: string,
  collectionId: string,
  objectId: string,
  attachmentId: string
): Promise<Mdbx2AttachmentSummary> {
  let cursor: string | undefined;
  do {
    const page = await client.listAttachments(vaultHandle, collectionId, objectId, { pageSize: 50, cursor });
    const found = page.items.find((item) => item.attachmentId === attachmentId);
    if (found) return found;
    cursor = page.nextCursor;
  } while (cursor);
  throw new Error(`MDBX2 attachment was not found: ${attachmentId}`);
}

async function readAttachment(client: Mdbx2NativeClient, vaultHandle: string, attachmentId: string): Promise<Uint8Array> {
  const begun = await client.beginAttachmentRead(vaultHandle, attachmentId);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  try {
    while (offset < begun.sizeBytes) {
      const chunk = await client.readAttachmentChunk(begun.readHandle, offset, MDBX2_MAX_BINARY_CHUNK_BYTES);
      const bytes = base64ToBytes(chunk.dataBase64);
      chunks.push(bytes);
      offset = chunk.nextOffset;
      expect(chunk.eof).toBe(offset === begun.sizeBytes);
    }
  } finally {
    await client.releaseAttachmentRead(begun.readHandle).catch(() => undefined);
  }
  const output = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  return output;
}

function androidAttachmentBytes(): Uint8Array {
  return generatedBytes(ANDROID_ATTACHMENT_SIZE, 13, 7);
}

function browserAttachmentBytes(): Uint8Array {
  return generatedBytes(BROWSER_ATTACHMENT_SIZE, 17, 3);
}

function androidReturnAttachmentBytes(): Uint8Array {
  return generatedBytes(ANDROID_RETURN_ATTACHMENT_SIZE, 19, 11);
}

function generatedBytes(length: number, multiplier: number, offset: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * multiplier + offset) % 251);
}
