package takagi.ru.monica.mdbx.engine

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import uniffi.mdbx_ffi.MdbxAttachmentCreateRequest
import uniffi.mdbx_ffi.MdbxExternalBlobState
import uniffi.mdbx_ffi.MdbxIncrementalSyncCheckpoint
import uniffi.mdbx_ffi.MdbxIncrementalSyncResume
import uniffi.mdbx_ffi.MdbxVault
import uniffi.mdbx_ffi.MdbxWriteCommand
import uniffi.mdbx_ffi.createVault
import uniffi.mdbx_ffi.defaultAttachmentContentLimits
import uniffi.mdbx_ffi.openVault

@RunWith(AndroidJUnit4::class)
class Mdbx2ExtensionInteropTest {

    @Test
    fun exportAndroidBootstrapSegmentsAndBlob() {
        val root = fixtureRoot().also {
            it.deleteRecursively()
            assertTrue(it.mkdirs())
        }
        val remoteRoot = File(root, "remote")
        val bootstrap = File(remoteRoot, REMOTE_VAULT_PATH).also { it.parentFile?.mkdirs() }
        val workingVault = File(root, WORKING_VAULT_FILE)

        createVault(workingVault.absolutePath, PASSWORD, ANDROID_DEVICE_ID).use { vault ->
            val info = vault.info()
            val bootstrapInfo = vault.createIncrementalSyncBootstrap(bootstrap.absolutePath)
            assertEquals(info.vaultId, bootstrapInfo.backup.vaultId)
            assertTrue(bootstrap.isFile && bootstrap.length() > 0L)

            val projectId = nameUuid("android-interop-project:${info.vaultId}")
            val entryId = nameUuid("monica-entry:${info.vaultId}:$ANDROID_LOGICAL_ID")
            vault.executeWriteOperation(
                operationId = UUID.randomUUID().toString(),
                operationKind = "android-extension-interop-create",
                commands = listOf(
                    MdbxWriteCommand.CreateProject(projectId, "Android Interop"),
                    MdbxWriteCommand.CreateEntry(
                        entryId = entryId,
                        projectId = projectId,
                        entryType = "login",
                        title = "Android WebDAV Login",
                        payloadJson = JSONObject()
                            .put("kind", "password")
                            .put("monica_entry_id", ANDROID_LOGICAL_ID)
                            .put("website", "https://android-interop.example")
                            .put("username", "android-user")
                            .put("password_plain", "android-secret")
                            .toString()
                    )
                )
            )
            vault.createAttachmentWithExternalContent(
                operationId = UUID.randomUUID().toString(),
                request = MdbxAttachmentCreateRequest(
                    attachmentId = ANDROID_ATTACHMENT_ID,
                    projectId = projectId,
                    entryId = entryId,
                    fileName = ANDROID_ATTACHMENT_NAME,
                    mediaType = "application/octet-stream"
                ),
                content = androidAttachmentBytes(),
                limits = defaultAttachmentContentLimits()
            )

            val exported = exportSegments(vault, bootstrapInfo.checkpoint, remoteRoot)
            val blobs = exportAvailableBlobs(vault, remoteRoot, emptySet())
            assertTrue(exported.segments.length() > 0)
            assertTrue(blobs.length() > 0)

            val manifest = JSONObject()
                .put("format", FIXTURE_FORMAT)
                .put("remotePath", REMOTE_VAULT_PATH)
                .put("vaultId", info.vaultId)
                .put("deviceId", info.deviceId)
                .put("androidProjectId", projectId)
                .put("androidEntryId", entryId)
                .put("androidLogicalObjectId", ANDROID_LOGICAL_ID)
                .put("androidAttachmentId", ANDROID_ATTACHMENT_ID)
                .put("androidAttachmentName", ANDROID_ATTACHMENT_NAME)
                .put("androidAttachmentPlaintextSha256", sha256Hex(androidAttachmentBytes()))
                .put("bootstrapCheckpoint", checkpointJson(bootstrapInfo.checkpoint))
                .put("resultCheckpoint", checkpointJson(exported.resultCheckpoint))
                .put("segments", exported.segments)
                .put("blobs", blobs)
            File(root, "manifest.json").writeText(manifest.toString(2))
        }

        assertTrue(workingVault.isFile)
    }

