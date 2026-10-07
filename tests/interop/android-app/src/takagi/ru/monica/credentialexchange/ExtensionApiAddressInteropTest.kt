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
import takagi.ru.monica.viewmodel.MdbxViewModel
import takagi.ru.monica.viewmodel.PasswordViewModel
import uniffi.mdbx_ffi.openVault

/** Actual Android draft/writer/projection, isolated from all user databases. */
@RunWith(AndroidJUnit4::class)
class ExtensionApiAddressInteropTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val output get() = File(context.filesDir, "extension-interop-315").apply { mkdirs() }
    private val addresses = linkedMapOf(
        "relative" to "/v1/chat/completions", "service" to "internal service: staging",
        "protocol" to "grpc://synthetic.invalid:443", "user-info" to "https://user:synthetic@example.invalid/api",
        "script" to "javascript:synthetic()", "long" to "route/" + "x".repeat(2200), "empty" to ""
    )
    private suspend fun scenario(block: suspend TransferFixture.(PasswordViewModel) -> Unit) {
        val fixture = TransferFixture()
        val model = PasswordViewModel(fixture.passwords, fixture.security,
            customFieldRepository = CustomFieldRepository(fixture.db.customFieldDao()), context = fixture.context,
            localKeePassDatabaseDao = fixture.db.localKeePassDatabaseDao(), strings = AppLocaleStringResolver(fixture.context))
        try { fixture.block(model) } finally { model.viewModelScope.cancel(); fixture.close() }
    }
    private suspend fun save(model: PasswordViewModel, entry: PasswordEntry, target: StorageTarget, custom: List<CustomFieldDraft>) {
        val done = CompletableDeferred<Long?>()
        model.savePasswordsAcrossTargets(listOf(entry.id).filter { it > 0 }, entry, listOf(entry.password), listOf(target), custom,
            onComplete = { done.complete(it) })
        requireNotNull(withTimeout(45_000) { done.await() })
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
    private suspend fun TransferFixture.backup(target: ImportDestination, name: String) {
        Mdbx2NativeReadSessions.clear()
        val path = requireNotNull(db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
        val destination = File(output, name)
        if (destination.exists()) check(destination.renameTo(File(output, "previous-${System.nanoTime()}-$name")))
        openVault(path, "Synthetic transfer fixture password", "api-address-export").use { it.createBackup(destination.absolutePath) }
    }
    @Test fun exportApiAddressFixtures(): Unit = runBlocking {
        scenario { model ->
            val target = mdbx()
            for ((name, address) in addresses) {
                val draft = ApiKeyDraft(provider = "API address $name", key = "synthetic-$name", apiUrl = address, notes = "Keep API note $name")
                assertTrue(draft.isValid)
                val custom = listOf(CustomFieldDraft(title = "before", value = "retained", isProtected = true)) +
                    draft.customFields(emptyList()).map { if (it.title == ApiKeyEntryFields.API_URL) it.copy(isProtected = true) else it } +
                    CustomFieldDraft(title = "after", value = "0007", isProtected = true)
                save(model, draft.toEntry().copy(appName = "合成服务", appPackageName = "invalid.synthetic.api", email = "api@example.invalid"),
                    StorageTarget.Mdbx(target.databaseId), custom)
            }
            reopen(target)
            val entries = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == target.databaseId }
            assertEquals(addresses.size, entries.size)
            val samples = JSONArray()
            for ((name, expected) in addresses) {
                val entry = entries.single { it.title == "API address $name" }
                val custom = db.customFieldDao().getFieldsByEntryIdSync(entry.id)
                val fields = custom.associate { it.title to security.decryptDataIfMonicaCiphertext(it.value) }
                assertEquals(expected, ApiKeyDraft.from(entry, fields).apiUrl)
                assertEquals("synthetic-$name", security.decryptDataIfMonicaCiphertext(entry.password))
                samples.put(JSONObject().put("name", name).put("title", entry.title).put("endpoint", expected)
                    .put("navigable", ApiKeyEntryFields.isValidOptionalUrl(expected)))
            }
            File(output, "android-api-address.json").writeText(JSONObject().put("status", "passed").put("samples", samples).toString(2))
            backup(target, "android-api-address.mdbx")
        }
    }
    @Test fun reopenEdgeApiAddresses(): Unit = runBlocking {
        val incoming = File(output, "edge-api-address.mdbx")
        assertTrue(incoming.isFile)
        scenario { model ->
            val target = mdbx()
            Mdbx2NativeReadSessions.clear()
            val path = requireNotNull(db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
            openVault(incoming.absolutePath, "Synthetic transfer fixture password", "api-address-import").use { vault ->
                // This is the newly created empty test vault, never a user's vault.
                check(File(path).delete()); vault.createBackup(path)
            }
            reopen(target)
            val entries = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == target.databaseId }
            assertEquals(addresses.size + 1, entries.size)
            val expected = addresses + mapOf("service" to "/v2/services: 中文", "user-info" to "", "empty" to "/new", "edge" to "localhost:9080/api")
            val readback = JSONArray()
            for ((name, endpoint) in expected) {
                val title = "API address $name" + if (name == "relative") " renamed" else ""
                val entry = entries.single { it.title == title }
                assertEquals("API_KEY", entry.loginType)
                assertEquals(if (name == "edge") "synthetic-edge-api" else "synthetic-$name", security.decryptDataIfMonicaCiphertext(entry.password))
                val fields = db.customFieldDao().getFieldsByEntryIdSync(entry.id).associate { it.title to security.decryptDataIfMonicaCiphertext(it.value) }
                assertEquals(endpoint, ApiKeyDraft.from(entry, fields).apiUrl)
                if (name != "edge") {
                    assertEquals("retained", fields["before"]); assertEquals("0007", fields["after"])
                    assertEquals("合成服务", entry.appName); assertEquals("api@example.invalid", entry.email)
                }
                readback.put(JSONObject().put("title", title).put("endpoint", endpoint).put("nativeId", entry.replicaGroupId))
            }
            val service = entries.single { it.title == "API address service" }
            val fields = db.customFieldDao().getFieldsByEntryIdSync(service.id).map { CustomFieldDraft(it.id, it.title, security.decryptDataIfMonicaCiphertext(it.value), it.isProtected) }
            val returned = ApiKeyDraft.from(service, fields.associate { it.title to it.value }).copy(
                key = security.decryptDataIfMonicaCiphertext(service.password), apiUrl = "staging service: returned")
            save(model, returned.toEntry(service), StorageTarget.Mdbx(target.databaseId), returned.customFields(fields))
            reopen(target)
            File(output, "android-api-address-return.json").writeText(JSONObject().put("status", "passed").put("readback", readback)
                .put("returnedServiceEndpoint", returned.apiUrl).put("layer", "Android API draft, native write, Room reopen and export").toString(2))
            backup(target, "android-api-address-return.mdbx")
        }
    }
}
