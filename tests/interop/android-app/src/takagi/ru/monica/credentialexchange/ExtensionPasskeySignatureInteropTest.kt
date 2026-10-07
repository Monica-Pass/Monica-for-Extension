package takagi.ru.monica.credentialexchange

import android.content.Context
import android.content.ContextWrapper
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyPair
import java.security.MessageDigest
import java.security.Signature
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import takagi.ru.monica.data.PasskeyEntry
import takagi.ru.monica.passkey.PasskeyAuthActivity
import takagi.ru.monica.passkey.PasskeyCreateActivity
import takagi.ru.monica.passkey.PasskeyPrivateKeyStore
import takagi.ru.monica.passkey.PasskeyPrivateKeySupport
import takagi.ru.monica.passkey.PasskeyCredentialIdCodec
import takagi.ru.monica.repository.Mdbx2NativeReadSessions
import takagi.ru.monica.viewmodel.MdbxViewModel
import takagi.ru.monica.utils.KeePassKdbxService
import takagi.ru.monica.utils.WebDavKeePassFileSource
import takagi.ru.monica.utils.AppLocaleStringResolver
import takagi.ru.monica.keepass.KeePassSourceChangedException
import java.net.Proxy
import java.net.ProxySelector
import java.net.URI
import java.net.SocketAddress
import java.io.IOException
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import takagi.ru.monica.bitwarden.api.SyncResponse
import takagi.ru.monica.bitwarden.crypto.BitwardenCrypto
import takagi.ru.monica.bitwarden.service.BitwardenSyncService
import takagi.ru.monica.bitwarden.service.CipherSyncProcessor
import takagi.ru.monica.bitwarden.service.CipherSyncResult
import takagi.ru.monica.bitwarden.service.UploadResult
import uniffi.mdbx_ffi.openVault