    @Test
    fun applyBrowserSegmentsAndExportAndroidReturn() {
        val root = fixtureRoot()
        val workingVault = File(root, WORKING_VAULT_FILE)
        val incomingRoot = File(root, "browser-incoming")
        val incomingManifestFile = File(incomingRoot, "manifest.json")
        assertTrue(workingVault.isFile)
        assertTrue(incomingManifestFile.isFile)
        val incomingManifest = JSONObject(incomingManifestFile.readText())
        assertEquals(FIXTURE_FORMAT, incomingManifest.getString("format"))

        openVault(workingVault.absolutePath, PASSWORD, ANDROID_DEVICE_ID).use { vault ->
            val info = vault.info()
            assertEquals(incomingManifest.getString("vaultId"), info.vaultId)
            applyIncomingSegments(vault, incomingRoot, incomingManifest.getJSONArray("segments"))
            installMissingBlobs(vault, File(incomingRoot, "blobs"))

            val browserCollectionId = incomingManifest.getString("browserCollectionId")
            val browserObjectId = incomingManifest.getString("browserObjectId")
            val browserLogicalId = incomingManifest.getString("browserLogicalObjectId")
            val browserEntry = vault.listEntries(browserCollectionId, "login")
                .firstOrNull { it.entryId == browserObjectId }
            assertNotNull(browserEntry)
            assertEquals(
                browserLogicalId,
                JSONObject(browserEntry!!.payloadJson).getString("monica_entry_id")
            )
            val browserAttachmentId = incomingManifest.getString("browserAttachmentId")
            val browserAttachment = vault.getAttachment(browserAttachmentId)
            assertNotNull(browserAttachment)
            assertFalse(browserAttachment!!.deleted)
            assertEquals(browserObjectId, browserAttachment.entryId)
            assertArrayEquals(
                browserAttachmentBytes(),
                vault.readAttachmentContent(browserAttachmentId, MAX_PLAINTEXT_BYTES)
            )

            val knownBlobIds = availableBlobIds(vault)
            val returnBase = vault.incrementalSyncCheckpoint()
            val returnEntryId = nameUuid("monica-entry:${info.vaultId}:$ANDROID_RETURN_LOGICAL_ID")
            vault.executeWriteOperation(
                operationId = UUID.randomUUID().toString(),
                operationKind = "android-extension-interop-return",
                commands = listOf(
                    MdbxWriteCommand.CreateEntry(
                        entryId = returnEntryId,
                        projectId = browserCollectionId,
                        entryType = "login",
                        title = "Android Return Login",
                        payloadJson = JSONObject()
                            .put("kind", "password")
                            .put("monica_entry_id", ANDROID_RETURN_LOGICAL_ID)
                            .put("website", "https://android-return.example")
                            .put("username", "android-return-user")
                            .put("password_plain", "android-return-secret")
                            .toString()
                    )
                )
            )
            vault.createAttachmentWithExternalContent(
                operationId = UUID.randomUUID().toString(),
                request = MdbxAttachmentCreateRequest(
                    attachmentId = ANDROID_RETURN_ATTACHMENT_ID,
                    projectId = browserCollectionId,
                    entryId = returnEntryId,
                    fileName = ANDROID_RETURN_ATTACHMENT_NAME,
                    mediaType = "application/octet-stream"
                ),
                content = androidReturnAttachmentBytes(),
                limits = defaultAttachmentContentLimits()
            )

            val returnRoot = File(root, "android-return").also {
                it.deleteRecursively()
                assertTrue(it.mkdirs())
            }
            val returnRemote = File(returnRoot, "remote")
            val exported = exportSegments(vault, returnBase, returnRemote)
            val blobs = exportAvailableBlobs(vault, returnRemote, knownBlobIds)
            assertTrue(exported.segments.length() > 0)
            assertTrue(blobs.length() > 0)
            val returnManifest = JSONObject()
                .put("format", FIXTURE_FORMAT)
                .put("vaultId", info.vaultId)
                .put("deviceId", info.deviceId)
                .put("androidReturnEntryId", returnEntryId)
                .put("androidReturnLogicalObjectId", ANDROID_RETURN_LOGICAL_ID)
                .put("androidReturnAttachmentId", ANDROID_RETURN_ATTACHMENT_ID)
                .put("androidReturnAttachmentName", ANDROID_RETURN_ATTACHMENT_NAME)
                .put("androidReturnAttachmentPlaintextSha256", sha256Hex(androidReturnAttachmentBytes()))
                .put("baseCheckpoint", checkpointJson(returnBase))
                .put("resultCheckpoint", checkpointJson(exported.resultCheckpoint))
                .put("segments", exported.segments)
                .put("blobs", blobs)
            File(returnRoot, "manifest.json").writeText(returnManifest.toString(2))
        }
    }

