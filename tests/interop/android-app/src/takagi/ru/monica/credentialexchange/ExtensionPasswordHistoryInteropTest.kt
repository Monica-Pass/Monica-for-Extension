package takagi.ru.monica.credentialexchange

import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import takagi.ru.monica.data.BackupPreferences
import takagi.ru.monica.data.PasswordEntry
import takagi.ru.monica.repository.PasswordRepository
import takagi.ru.monica.utils.AppLocaleStringResolver
import takagi.ru.monica.utils.WebDavHelper
import takagi.ru.monica.utils.SettingsManager
import takagi.ru.monica.viewmodel.CategoryFilter
import takagi.ru.monica.viewmodel.PasswordViewModel

/** Actual ZIP restore / Room history / password update / ZIP export. Not native file-history transport. */
@RunWith(AndroidJUnit4::class)
class ExtensionPasswordHistoryInteropTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val output get() = File(context.filesDir, "extension-interop-315").apply { mkdirs() }

    @Test fun restoreEditAndExportHistory(): Unit = runBlocking {
        val input = File(output, "extension-history.zip")
        assertTrue("A verified Edge/server-derived archive is required", input.isFile)
        val content = WebDavHelper(context).restoreFromBackupFile(input, "synthetic archive password",
            restoreMonicaConfig = false, importDataOnly = true).getOrThrow().content
        assertEquals(2, content.passwords.size)
        assertTrue(content.passwordHistory.isNotEmpty())
        val settings = SettingsManager(context)
        val originalSettings = settings.settingsFlow.first()
        val report = JSONObject().put("status", "failed").put("layer", "actual Android targeted ZIP restore -> history DAO -> ViewModel update -> ZIP export")
        val destinations = JSONArray(); report.put("destinations", destinations)
        try {
            for (kind in listOf("mdbx", "keepass")) {
                val fixture = TransferFixture()
                val repository = PasswordRepository(fixture.db.passwordEntryDao(), passwordHistoryDao = fixture.db.passwordHistoryDao(), mdbxRepository = fixture.mdbx)
                val model = PasswordViewModel(repository, fixture.security, context = fixture.context,
                    localKeePassDatabaseDao = fixture.db.localKeePassDatabaseDao(), strings = AppLocaleStringResolver(context))
                try {
                    val target = if (kind == "mdbx") fixture.mdbx() else fixture.keepass()
                    val imported = fixture.importer.apply(content, target)
                    assertEquals(0, imported.failed); assertEquals(2, imported.imported)
                    fun inTarget(entry: PasswordEntry) = if (kind == "mdbx") entry.mdbxDatabaseId == target.databaseId else entry.keepassDatabaseId == target.databaseId
                    val rows = fixture.db.passwordEntryDao().getAllPasswordEntriesSync().filter(::inTarget)
                    assertEquals(2, rows.size)
                    assertTrue("Imported owners must be unambiguous", rows.none { it.hasOwnershipConflict() })
                    val proof = JSONObject().put("kind", kind).put("status", "failed")
                    val owners = JSONArray(); proof.put("owners", owners); destinations.put(proof)
                    for (source in content.passwords) {
                        val actual = rows.single { it.title == source.title }
                        val expected = content.passwordHistory.filter { it.entryId == source.id }.sortedByDescending { it.lastUsedAt }
                        val history = fixture.db.passwordHistoryDao().getHistoryByEntryIdSync(actual.id)
                        assertNotEquals("New destination must map backup IDs", source.id, actual.id)
                        assertEquals(expected.map { it.password to it.lastUsedAt }, history.map { fixture.security.decryptDataIfMonicaCiphertext(it.password) to it.lastUsedAt.time })
                        owners.put(JSONObject().put("title", actual.title).put("backupId", source.id).put("roomId", actual.id).put("historyCount", history.size))
                    }
                    val edited = rows.single { it.title == "Native history" }
                    val other = rows.single { it.id != edited.id }
                    // The public AVD remembers its previous visible vault. Match the actual
                    // destination screen before calling its UI save method, then restore it.
                    withContext(Dispatchers.Main) {
                        model.setCategoryFilter(if (kind == "mdbx") CategoryFilter.MdbxDatabase(requireNotNull(target.databaseId))
                            else CategoryFilter.KeePassDatabase(requireNotNull(target.databaseId)))
                    }
                    withTimeout(10_000) { settings.settingsFlow.first {
                        it.lastPasswordCategoryFilterType == (if (kind == "mdbx") "mdbx_database" else "keepass_database") &&
                            it.lastPasswordCategoryFilterPrimaryId == target.databaseId
                    } }
                    val previous = fixture.security.decryptDataIfMonicaCiphertext(edited.password)
                    val oldHistory = fixture.db.passwordHistoryDao().getHistoryByEntryIdSync(edited.id)
                    val untouchedHistory = fixture.db.passwordHistoryDao().getHistoryByEntryIdSync(other.id)
                    model.updatePasswordEntry(edited.copy(password = "Android history update $kind"))
                    val updated = withTimeout(45_000) {
                        fixture.db.passwordHistoryDao().getHistoryByEntryId(edited.id).first { it.size == oldHistory.size + 1 }
                    }
                    assertEquals(previous, fixture.security.decryptDataIfMonicaCiphertext(updated.first().password))
                    assertEquals(oldHistory, updated.drop(1))
                    assertEquals(untouchedHistory, fixture.db.passwordHistoryDao().getHistoryByEntryIdSync(other.id))
                    val stored = requireNotNull(repository.getPasswordEntryById(edited.id))
                    assertEquals("Android history update $kind", fixture.security.decryptDataIfMonicaCiphertext(stored.password))
                    val archive = fixture.model.prepareZipBackup(backupEncryptionPassword = "synthetic archive password",
                        source = target, preferences = BackupPreferences(includeImages = false)).getOrThrow().first
                    try { archive.copyTo(File(output, "android-history-$kind-return.zip"), overwrite = true) } finally { archive.delete() }
                    proof.put("status", "passed").put("newHistoryTimestamp", updated.first().lastUsedAt.time)
                        .put("changedTitle", edited.title).put("unchangedTitle", other.title)
                } finally { model.viewModelScope.coroutineContext[Job]?.cancelAndJoin(); fixture.close() }
            }
            report.put("status", "passed")
        } finally {
            settings.updateLastPasswordCategoryFilter(originalSettings.lastPasswordCategoryFilterType,
                originalSettings.lastPasswordCategoryFilterPrimaryId, originalSettings.lastPasswordCategoryFilterSecondaryId,
                originalSettings.lastPasswordCategoryFilterText, originalSettings.lastPasswordCategoryFilterGroupUuid)
            val restored = settings.settingsFlow.first()
            assertEquals(originalSettings.lastPasswordCategoryFilterType, restored.lastPasswordCategoryFilterType)
            assertEquals(originalSettings.lastPasswordCategoryFilterPrimaryId, restored.lastPasswordCategoryFilterPrimaryId)
            assertEquals(originalSettings.lastPasswordCategoryFilterSecondaryId, restored.lastPasswordCategoryFilterSecondaryId)
            assertEquals(originalSettings.lastPasswordCategoryFilterText, restored.lastPasswordCategoryFilterText)
            assertEquals(originalSettings.lastPasswordCategoryFilterGroupUuid, restored.lastPasswordCategoryFilterGroupUuid)
            report.put("originalFilterRestored", true)
            File(output, "android-history-return.json").writeText(report.toString(2))
        }
    }
}