/** Calls the application's actual crypto methods, not Credential Manager/UI or biometric acceptance. */
@RunWith(AndroidJUnit4::class)
class ExtensionPasskeySignatureInteropTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val output get() = File(context.filesDir, "extension-interop-317-passkey").apply { mkdirs() }
    private val password = "Synthetic transfer fixture password"
    private fun b64(bytes: ByteArray) = Base64.getEncoder().encodeToString(bytes)
    private fun url64(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)

    private fun activity(): PasskeyAuthActivity {
        lateinit var activity: PasskeyAuthActivity
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            activity = PasskeyAuthActivity()
            ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java).apply {
                isAccessible = true
            }.invoke(activity, context)
        }
        return activity
    }

    private fun signedProof(entry: PasskeyEntry): JSONObject {
        val activity = activity()
        val auth = PasskeyAuthActivity::class.java.getDeclaredMethod("createAuthenticatorData", String::class.java, Int::class.javaPrimitiveType).apply {
            isAccessible = true
        }.invoke(activity, entry.rpId, 0) as ByteArray
        val client = JSONObject().put("type", "webauthn.get").put("challenge", url64(UUID.randomUUID().toString().toByteArray()))
            .put("origin", "https://${entry.rpId}").put("crossOrigin", false).toString().toByteArray()
        val data = auth + sha(client)
        val signature = PasskeyAuthActivity::class.java.getDeclaredMethod("signWithPrivateKey", String::class.java,
            Int::class.javaPrimitiveType, ByteArray::class.java).apply { isAccessible = true }
            .invoke(activity, entry.privateKeyAlias, entry.publicKeyAlgorithm, data) as ByteArray
        return JSONObject().put("credentialId", PasskeyCredentialIdCodec.toWebAuthnId(entry.credentialId))
            .put("storedCredentialId", entry.credentialId).put("algorithm", entry.publicKeyAlgorithm)
            .put("rpId", entry.rpId).put("userHandle", entry.userId).put("authenticatorData", b64(auth))
            .put("clientDataJSON", b64(client)).put("signature", b64(signature))
            .put("storedSignCount", entry.signCount).put("storedIsBackedUp", entry.isBackedUp)
            .put("flags", auth[32].toInt() and 255).put("protectedRoomReference", PasskeyPrivateKeyStore.isProtectedReference(entry.privateKeyAlias))
            .put("keyMaterialSha256", b64(sha(checkNotNull(PasskeyPrivateKeySupport.decodeFlexiblePrivateKey(
                PasskeyPrivateKeyStore.resolve(context, entry.privateKeyAlias))).pkcs8Bytes)))
    }

    @Test fun generateExportAndSign(): Unit = runBlocking {
        val fixture = TransferFixture()
        try {
            val target = fixture.mdbx()
            val proofs = JSONArray()
            for (algorithm in listOf(-7, -257)) {
                lateinit var creator: PasskeyCreateActivity
                InstrumentationRegistry.getInstrumentation().runOnMainSync { creator = PasskeyCreateActivity() }
                val pair = PasskeyCreateActivity::class.java.getDeclaredMethod("generateKeyPairForAlgorithm", Int::class.javaPrimitiveType)
                    .apply { isAccessible = true }.invoke(creator, algorithm) as KeyPair
                val cose = PasskeyCreateActivity::class.java.getDeclaredMethod("createCosePublicKeyFromKeyPair", KeyPair::class.java, Int::class.javaPrimitiveType)
                    .apply { isAccessible = true }.invoke(creator, pair, algorithm) as ByteArray
                val entry = PasskeyEntry(credentialId = url64(UUID.randomUUID().toString().toByteArray()), rpId = "passkey-interop.example.test",
                    rpName = "${fixture.prefix}-$algorithm", userId = url64(byteArrayOf(0, 1, 2, -1)), userName = "android-$algorithm@example.test",
                    userDisplayName = "Android generated $algorithm", publicKeyAlgorithm = algorithm, publicKey = b64(cose),
                    privateKeyAlias = b64(pair.private.encoded), signCount = 0, isBackedUp = algorithm == -257,
                    mdbxDatabaseId = target.databaseId)
                fixture.passkeys.savePasskey(entry)
                val stored = fixture.db.passkeyDao().getAllPasskeysSync().single { it.credentialId == entry.credentialId && it.mdbxDatabaseId == target.databaseId }
                assertTrue(PasskeyPrivateKeyStore.isProtectedReference(stored.privateKeyAlias))
                assertNotEquals(entry.privateKeyAlias, stored.privateKeyAlias)
                val proof = signedProof(stored).put("spki", b64(pair.public.encoded)).put("cose", b64(cose))
                val signed = Base64.getDecoder().decode(proof.getString("authenticatorData")) + sha(Base64.getDecoder().decode(proof.getString("clientDataJSON")))
                assertTrue(Signature.getInstance(if (algorithm == -7) "SHA256withECDSA" else "SHA256withRSA")
                    .apply { initVerify(pair.public); update(signed) }.verify(Base64.getDecoder().decode(proof.getString("signature"))))
                proofs.put(proof)
            }
            Mdbx2NativeReadSessions.clear()
            val file = requireNotNull(fixture.db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
            backup(file, "android-passkeys.mdbx")
            File(output, "android-signatures.json").writeText(JSONObject().put("synthetic", true)
                .put("scope", "actual Activity crypto methods and repository/protected-storage export; no Credential Manager or biometric UI")
                .put("proofs", proofs).toString(2))
        } finally { fixture.close() }
    }

    @Test fun importAndSignReturnedKeys(): Unit = runBlocking {
        val fixture = TransferFixture()
        var createdDatabaseId: Long? = null
        try {
            val source = File(output, "extension-passkeys.mdbx")
            assertTrue(source.isFile)
            val target = fixture.mdbx()
            createdDatabaseId = target.databaseId
            Mdbx2NativeReadSessions.clear()
            val path = requireNotNull(fixture.db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
            openVault(source.absolutePath, password, "extension-passkey-import").use { vault ->
                // This path is the newly created empty fixture-owned vault only.
                check(File(path).delete()); vault.createBackup(path)
            }
            val model = MdbxViewModel(context.applicationContext as android.app.Application, fixture.db.localMdbxDatabaseDao(),
                fixture.db.mdbxRemoteSourceDao(), fixture.db.passwordEntryDao(), fixture.db.secureItemDao(), fixture.db.passkeyDao(),
                fixture.db.attachmentDao(), fixture.db.customFieldDao(), fixture.security)
            try {
                model.syncVault(target.databaseId)
                val state = withTimeout(45_000) { model.operationState.first { it is MdbxViewModel.OperationState.Success || it is MdbxViewModel.OperationState.Error } }
                assertTrue(state.toString(), state is MdbxViewModel.OperationState.Success)
            } finally { model.viewModelScope.cancel() }
            val imported = fixture.db.passkeyDao().getAllPasskeysSync().filter { it.mdbxDatabaseId == target.databaseId }
            assertTrue("Expected at least the two Android-created keys", imported.size >= 2)
            val proofs = JSONArray()
            for (entry in imported) {
                assertTrue(PasskeyPrivateKeyStore.isProtectedReference(entry.privateKeyAlias))
                proofs.put(signedProof(entry))
            }
            File(output, "android-return-signatures.json").writeText(JSONObject().put("synthetic", true).put("proofs", proofs).toString(2))
            Mdbx2NativeReadSessions.clear()
            backup(path, "android-return-passkeys.mdbx")
        } finally {
            try {
                // Incoming titles need not match TransferFixture's new random prefix.
                if (createdDatabaseId != null) fixture.db.passkeyDao().getAllPasskeysSync()
                    .filter { it.mdbxDatabaseId == createdDatabaseId }.forEach { fixture.passkeys.deletePasskeyByRecordId(it.id) }
            } finally { fixture.close() }
        }
    }

    @Test fun importSignEditAndReturnBitwardenKey(): Unit = runBlocking {
        val inputFile = File(output, "bitwarden-passkey-input.json")
        val settings = JSONObject(inputFile.readText())
        require(settings.getBoolean("synthetic"))
        require(settings.getString("baseUrl") == "http://10.0.2.2:18316")
        require(Regex("passkey-[0-9a-f-]{36}@example\\.invalid").matches(settings.getString("email")))
        val expected = settings.getJSONObject("expected")
        val key = BitwardenCrypto.SymmetricCryptoKey(Base64.getDecoder().decode(settings.getString("vaultKeyEnc")),
            Base64.getDecoder().decode(settings.getString("vaultKeyMac")))
        val originalProxySelector = ProxySelector.getDefault()
        ProxySelector.setDefault(object : ProxySelector() {
            override fun select(uri: URI): MutableList<Proxy> =
                if (uri.host == "10.0.2.2" && uri.port == 18316) mutableListOf(Proxy.NO_PROXY)
                else (originalProxySelector?.select(uri) ?: listOf(Proxy.NO_PROXY)).toMutableList()
            override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) {
                originalProxySelector?.connectFailed(uri, address, error)
            }
        })
        val fixture = TransferFixture()
        val vaultIds = mutableSetOf<Long>()
        val client = OkHttpClient()
        val json = Json { ignoreUnknownKeys = true }
        val token = settings.getString("accessToken")
        fun download(): SyncResponse = client.newCall(Request.Builder()
            .url("${settings.getString("baseUrl")}/api/sync?excludeDomains=true")
            .header("Authorization", "Bearer $token").build()).execute().use {
                assertEquals("Synthetic Vaultwarden HTTP", 200, it.code)
                json.decodeFromString<SyncResponse>(requireNotNull(it.body).string())
            }
        try {
            val target = fixture.bitwarden(unlocked = false)
            vaultIds += target.databaseId
            fun stored(value: String) = b64(value.toByteArray())
            val vault = requireNotNull(fixture.db.bitwardenVaultDao().getVaultById(target.databaseId)).copy(
                serverUrl = settings.getString("baseUrl"), identityUrl = "${settings.getString("baseUrl")}/identity/",
                apiUrl = "${settings.getString("baseUrl")}/api/", encryptedAccessToken = stored(token),
                encryptedEncKey = stored(settings.getString("vaultKeyEnc")), encryptedMacKey = stored(settings.getString("vaultKeyMac")))
            fixture.db.bitwardenVaultDao().update(vault)
            val remote = download()
            assertEquals(settings.getString("email"), remote.profile.email)
            assertEquals(1, remote.ciphers.size)
            assertEquals(expected.getString("cipherId"), remote.ciphers.single().id)
            val processor = CipherSyncProcessor(context)
            assertTrue(processor.syncCipherFromServer(vault, remote.ciphers.single(), key) is CipherSyncResult.Added)
            suspend fun rows() = fixture.db.passkeyDao().getAllPasskeysSync().filter { it.bitwardenVaultId == vault.id }
            val entry = rows().single()
            assertEquals(expected.getString("credentialId"), PasskeyCredentialIdCodec.toWebAuthnId(entry.credentialId))
            assertEquals(expected.getString("rpId"), entry.rpId)
            assertEquals(expected.getString("userHandle"), entry.userId)
            assertEquals(expected.getString("userName"), entry.userName)
            assertEquals(expected.getString("userDisplayName"), entry.userDisplayName)
            assertEquals(-7, entry.publicKeyAlgorithm)
            assertEquals(0L, entry.signCount)
            assertEquals(PasskeyEntry.MODE_BW_COMPAT, entry.passkeyMode)
            assertTrue(PasskeyPrivateKeyStore.isProtectedReference(entry.privateKeyAlias))
            val proof = signedProof(entry)
            assertEquals(expected.getString("keyMaterialSha256"), proof.getString("keyMaterialSha256"))
            fixture.passkeys.updatePasskey(entry.copy(notes = "Android Bitwarden signature return"))
            assertEquals("PENDING", rows().single().syncStatus)
            val upload = BitwardenSyncService(context).uploadModifiedEntries(vault, token, key)
            assertTrue(upload.toString(), upload is UploadResult.Success)
            upload as UploadResult.Success
            assertEquals(1, upload.uploaded)
            assertEquals(0, upload.failed)
            val returned = download()
            assertEquals(1, returned.ciphers.size)
            assertEquals(expected.getString("cipherId"), returned.ciphers.single().id)
            // A separate empty vault also excludes the parent Login's revision cache.
            val freshTarget = fixture.bitwarden(unlocked = false)
            vaultIds += freshTarget.databaseId
            val freshVault = requireNotNull(fixture.db.bitwardenVaultDao().getVaultById(freshTarget.databaseId)).copy(
                serverUrl = vault.serverUrl, identityUrl = vault.identityUrl, apiUrl = vault.apiUrl,
                encryptedAccessToken = vault.encryptedAccessToken,
                encryptedEncKey = vault.encryptedEncKey, encryptedMacKey = vault.encryptedMacKey)
            fixture.db.bitwardenVaultDao().update(freshVault)
            assertTrue(fixture.db.passkeyDao().getAllPasskeysSync().none { it.bitwardenVaultId == freshVault.id })
            val freshResult = CipherSyncProcessor(context).syncCipherFromServer(freshVault, returned.ciphers.single(), key)
            assertTrue(freshResult.toString(), freshResult is CipherSyncResult.Added)
            val fresh = fixture.db.passkeyDao().getAllPasskeysSync().single { it.bitwardenVaultId == freshVault.id }
            assertNotEquals(entry.id, fresh.id)
            assertEquals(entry.credentialId, fresh.credentialId)
            assertEquals(entry.userId, fresh.userId)
            // Record the known Android mapper defect separately from credential usability.
            val editedNotes = "Android Bitwarden signature return"
            val noteSuffix = "\n\n🔐 This is a Passkey entry synced from Monica\nℹ️ Private key availability depends on client capability."
            assertEquals(editedNotes + noteSuffix, fresh.notes)
            assertEquals(expected.getString("keyMaterialSha256"), signedProof(fresh).getString("keyMaterialSha256"))
            File(output, "android-bitwarden-signatures.json").writeText(JSONObject().put("status", "passed")
                .put("scope", "actual Vaultwarden HTTP/CipherSyncProcessor/Room/protected key/crypto helpers/repository update/upload/fresh download; no Credential Manager UI")
                .put("interoperabilityComplete", false).put("notesPreserved", false)
                .put("notesGap", "Android PasskeyMapper appends notices and metadata to user notes")
                .put("editedNotes", editedNotes).put("freshNotes", fresh.notes)
                .put("cipherId", expected.getString("cipherId")).put("uploaded", upload.uploaded).put("failed", upload.failed)
                .put("proof", proof).put("freshProof", signedProof(fresh)).toString(2))
        } finally {
            try {
                fixture.db.passkeyDao().getAllPasskeysSync().filter { it.bitwardenVaultId in vaultIds }
                    .forEach { fixture.passkeys.deletePasskeyByRecordId(it.id) }
            } finally {
                fixture.close()
                key.clear()
                ProxySelector.setDefault(originalProxySelector)
                inputFile.delete()
            }
        }
    }

    @Test fun importSignEditAndReturnWebDavKeys(): Unit = runBlocking {
        val inputFile = File(output, "webdav-passkey-input.json")
        val settings = JSONObject(inputFile.readText())
        require(settings.getBoolean("synthetic"))
        require(settings.getString("baseUrl") == "http://10.0.2.2:18315")
        require(Regex("passkey-[0-9a-f-]{36}/vault\\.kdbx").matches(settings.getString("remotePath")))
        val originalProxySelector = ProxySelector.getDefault()
        ProxySelector.setDefault(object : ProxySelector() {
            override fun select(uri: URI): MutableList<Proxy> =
                if (uri.host == "10.0.2.2" && uri.port == 18315) mutableListOf(Proxy.NO_PROXY)
                else (originalProxySelector?.select(uri) ?: listOf(Proxy.NO_PROXY)).toMutableList()
            override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) {
                originalProxySelector?.connectFailed(uri, address, error)
            }
        })
        try {
            val remote = WebDavKeePassFileSource(settings.getString("baseUrl"), settings.getString("username"),
                settings.getString("password"), settings.getString("remotePath"), AppLocaleStringResolver(context))
            val before = remote.stat()
            assertNotNull("Actual Apache must provide a version", before.etag)
            val input = remote.read()
            val expected = JSONObject(File(output, "extension-passkeys-expected.json").readText())
            assertEquals(expected.getString("inputSha256"), sha(input).joinToString("") { "%02x".format(it) })
            File(output, "extension-passkeys.kdbx").writeBytes(input)
            importSignEditAndReturnKeePassKeys()
            val returned = File(output, "android-return-passkeys.kdbx").readBytes()
            val written = remote.write(returned, before.versionToken)
            assertArrayEquals(returned, remote.read())
            assertNotEquals(before.etag, written.etag)
            var staleRejected = false
            try { remote.write(input, before.versionToken) } catch (_: KeePassSourceChangedException) { staleRejected = true }
            assertTrue("Stale Android source writes must be rejected", staleRejected)
            assertArrayEquals(returned, remote.read())
            File(output, "android-webdav-transport.json").writeText(JSONObject().put("status", "passed")
                .put("source", "actual WebDavKeePassFileSource read/conditional write against isolated Apache")
                .put("inputSha256", expected.getString("inputSha256"))
                .put("outputSha256", sha(returned).joinToString("") { "%02x".format(it) })
                .put("beforeEtag", before.etag).put("afterEtag", written.etag).put("staleWriteRejected", staleRejected).toString(2))
        } finally {
            ProxySelector.setDefault(originalProxySelector)
            inputFile.delete()
        }
    }

    @Test fun importSignEditAndReturnKeePassKeys(): Unit = runBlocking {
        val fixture = TransferFixture()
        var databaseId: Long? = null
        try {
            val input = File(output, "extension-passkeys.kdbx")
            val expected = JSONObject(File(output, "extension-passkeys-expected.json").readText())
            assertTrue(expected.getBoolean("synthetic"))
            assertEquals(expected.getString("inputSha256"), sha(input.readBytes()).joinToString("") { "%02x".format(it) })
            val target = fixture.keepass()
            databaseId = target.databaseId
            // Only the newly created fixture-owned file is replaced; no user database is opened.
            input.copyTo(fixture.keepassFile(target.databaseId), overwrite = true)
            val database = requireNotNull(fixture.db.localKeePassDatabaseDao().getDatabaseById(target.databaseId))
            fixture.db.localKeePassDatabaseDao().updateDatabase(database.copy(encryptedPassword = fixture.security.encryptData(expected.getString("password"))))
            KeePassKdbxService.invalidateProcessCache(target.databaseId)
            val service = KeePassKdbxService(context, fixture.db.localKeePassDatabaseDao(), fixture.security)
            val imported = service.readPasskeyEntries(target.databaseId).getOrThrow()
            val expectedKeys = expected.getJSONArray("passkeys")
            assertEquals(expectedKeys.length(), imported.size)
            fixture.passkeys.syncKeePassPasskeys(target.databaseId, imported)
            val stored = fixture.db.passkeyDao().getAllPasskeysSync().filter { it.keepassDatabaseId == target.databaseId }
            assertEquals(expectedKeys.length(), stored.size)
            val proofs = JSONArray()
            for (index in 0 until expectedKeys.length()) {
                val key = expectedKeys.getJSONObject(index)
                val entry = stored.single { it.credentialId == key.getString("credentialId") }
                assertEquals(key.getInt("algorithm"), entry.publicKeyAlgorithm)
                assertEquals(key.getString("rpId"), entry.rpId)
                assertEquals(key.getString("userHandle"), entry.userId)
                assertEquals(key.getString("userName"), entry.userName)
                assertEquals(key.getString("userDisplayName"), entry.userDisplayName)
                assertEquals(key.getLong("signCount"), entry.signCount)
                assertTrue(PasskeyPrivateKeyStore.isProtectedReference(entry.privateKeyAlias))
                val proof = signedProof(entry)
                assertEquals(key.getString("keyMaterialSha256"), proof.getString("keyMaterialSha256"))
                proofs.put(proof)
                service.updatePasskey(target.databaseId, entry.copy(notes = "Android KDBX signature return")).getOrThrow()
            }
            KeePassKdbxService.invalidateProcessCache(target.databaseId)
            val reopened = service.readPasskeyEntries(target.databaseId).getOrThrow()
            assertEquals(stored.map { it.credentialId }.sorted(), reopened.map { it.credentialId }.sorted())
            assertTrue(reopened.all { it.notes == "Android KDBX signature return" })
            fixture.keepassFile(target.databaseId).copyTo(File(output, "android-return-passkeys.kdbx"), overwrite = true)
            File(output, "android-kdbx-signatures.json").writeText(JSONObject().put("synthetic", true)
                .put("scope", "actual KeePassKdbxService, protected Room projection and Activity crypto helpers; no Microsoft or Credential Manager UI")
                .put("proofs", proofs).put("inputSha256", expected.getString("inputSha256")).toString(2))
        } finally {
            try {
                if (databaseId != null) fixture.db.passkeyDao().getAllPasskeysSync()
                    .filter { it.keepassDatabaseId == databaseId }.forEach { fixture.passkeys.deletePasskeyByRecordId(it.id) }
            } finally { fixture.close() }
        }
    }

    private fun backup(source: String, name: String) {
        val destination = File(output, name)
        if (destination.exists()) check(destination.renameTo(File(output, "previous-${System.nanoTime()}-$name")))
        openVault(source, password, "extension-passkey-backup").use { it.createBackup(destination.absolutePath) }
    }
}