    private fun applyIncomingSegments(vault: MdbxVault, root: File, descriptors: JSONArray) {
        val streams = linkedMapOf<String, Pair<MdbxIncrementalSyncCheckpoint, MdbxIncrementalSyncResume?>>()
        val ordered = (0 until descriptors.length())
            .map(descriptors::getJSONObject)
            .sortedWith(compareBy<JSONObject>({ it.getString("deviceId") }, { it.getString("generationId") }, { it.getLong("sequence") }))
        ordered.forEach { descriptor ->
            val source = File(root, descriptor.getString("fileName"))
            assertTrue(source.isFile)
            val inspected = vault.inspectIncrementalSyncSegment(source.absolutePath)
            assertEquals(descriptor.getString("deviceId"), inspected.sourceDeviceId)
            assertEquals(descriptor.getString("generationId"), inspected.transferId)
            assertEquals(descriptor.getLong("sequence").toUInt(), inspected.segmentIndex)
            assertEquals(descriptor.getString("digest"), inspected.payloadSha256.toHex())
            val streamId = "${inspected.sourceDeviceId}/${inspected.transferId}"
            val state = streams[streamId]
            val applied = vault.applyIncrementalSyncSegment(
                source = source.absolutePath,
                expectedBase = state?.first ?: inspected.base,
                expectedResume = state?.second
            )
            assertEquals(0u, applied.missingParentCount)
            streams[streamId] = applied.result to applied.nextResume
        }
    }

    private fun installMissingBlobs(vault: MdbxVault, blobDirectory: File) {
        var cursor: String? = null
        do {
            val page = vault.listExternalBlobReferences(cursor, BLOB_PAGE_SIZE)
            page.items.forEach { reference ->
                val source = File(blobDirectory, reference.blobId)
                val totalSize = reference.totalSize ?: source.length().toULong()
                if (reference.state == MdbxExternalBlobState.AVAILABLE && vault.hasExternalBlob(reference.blobId, totalSize)) {
                    return@forEach
                }
                assertTrue("Missing browser Blob ${reference.blobId}", source.isFile)
                assertEquals(totalSize.toLong(), source.length())
                assertEquals(reference.blobId, sha256Hex(source.readBytes()))
                val ownerId = "android-extension-interop-${UUID.randomUUID()}"
                vault.acquireExternalBlobLease(reference.blobId, ownerId, System.currentTimeMillis() / 1000L, 300L)
                try {
                    var offset = 0L
                    source.inputStream().buffered().use { input ->
                        while (offset < source.length()) {
                            val count = minOf(BLOB_CHUNK_BYTES, (source.length() - offset).toInt())
                            val bytes = ByteArray(count)
                            var read = 0
                            while (read < count) {
                                val current = input.read(bytes, read, count - read)
                                check(current > 0) { "Unexpected EOF in browser Blob" }
                                read += current
                            }
                            val nextOffset = offset + count
                            vault.writeExternalBlobChunk(
                                blobId = reference.blobId,
                                totalSize = totalSize,
                                offset = offset.toULong(),
                                ciphertext = bytes,
                                finalize = nextOffset == source.length()
                            )
                            offset = nextOffset
                        }
                    }
                } finally {
                    vault.releaseExternalBlobLease(reference.blobId, ownerId)
                }
                assertTrue(vault.hasExternalBlob(reference.blobId, totalSize))
            }
            cursor = page.nextCursor
        } while (cursor != null)
    }

