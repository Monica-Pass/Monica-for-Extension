package takagi.ru.monica.credentialexchange

import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.IOException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.Base64
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import takagi.ru.monica.bitwarden.api.SyncResponse
import takagi.ru.monica.bitwarden.crypto.BitwardenCrypto
import takagi.ru.monica.bitwarden.service.BitwardenSyncService
import takagi.ru.monica.bitwarden.service.CipherSyncProcessor
import takagi.ru.monica.bitwarden.service.CipherSyncResult
import takagi.ru.monica.bitwarden.service.UploadResult
import takagi.ru.monica.data.CustomFieldDraft
import takagi.ru.monica.data.PasswordEntry
import takagi.ru.monica.data.model.StorageTarget
import takagi.ru.monica.data.model.ProjectCredentialGroup
import takagi.ru.monica.repository.CustomFieldRepository
import takagi.ru.monica.utils.AppLocaleStringResolver
import takagi.ru.monica.viewmodel.PasswordViewModel

/** Real HTTP + app decrypt/store/project writer/upload. Only the explicitly seeded synthetic account. */
@RunWith(AndroidJUnit4::class)
class ExtensionBitwardenProjectInteropTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val output get() = File(context.filesDir, "extension-interop-315").apply { mkdirs() }
    private val json = Json { ignoreUnknownKeys = true }

    @Test fun downloadEditAndUploadProjects(): Unit = runBlocking {
        val inputFile = File(output, "bitwarden-project-input.json")
        val input = JSONObject(inputFile.readText())
        require(input.getBoolean("synthetic"))
        require(input.getString("baseUrl") == "http://127.0.0.1:18316")
        require(Regex("project-[0-9a-f-]{36}@example.invalid").matches(input.getString("email")))
        val expected = input.getJSONArray("items")
        assertEquals(9, expected.length())
        val token = input.getString("accessToken")
        val key = BitwardenCrypto.SymmetricCryptoKey(Base64.getDecoder().decode(input.getString("vaultKeyEnc")),
            Base64.getDecoder().decode(input.getString("vaultKeyMac")))
        val originalProxySelector = ProxySelector.getDefault()
        ProxySelector.setDefault(object : ProxySelector() {
            override fun select(uri: URI): MutableList<Proxy> =
                if (uri.host == "127.0.0.1" && uri.port == 18316) mutableListOf(Proxy.NO_PROXY)
                else (originalProxySelector?.select(uri) ?: listOf(Proxy.NO_PROXY)).toMutableList()
            override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) {
                originalProxySelector?.connectFailed(uri, address, error)
            }
        })
        val fixture = TransferFixture()
        val writer = PasswordViewModel(fixture.passwords, fixture.security,
            customFieldRepository = CustomFieldRepository(fixture.db.customFieldDao()), context = context,
            localKeePassDatabaseDao = fixture.db.localKeePassDatabaseDao(), strings = AppLocaleStringResolver(context))
        val client = OkHttpClient()
        fun download(): SyncResponse = client.newCall(Request.Builder()
            .url("${input.getString("baseUrl")}/api/sync?excludeDomains=true")
            .header("Authorization", "Bearer $token").build()).execute().use {
            assertEquals("Synthetic Vaultwarden must answer", 200, it.code)
            json.decodeFromString<SyncResponse>(requireNotNull(it.body).string())
        }
        try {
            with(fixture) {
                val target = bitwarden(unlocked = false)
                fun stored(value: String) = Base64.getEncoder().encodeToString(value.toByteArray())
                val vault = requireNotNull(db.bitwardenVaultDao().getVaultById(target.databaseId)).copy(
                    serverUrl = input.getString("baseUrl"), identityUrl = "${input.getString("baseUrl")}/identity/",
                    apiUrl = "${input.getString("baseUrl")}/api/", encryptedAccessToken = stored(token),
                    encryptedEncKey = stored(input.getString("vaultKeyEnc")), encryptedMacKey = stored(input.getString("vaultKeyMac")))
                db.bitwardenVaultDao().update(vault)
                suspend fun rows() = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.bitwardenVaultId == vault.id }.map {
                    it.copy(password = security.decryptDataIfMonicaCiphertext(it.password),
                        authenticatorKey = security.decryptDataIfMonicaCiphertext(it.authenticatorKey))
                }
                suspend fun fields(entries: List<PasswordEntry>) = entries.associate { entry -> entry.id to
                    db.customFieldDao().getFieldsByEntryIdSync(entry.id).map {
                        CustomFieldDraft(it.id, it.title, security.decryptDataIfMonicaCiphertext(it.value), it.isProtected)
                    } }
                fun snapshot(entries: List<PasswordEntry>, values: Map<Long, List<CustomFieldDraft>>) = JSONArray(entries.sortedBy { it.bitwardenCipherId }.map { entry ->
                    JSONObject().put("cipherId", entry.bitwardenCipherId).put("projectId", entry.passwordGroupId ?: JSONObject.NULL)
                        .put("title", entry.title).put("username", entry.username).put("password", entry.password)
                        .put("notes", entry.notes).put("otp", entry.authenticatorKey).put("website", entry.website)
                        .put("fields", JSONArray(values.getValue(entry.id).map {
                            JSONObject().put("name", it.title).put("value", it.value).put("protected", it.isProtected)
                        }))
                })
                val initialRemote = download()
                assertEquals(input.getString("email"), initialRemote.profile.email)
                assertEquals(9, initialRemote.ciphers.size)
                val processor = CipherSyncProcessor(context)
                initialRemote.ciphers.forEach { cipher ->
                    assertTrue("Cipher must import", processor.syncCipherFromServer(vault, cipher, key) is CipherSyncResult.Added)
                }
                val entries = rows(); val values = fields(entries)
                val diagnostic = JSONObject().put("phase", "downloaded").put("before", snapshot(entries, values))
                fun checkpoint() = File(output, "bitwarden-project-progress.json").writeText(diagnostic.toString(2))
                checkpoint()
                assertEquals(9, entries.size)
                for (index in 0 until expected.length()) {
                    val wanted = expected.getJSONObject(index)
                    val actual = entries.single { it.bitwardenCipherId == wanted.getString("cipherId") }
                    assertEquals(wanted.optString("projectId").ifEmpty { null }, actual.passwordGroupId)
                    assertEquals(wanted.getString("title"), actual.title)
                    assertEquals(wanted.getString("username"), actual.username)
                    assertEquals(wanted.getString("password"), actual.password)
                    assertEquals(wanted.getString("notes"), actual.notes)
                    assertEquals(wanted.getString("otp"), actual.authenticatorKey)
                    assertEquals(wanted.getString("website"), actual.website)
                    val wantedFields = wanted.getJSONArray("fields")
                    assertEquals(wantedFields.length(), values.getValue(actual.id).size)
                    for (fieldIndex in 0 until wantedFields.length()) {
                        val field = wantedFields.getJSONObject(fieldIndex)
                        val actualField = values.getValue(actual.id).single { it.title == field.getString("name") }
                        assertEquals(field.getString("value"), actualField.value)
                        assertEquals(field.getBoolean("protected"), actualField.isProtected)
                    }
                }
                val projectId = input.getString("projectId")
                val project = entries.filter { it.passwordGroupId == projectId }
                assertEquals(6, project.size)
                val groups = ProjectCredentialGroup.restore(project, values)
                assertEquals(3, groups.size)
                val untouched = snapshot(entries.filter { it.passwordGroupId != projectId }, values).toString()
                val before = snapshot(entries, values)
                val changed = groups.mapIndexed { index, group -> if (index == 0) group.copy(label = "Android 服务回写",
                    username = "android-server-user", passwords = group.passwords.reversed()) else group }
                val anchor = project.single { it.id == groups.first().passwords.first().originalEntryId }
                val done = CompletableDeferred<Long?>()
                writer.savePasswordsAcrossTargets(project.map { it.id }, anchor.copy(notes = "  Android HTTP 回写\r\n\t保留  "),
                    emptyList(), listOf(StorageTarget.Bitwarden(vault.id, null)), values.getValue(anchor.id),
                    projectCredentials = changed, onComplete = { done.complete(it) })
                assertNotNull(withTimeout(45_000) { done.await() })
                val edited = rows(); val editedFields = fields(edited)
                diagnostic.put("phase", "edited-locally").put("edited", snapshot(edited, editedFields)); checkpoint()
                assertEquals(9, edited.size)
                assertEquals(untouched, snapshot(edited.filter { it.passwordGroupId != projectId }, editedFields).toString())
                assertEquals(entries.map { it.bitwardenCipherId }.toSet(), edited.map { it.bitwardenCipherId }.toSet())
                val upload = BitwardenSyncService(context).uploadModifiedEntries(vault, token, key)
                assertTrue(upload.toString(), upload is UploadResult.Success)
                upload as UploadResult.Success
                diagnostic.put("phase", "uploaded").put("uploaded", upload.uploaded).put("failed", upload.failed); checkpoint()
                assertEquals(6, upload.uploaded)
                assertEquals(0, upload.failed)
                val remoteAfter = download()
                assertEquals(9, remoteAfter.ciphers.size)
                // Drop only this fixture's local rows and prove a fresh app processor reconstructs the server state.
                edited.forEach { db.passwordEntryDao().deletePasswordEntryById(it.id) }
                val fresh = CipherSyncProcessor(context)
                remoteAfter.ciphers.forEach { cipher ->
                    assertTrue("Uploaded Cipher must reimport", fresh.syncCipherFromServer(vault, cipher, key) is CipherSyncResult.Added)
                }
                val returned = rows(); val returnedFields = fields(returned)
                val after = snapshot(returned, returnedFields)
                diagnostic.put("phase", "downloaded-again").put("after", after); checkpoint()
                assertEquals(snapshot(edited, editedFields).toString(), after.toString())
                val restored = ProjectCredentialGroup.restore(returned.filter { it.passwordGroupId == projectId }, returnedFields)
                assertEquals(changed.map { it.passwords.map { password -> password.id } }, restored.map { it.passwords.map { password -> password.id } })
                assertEquals("android-server-user", restored.first().username)
                File(output, "bitwarden-project-return.json").writeText(JSONObject().put("status", "passed")
                    .put("layer", "Real Vaultwarden HTTP -> Android decrypt/store/project edit/upload -> fresh Android download")
                    .put("projectId", projectId).put("before", before).put("after", after).toString(2))
            }
        } finally {
            ProxySelector.setDefault(originalProxySelector)
            writer.viewModelScope.cancel()
            fixture.close()
            key.clear()
            inputFile.delete()
        }
    }
}
