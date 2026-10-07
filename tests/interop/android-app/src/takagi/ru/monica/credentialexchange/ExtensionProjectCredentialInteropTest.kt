package takagi.ru.monica.credentialexchange

import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import takagi.ru.monica.data.*
import takagi.ru.monica.data.model.*
import takagi.ru.monica.repository.*
import takagi.ru.monica.utils.AppLocaleStringResolver
import takagi.ru.monica.utils.WebDavHelper
import takagi.ru.monica.viewmodel.MdbxViewModel
import takagi.ru.monica.viewmodel.PasswordViewModel

/** Real Android credential-group writer/restore/edit; synthetic isolated vaults only. */
@RunWith(AndroidJUnit4::class)
class ExtensionProjectCredentialInteropTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val output get() = File(context.filesDir, "extension-interop-315").apply { mkdirs() }
    private suspend fun scenario(block: suspend TransferFixture.(PasswordViewModel) -> Unit) {
        val fixture = TransferFixture()
        val model = PasswordViewModel(fixture.passwords, fixture.security,
            customFieldRepository = CustomFieldRepository(fixture.db.customFieldDao()), context = fixture.context,
            localKeePassDatabaseDao = fixture.db.localKeePassDatabaseDao(), strings = AppLocaleStringResolver(fixture.context))
        try { fixture.block(model) } finally { model.viewModelScope.cancel(); fixture.close() }
    }
    private suspend fun save(model: PasswordViewModel, entry: PasswordEntry, target: StorageTarget,
        groups: List<ProjectCredentialGroup.Group>, originals: List<Long> = emptyList(), fields: List<CustomFieldDraft> = emptyList()) {
        val done = CompletableDeferred<Long?>()
        model.savePasswordsAcrossTargets(originals, entry, emptyList(), listOf(target), fields,
            projectCredentials = groups, onComplete = { done.complete(it) })
        assertNotNull(withTimeout(45_000) { done.await() })
    }
    private suspend fun TransferFixture.reopen(target: ImportDestination) {
        Mdbx2NativeReadSessions.clear()
        val manager = MdbxViewModel(context.applicationContext as android.app.Application, db.localMdbxDatabaseDao(),
            db.mdbxRemoteSourceDao(), db.passwordEntryDao(), db.secureItemDao(), db.passkeyDao(), db.attachmentDao(), db.customFieldDao(), security)
        try {
            manager.syncVault(target.databaseId)
            val state = withTimeout(45_000) { manager.operationState.first {
                it is MdbxViewModel.OperationState.Success || it is MdbxViewModel.OperationState.Error
            } }
            assertTrue(state.toString(), state is MdbxViewModel.OperationState.Success)
        } finally { manager.viewModelScope.cancel() }
    }
    private suspend fun TransferFixture.readEntries(target: ImportDestination) =
        db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == target.databaseId }.map {
            it.copy(password = security.decryptDataIfMonicaCiphertext(it.password),
                authenticatorKey = security.decryptDataIfMonicaCiphertext(it.authenticatorKey))
        }
    private suspend fun TransferFixture.readFields(entries: List<PasswordEntry>) = entries.associate { entry ->
        entry.id to db.customFieldDao().getFieldsByEntryIdSync(entry.id).map {
            CustomFieldDraft(it.id, it.title, security.decryptDataIfMonicaCiphertext(it.value), it.isProtected)
        }
    }
    private suspend fun TransferFixture.export(target: ImportDestination, name: String) {
        val archive = model.prepareZipBackup(backupEncryptionPassword = "synthetic archive password", source = target,
            preferences = BackupPreferences(includeImages = true)).getOrThrow().first
        try { archive.copyTo(File(output, name), overwrite = true) } finally { archive.delete() }
    }
    private fun snapshot(entries: List<PasswordEntry>, fields: Map<Long, List<CustomFieldDraft>>): JSONArray = JSONArray(entries.sortedBy { it.replicaGroupId }.map { entry ->
        val meta = requireNotNull(ProjectCredentialGroup.read(fields.getValue(entry.id)))
        assertEquals("Inner and outer project identities must agree", entry.passwordGroupId, meta.projectId)
        JSONObject().put("title", entry.title).put("projectId", entry.passwordGroupId)
            .put("username", entry.username).put("password", entry.password).put("otp", entry.authenticatorKey)
            .put("metadata", JSONObject(meta.raw.toString()))
    })

    @Test fun exportProjectCredentials(): Unit = runBlocking {
        scenario { writer ->
            val target = mdbx()
            val initial = listOf(
                ProjectCredentialGroup.Group(label = "工作账号", username = "primary-user", otp = "JBSWY3DPEHPK3PXP",
                    passwords = listOf(ProjectCredentialGroup.Password(value = "first-password"), ProjectCredentialGroup.Password(value = "second-password"))),
                ProjectCredentialGroup.Group(label = "恢复账号", username = "recovery-user", passwords = listOf(ProjectCredentialGroup.Password(value = "recovery-password")))
            )
            val metadata = ProjectCredentialGroup.rows(initial).associate { row -> row.password.id to requireNotNull(
                ProjectCredentialGroup.parse(row.metadata.raw.toString().dropLast(1) + ",\"futureCounter\":9007199254740993}")) }
            val groups = initial.map { group -> group.copy(passwords = group.passwords.map { it.copy(metadata = metadata.getValue(it.id)) }) }
            save(writer, PasswordEntry(title = "Credential project", website = "", username = "", password = "",
                notes = "  合成项目 🔑\n", email = "synthetic@example.invalid"),
                StorageTarget.Mdbx(target.databaseId), groups,
                fields = listOf(CustomFieldDraft(title = "future-field", value = "  retained  ", isProtected = true)))
            reopen(target)
            val entries = readEntries(target); val fields = readFields(entries)
            assertEquals(3, entries.size)
            val restored = ProjectCredentialGroup.restore(entries, fields)
            assertEquals(listOf(2, 1), restored.map { it.passwords.size })
            assertEquals(listOf("primary-user", "recovery-user"), restored.map { it.username })
            assertTrue(fields.values.all { rows -> ProjectCredentialGroup.read(rows)!!.raw.toString().contains("9007199254740993") })
            File(output, "android-project-credentials.json").writeText(JSONObject().put("status", "passed")
                .put("rows", snapshot(entries, fields)).put("layer", "Android project writer and native reopen").toString(2))
            export(target, "android-project-credentials.zip")
        }
    }

    @Test fun restoreAndEditProjectCredentials(): Unit = runBlocking {
        val incoming = File(output, "extension-project-credentials.zip")
        assertTrue(incoming.isFile)
        val content = WebDavHelper(context).restoreFromBackupFile(incoming, "synthetic archive password",
            restoreMonicaConfig = false, importDataOnly = true).getOrThrow().content
        assertEquals(10, content.passwords.size)
        scenario { writer ->
            val target = mdbx()
            assertEquals(10, importer.apply(content, target).imported)
            reopen(target)
            val entries = readEntries(target); val fields = readFields(entries)
            assertEquals(10, entries.size)
            val projects = entries.groupBy { it.passwordGroupId }
            assertEquals(2, projects.size)
            for (rows in projects.values) {
                val groups = ProjectCredentialGroup.restore(rows, fields)
                assertEquals(listOf(3, 1, 1), groups.map { it.passwords.size })
                assertEquals(listOf("Browser account", "Third account", "恢复账号"), groups.map { it.label })
                assertEquals(listOf("browser-user", "third-user", "recovery-user"), groups.map { it.username })
                assertEquals("", groups[0].otp)
                assertEquals(listOf("second-password", "first-password", "browser-added-password"), groups[0].passwords.map { it.value })
                for (entry in rows) {
                    val original = content.passwords.single { it.title == entry.title &&
                        security.decryptDataIfMonicaCiphertext(it.password) == entry.password }
                    val expectedFields = content.customFieldsMap[original.id].orEmpty().map { Triple(it.title, it.value, it.isProtected) }.sortedBy { it.first }
                    assertEquals(expectedFields, fields.getValue(entry.id).map { Triple(it.title, it.value, it.isProtected) }.sortedBy { it.first })
                }
            }
            val before = snapshot(entries, fields)
            val edited = entries.filter { it.title == "Credential project edited" }
            assertEquals(5, edited.size)
            val groups = ProjectCredentialGroup.restore(edited, fields).mapIndexed { index, group -> if (index == 0)
                group.copy(label = "Android returned", username = "android-user", passwords = group.passwords.mapIndexed { passwordIndex, password ->
                    if (passwordIndex == 2) password.copy(value = "android-final-password") else password
                }) else group }
            val anchor = edited.single { it.password == "second-password" }
            save(writer, anchor, StorageTarget.Mdbx(target.databaseId), groups, edited.map { it.id }, fields.getValue(anchor.id))
            reopen(target)
            val after = readEntries(target); val afterFields = readFields(after)
            assertEquals(10, after.size)
            assertEquals(entries.map { it.replicaGroupId }.toSet(), after.map { it.replicaGroupId }.toSet())
            val returnedGroups = ProjectCredentialGroup.restore(after.filter { it.title == "Credential project edited" }, afterFields)
            assertEquals("android-user", returnedGroups[0].username)
            assertEquals("android-final-password", returnedGroups[0].passwords[2].value)
            assertEquals(snapshot(entries.filter { it.title == "Credential project copy" }, fields).toString(),
                snapshot(after.filter { it.title == "Credential project copy" }, afterFields).toString())
            File(output, "android-project-credentials-return.json").writeText(JSONObject().put("status", "passed")
                .put("beforeAndroidEdit", before).put("afterAndroidEdit", snapshot(after, afterFields)).toString(2))
            export(target, "android-project-credentials-return.zip")
        }
    }
}