    private fun exportSegments(
        vault: MdbxVault,
        initialBase: MdbxIncrementalSyncCheckpoint,
        remoteRoot: File
    ): ExportedSegments {
        val segments = JSONArray()
        var base = initialBase
        repeat(MAX_SEGMENTS) {
            val temporary = File(fixtureRoot(), "android-interop-segment-${UUID.randomUUID()}.mdbxsync")
            check(!temporary.exists()) { "MDBX2 segment destination must not exist" }
            val info = vault.exportIncrementalSyncSegment(
                destination = temporary.absolutePath,
                base = base,
                resume = null,
                pageSize = SEGMENT_PAGE_SIZE
            )
            val digest = info.payloadSha256.toHex()
            val relativePath = segmentPath(
                info.sourceDeviceId,
                info.transferId,
                info.segmentIndex,
                digest
            )
            val destination = File(remoteRoot, relativePath).also { it.parentFile?.mkdirs() }
            temporary.copyTo(destination, overwrite = false)
            temporary.delete()
            assertEquals(info.fileSizeBytes.toLong(), destination.length())
            segments.put(
                JSONObject()
                    .put("path", relativePath.replace(File.separatorChar, '/'))
                    .put("deviceId", info.sourceDeviceId)
                    .put("generationId", info.transferId)
                    .put("sequence", info.segmentIndex.toLong())
                    .put("digest", digest)
                    .put("sizeBytes", info.fileSizeBytes.toLong())
            )
            base = info.result
            if (info.isLast) return ExportedSegments(segments, base)
        }
        throw IllegalStateException("MDBX2 Android fixture exceeded $MAX_SEGMENTS segments")
    }

    private fun exportAvailableBlobs(vault: MdbxVault, remoteRoot: File, excluded: Set<String>): JSONArray {
        val blobs = JSONArray()
        var cursor: String? = null
        do {
            val page = vault.listExternalBlobReferences(cursor, BLOB_PAGE_SIZE)
            page.items.forEach { reference ->
                if (reference.blobId in excluded) return@forEach
                val totalSize = reference.totalSize
                    ?: throw IllegalStateException("MDBX2 Blob ${reference.blobId} has no size")
                assertEquals(MdbxExternalBlobState.AVAILABLE, reference.state)
                val relativePath = blobPath(reference.blobId)
                val destination = File(remoteRoot, relativePath).also { it.parentFile?.mkdirs() }
                destination.outputStream().buffered().use { output ->
                    var offset = 0uL
                    while (offset < totalSize) {
                        val chunk = vault.readExternalBlobChunk(
                            blobId = reference.blobId,
                            totalSize = totalSize,
                            offset = offset,
                            maxBytes = BLOB_CHUNK_BYTES.toUInt()
                        )
                        assertEquals(offset, chunk.offset)
                        assertTrue(chunk.ciphertext.isNotEmpty())
                        output.write(chunk.ciphertext)
                        offset += chunk.ciphertext.size.toULong()
                        assertEquals(offset == totalSize, chunk.isLast)
                    }
                }
                assertEquals(totalSize.toLong(), destination.length())
                assertEquals(reference.blobId, sha256Hex(destination.readBytes()))
                blobs.put(
                    JSONObject()
                        .put("path", relativePath.replace(File.separatorChar, '/'))
                        .put("blobId", reference.blobId)
                        .put("sizeBytes", totalSize.toLong())
                )
            }
            cursor = page.nextCursor
        } while (cursor != null)
        return blobs
    }

