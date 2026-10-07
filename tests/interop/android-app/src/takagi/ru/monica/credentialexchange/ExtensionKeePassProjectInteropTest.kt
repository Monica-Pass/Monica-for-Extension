package takagi.ru.monica.credentialexchange

import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
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
import takagi.ru.monica.utils.SettingsManager
import takagi.ru.monica.viewmodel.CategoryFilter
import takagi.ru.monica.viewmodel.PasswordViewModel

/** Uses the actual Android writer and fresh file import, without seeding projected Room identities. */
@RunWith(AndroidJUnit4::class)
class ExtensionKeePassProjectInteropTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val output get() = File(context.filesDir, "extension-interop-315").apply { mkdirs() }

    @Test fun writeAndReopenProject(): Unit = runBlocking {
        val settings = SettingsManager(context)
        val savedSettings = settings.settingsFlow.first()
        val fixture = TransferFixture()
        val model = PasswordViewModel(fixture.passwords, fixture.security,
            customFieldRepository = CustomFieldRepository(fixture.db.customFieldDao()), context = context,
            localKeePassDatabaseDao = fixture.db.localKeePassDatabaseDao(), strings = AppLocaleStringResolver(context))
        val report = JSONObject().put("status", "failed")
            .put("layer", "Android project writer -> native KDBX -> new database -> actual Room projection")
        suspend fun select(databaseId: Long) {
            withContext(Dispatchers.Main) { model.setCategoryFilter(CategoryFilter.KeePassDatabase(databaseId)) }
            withTimeout(10_000) { settings.settingsFlow.first {
                it.lastPasswordCategoryFilterType == "keepass_database" && it.lastPasswordCategoryFilterPrimaryId == databaseId
            } }
        }
        suspend fun rows(databaseId: Long) = fixture.db.passwordEntryDao().getAllPasswordEntriesSync()
            .filter { it.keepassDatabaseId == databaseId }.sortedBy { it.keepassEntryUuid }
        suspend fun snapshot(entries: List<PasswordEntry>): JSONArray {
            val result = JSONArray()
            for (row in entries) {
                fun plain(value: String) = fixture.security.decryptDataIfMonicaCiphertext(value)
                val fields = fixture.db.customFieldDao().getFieldsByEntryIdSync(row.id)
                result.put(JSONObject().put("id", row.id).put("uuid", row.keepassEntryUuid)
                    .put("projectId", row.passwordGroupId ?: JSONObject.NULL)
                    .put("explicitProjectId", row.explicitPasswordGroupId() ?: JSONObject.NULL)
                    .put("replicaGroupId", row.replicaGroupId ?: JSONObject.NULL)
                    .put("projectKey", row.passwordProjectKey()).put("title", row.title)
                    .put("username", row.username).put("password", plain(row.password))
                    .put("otp", plain(row.authenticatorKey)).put("notes", row.notes).put("website", row.website)
                    .put("email", row.email).put("phone", row.phone).put("addressLine", row.addressLine)
                    .put("city", row.city).put("state", row.state).put("zipCode", row.zipCode).put("country", row.country)
                    .put("creditCardNumber", plain(row.creditCardNumber)).put("creditCardHolder", row.creditCardHolder)
                    .put("creditCardExpiry", row.creditCardExpiry).put("creditCardCVV", plain(row.creditCardCVV))
                    .put("appPackageName", row.appPackageName).put("appName", row.appName)
                    .put("fields", JSONArray(fields.map { JSONObject().put("title", it.title)
                        .put("value", plain(it.value)).put("isProtected", it.isProtected).put("sortOrder", it.sortOrder) })))
            }
            return result
        }
        try {
            val source = fixture.keepass(); val sourceId = requireNotNull(source.databaseId)
            select(sourceId)
            val initial = listOf(
                ProjectCredentialGroup.Group(label = "工作账号", username = "primary-user", otp = "JBSWY3DPEHPK3PXP",
                    passwords = listOf(ProjectCredentialGroup.Password(value = "first-password"), ProjectCredentialGroup.Password(value = "second-password"))),
                ProjectCredentialGroup.Group(label = "恢复账号", username = "recovery-user",
                    passwords = listOf(ProjectCredentialGroup.Password(value = "recovery-password"))))
            val metadata = ProjectCredentialGroup.rows(initial).associate { row -> row.password.id to requireNotNull(
                ProjectCredentialGroup.parse(row.metadata.raw.toString().dropLast(1) + ",\"futureCounter\":9007199254740993}")) }
            val groups = initial.map { group -> group.copy(passwords = group.passwords.map { it.copy(metadata = metadata.getValue(it.id)) }) }
            val common = PasswordEntry(title = "${fixture.prefix}-project", website = "https://example.invalid/path", username = "", password = "",
                notes = "  合成项目 🔑\n", email = "synthetic@example.invalid", phone = "+1 555 0100", addressLine = "  42 Test Street  ",
                city = "City", state = "State", zipCode = "01234", country = "Test", creditCardNumber = "4111111111111111",
                creditCardHolder = "Synthetic Holder", creditCardExpiry = "01/30", creditCardCVV = "123",
                appPackageName = "invalid.synthetic.app", appName = "Synthetic App")
            val done = CompletableDeferred<Long?>()
            model.savePasswordsAcrossTargets(emptyList(), common, emptyList(), listOf(StorageTarget.KeePass(sourceId, null)),
                listOf(CustomFieldDraft(title = "future-field", value = "  retained\r\n精确🔑  ", isProtected = true)),
                projectCredentials = groups, onComplete = { done.complete(it) })
            assertNotNull("Actual project save must succeed", withTimeout(45_000) { done.await() })
            val controlDone = CompletableDeferred<Long?>()
            model.savePasswordsAcrossTargets(emptyList(), common.copy(username = "primary-user", password = "control-password"),
                listOf("control-password"), listOf(StorageTarget.KeePass(sourceId, null)), onComplete = { controlDone.complete(it) })
            assertNotNull(withTimeout(45_000) { controlDone.await() })
            val before = rows(sourceId)
            assertEquals(4, before.size)
            val project = before.filter { fixture.security.decryptDataIfMonicaCiphertext(it.password) != "control-password" }
            assertEquals(1, project.map { it.passwordProjectKey() }.toSet().size)
            assertEquals(2, before.map { it.passwordProjectKey() }.toSet().size)
            report.put("before", snapshot(before))
            File(output, "android-keepass-project.json").writeText(report.toString(2))
            fixture.keepassFile(sourceId).copyTo(File(output, "android-keepass-project.kdbx"), overwrite = true)
            assertEquals(4, fixture.keepassEntries(sourceId).size)
            val destination = fixture.keepass(); val destinationId = requireNotNull(destination.databaseId)
            assertTrue(rows(destinationId).isEmpty())
            fixture.keepassFile(sourceId).copyTo(fixture.keepassFile(destinationId), overwrite = true)
            select(destinationId)
            model.syncKeePassDatabaseForVisibleVault(destinationId, forceRefresh = true)
            val after = withTimeout(45_000) {
                while (true) {
                    val found = rows(destinationId)
                    if (found.size == 4 && found.count { row -> fixture.db.customFieldDao().getFieldsByEntryIdSync(row.id)
                        .any { it.title == ProjectCredentialGroup.FIELD } } == 3) break
                    delay(100)
                }
                rows(destinationId)
            }
            val afterSnapshot = snapshot(after)
            report.put("after", afterSnapshot)
            assertTrue("Fresh destination must allocate new Room identities", after.none { row -> before.any { it.id == row.id } })
            val restoredProjects = after.filter { fixture.security.decryptDataIfMonicaCiphertext(it.password) != "control-password" }
            val preserved = project.all { old -> restoredProjects.single { it.keepassEntryUuid == old.keepassEntryUuid }.explicitPasswordGroupId() == old.explicitPasswordGroupId() }
            report.put("projectIdentityPreserved", preserved)
                .put("beforeProjectCount", before.map { it.passwordProjectKey() }.toSet().size)
                .put("afterProjectCount", after.map { it.passwordProjectKey() }.toSet().size)
            assertTrue("Native KDBX fresh import must restore explicit project identities from credential metadata", preserved)
            report.put("status", "passed")
        } catch (error: Throwable) {
            report.put("error", error.toString())
            throw error
        } finally {
            File(output, "android-keepass-project.json").writeText(report.toString(2))
            model.viewModelScope.coroutineContext[Job]?.cancelAndJoin()
            fixture.close()
            settings.updateLastPasswordCategoryFilter(savedSettings.lastPasswordCategoryFilterType, savedSettings.lastPasswordCategoryFilterPrimaryId,
                savedSettings.lastPasswordCategoryFilterSecondaryId, savedSettings.lastPasswordCategoryFilterText, savedSettings.lastPasswordCategoryFilterGroupUuid)
            val restored = withTimeout(10_000) { settings.settingsFlow.first {
                it.lastPasswordCategoryFilterType == savedSettings.lastPasswordCategoryFilterType &&
                    it.lastPasswordCategoryFilterPrimaryId == savedSettings.lastPasswordCategoryFilterPrimaryId &&
                    it.lastPasswordCategoryFilterSecondaryId == savedSettings.lastPasswordCategoryFilterSecondaryId &&
                    it.lastPasswordCategoryFilterText == savedSettings.lastPasswordCategoryFilterText &&
                    it.lastPasswordCategoryFilterGroupUuid == savedSettings.lastPasswordCategoryFilterGroupUuid
            } }
            assertEquals(savedSettings.lastPasswordCategoryFilterType, restored.lastPasswordCategoryFilterType)
            assertEquals(savedSettings.lastPasswordCategoryFilterPrimaryId, restored.lastPasswordCategoryFilterPrimaryId)
            assertEquals(savedSettings.lastPasswordCategoryFilterSecondaryId, restored.lastPasswordCategoryFilterSecondaryId)
            assertEquals(savedSettings.lastPasswordCategoryFilterText, restored.lastPasswordCategoryFilterText)
            assertEquals(savedSettings.lastPasswordCategoryFilterGroupUuid, restored.lastPasswordCategoryFilterGroupUuid)
            report.put("originalFilterRestored", true)
            File(output, "android-keepass-project.json").writeText(report.toString(2))
        }
    }
}
