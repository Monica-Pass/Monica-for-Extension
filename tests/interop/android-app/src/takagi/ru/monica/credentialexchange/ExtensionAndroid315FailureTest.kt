package takagi.ru.monica.credentialexchange

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import takagi.ru.monica.data.PasswordDatabase
import takagi.ru.monica.transfer.TransferPhase
import takagi.ru.monica.transfer.TransferProgressReporter
import takagi.ru.monica.utils.WebDavHelper
import uniffi.mdbx_ffi.openVault

/** Failure-only decode/preflight tests. Never apply a restore to any user database. */
@RunWith(AndroidJUnit4::class)
class ExtensionAndroid315FailureTest {
    @Test fun rejectedInputsAndCancelledPreviewKeepExistingData(): Unit = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val output = File(context.filesDir, "extension-interop-315")
        val archive = File(output, "android.zip")
        val native = File(output, "android.mdbx")
        require(archive.isFile && native.isFile)
        val database = PasswordDatabase.getDatabase(context)
        suspend fun snapshot(): String {
            val passwords = database.passwordEntryDao().getAllPasswordEntriesSync().sortedBy { it.id }
            val vaults = database.localMdbxDatabaseDao().getAllDatabasesSnapshot().sortedBy { it.id }
            return sha((passwords.toString() + vaults.toString()).toByteArray())
        }
        val before = snapshot()
        val archiveBefore = sha(archive.readBytes())
        val nativeBefore = sha(native.readBytes())
        val checks = JSONArray()
        // SQLite opening may initialize journal metadata: compare logical objects,
        // and run the probe on an isolated copy so the source backup stays untouched.
        val probe = File(output, "wrong-password-probe-${System.nanoTime()}.mdbx")
        native.copyTo(probe)
        fun objects(): String = openVault(probe.absolutePath, "Synthetic transfer fixture password", "failure-snapshot-315").use { vault ->
            val entries = mutableListOf<uniffi.mdbx_ffi.EntryRecord>()
            var cursor: String? = null
            do {
                val page = vault.listCollectionSummaries(100u, cursor)
                page.items.filterNot { it.deleted }.forEach { entries += vault.listEntries(it.collectionId, null) }
                cursor = page.nextCursor
            } while (cursor != null)
            sha(entries.sortedBy { it.entryId }.toString().toByteArray())
        }
        val objectsBefore = objects()
        val wrongNative = runCatching { openVault(probe.absolutePath, "incorrect synthetic password", "failure-315").use { it.info() } }
        assertTrue("Wrong MDBX password must reject", wrongNative.isFailure)
        assertEquals("Wrong password must preserve objects/IDs/revisions", objectsBefore, objects())
        probe.delete()
        checks.put(JSONObject().put("case", "wrong-mdbx-password").put("status", "passed"))
        val helper = WebDavHelper(context)
        val wrongArchive = helper.restoreFromBackupFile(archive, "incorrect synthetic password", restoreMonicaConfig = false, importDataOnly = true)
        assertTrue("Wrong encrypted ZIP password must reject", wrongArchive.isFailure)
        checks.put(JSONObject().put("case", "wrong-archive-password").put("status", "passed"))
        val damaged = File(output, "synthetic-truncated.zip")
        try {
            damaged.writeBytes(archive.readBytes().copyOf(64))
            val result = helper.restoreFromBackupFile(damaged, "synthetic archive password", restoreMonicaConfig = false, importDataOnly = true)
            assertTrue("Truncated archive must reject", result.isFailure)
            checks.put(JSONObject().put("case", "truncated-archive").put("status", "passed"))
        } finally { damaged.delete() }
        var reachedReading = false
        val cancellation = runCatching {
            helper.restoreFromBackupFile(archive, "synthetic archive password", restoreMonicaConfig = false, importDataOnly = true,
                progress = TransferProgressReporter {
                    if (it.phase == TransferPhase.READING) {
                        reachedReading = true
                        throw CancellationException("Synthetic cancellation before restore apply")
                    }
                }).getOrThrow()
        }
        assertTrue("Cancellation must occur after decryption reaches archive reading", reachedReading)
        assertTrue("Cancellation must propagate", cancellation.exceptionOrNull() is CancellationException)
        checks.put(JSONObject().put("case", "cancel-after-decryption-before-apply").put("status", "passed"))
        assertEquals(before, snapshot())
        assertEquals(archiveBefore, sha(archive.readBytes()))
        assertEquals(nativeBefore, sha(native.readBytes()))
        File(output, "android-failure-readback.json").writeText(JSONObject().put("checks", checks)
            .put("existingPasswordAndVaultRowsUnchanged", true).put("archiveBytesUnchanged", true).put("nativeBytesUnchanged", true)
            .put("wrongPasswordNativeObjectsUnchanged", true)
            .put("scope", "Android application decode/preflight only; cancellation during committed restore not tested").toString(2))
    }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