    private fun availableBlobIds(vault: MdbxVault): Set<String> {
        val ids = linkedSetOf<String>()
        var cursor: String? = null
        do {
            val page = vault.listExternalBlobReferences(cursor, BLOB_PAGE_SIZE)
            page.items.filter { it.state == MdbxExternalBlobState.AVAILABLE }.forEach { ids += it.blobId }
            cursor = page.nextCursor
        } while (cursor != null)
        return ids
    }

    private fun checkpointJson(checkpoint: MdbxIncrementalSyncCheckpoint): JSONObject = JSONObject()
        .put("commitInventory", checkpoint.commitInventory)
        .put("deltaInventory", checkpoint.deltaInventory)

    private fun fixtureRoot(): File {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        return File(context.filesDir, FIXTURE_ROOT)
    }

    private fun segmentPath(deviceId: String, generationId: String, sequence: UInt, digest: String): String =
        "$REMOTE_VAULT_PATH.sync/streams/$deviceId/$generationId/segments/" +
            "${sequence.toString().padStart(10, '0')}-$digest.mdbxsync"

    private fun blobPath(blobId: String): String =
        "$REMOTE_VAULT_PATH.sync/blobs/${blobId.substring(0, 2)}/${blobId.substring(2, 4)}/$blobId"

    private fun nameUuid(value: String): String = UUID.nameUUIDFromBytes(value.toByteArray(Charsets.UTF_8)).toString()

    private fun ByteArray.toHex(): String = joinToString("") {
        "%02x".format(Locale.ROOT, it.toInt() and 0xff)
    }

    private fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes)
        .toHex()

    private fun androidAttachmentBytes(): ByteArray = ByteArray(ANDROID_ATTACHMENT_BYTES) { index ->
        ((index * 13 + 7) % 251).toByte()
    }

    private fun browserAttachmentBytes(): ByteArray = ByteArray(BROWSER_ATTACHMENT_BYTES) { index ->
        ((index * 17 + 3) % 251).toByte()
    }

    private fun androidReturnAttachmentBytes(): ByteArray = ByteArray(ANDROID_RETURN_ATTACHMENT_BYTES) { index ->
        ((index * 19 + 11) % 251).toByte()
    }

    private data class ExportedSegments(
        val segments: JSONArray,
        val resultCheckpoint: MdbxIncrementalSyncCheckpoint
    )

    private companion object {
        const val FIXTURE_FORMAT = "monica-mdbx2-android-interop-v1"
        const val FIXTURE_ROOT = "mdbx2-extension-interop"
        const val WORKING_VAULT_FILE = "android-working.mdbx"
        const val REMOTE_VAULT_PATH = "vaults/main.mdbx"
        const val PASSWORD = "mdbx2-android-extension-interop-password"
        const val ANDROID_DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        const val ANDROID_LOGICAL_ID = "password:android-interop"
        const val ANDROID_ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111"
        const val ANDROID_ATTACHMENT_NAME = "android-fixture.bin"
        const val ANDROID_RETURN_LOGICAL_ID = "password:android-return"
        const val ANDROID_RETURN_ATTACHMENT_ID = "22222222-2222-4222-8222-222222222222"
        const val ANDROID_RETURN_ATTACHMENT_NAME = "android-return.bin"
        const val ANDROID_ATTACHMENT_BYTES = 700_000
        const val BROWSER_ATTACHMENT_BYTES = 710_000
        const val ANDROID_RETURN_ATTACHMENT_BYTES = 720_000
        const val BLOB_CHUNK_BYTES = 256 * 1024
        const val MAX_SEGMENTS = 32
        const val SEGMENT_PAGE_SIZE = 256u
        const val BLOB_PAGE_SIZE = 100u
        const val MAX_PLAINTEXT_BYTES = 2_000_000uL
    }
}
