package takagi.ru.monica.credentialexchange

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.Proxy
import java.net.ProxySelector
import java.net.URI
import java.net.SocketAddress
import java.io.IOException
import java.security.MessageDigest
import java.util.Base64
import kotlinx.coroutines.runBlocking
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
import takagi.ru.monica.bitwarden.service.CipherSyncProcessor
import takagi.ru.monica.bitwarden.service.CipherSyncResult
import takagi.ru.monica.bitwarden.service.BitwardenSyncService
import takagi.ru.monica.bitwarden.service.UploadResult
import takagi.ru.monica.data.PasskeyEntry
import takagi.ru.monica.data.PasswordDatabase
import takagi.ru.monica.data.bitwarden.BitwardenVault
import takagi.ru.monica.passkey.PasskeyCredentialIdCodec
import takagi.ru.monica.passkey.PasskeyPrivateKeyStore
import takagi.ru.monica.passkey.PasskeyPrivateKeySupport
import takagi.ru.monica.repository.PasskeyRepository
import takagi.ru.monica.security.SecurityManager
import takagi.ru.monica.security.SessionManager

/** Synthetic fresh install only. Real server/production sync; no signing helpers or UV injection. */
@RunWith(AndroidJUnit4::class)
class ExtensionPasskeyRepairAcceptanceTest {
    @Test fun roundtripLegacyBitwardenAndSeedSystem(): Unit = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val output = File(context.filesDir, "extension-credential-manager-317")
        val input = File(output, "repair-config.json")
        val config = JSONObject(input.readText())
        require(config.getBoolean("syntheticFreshInstallation"))
        require(config.getString("baseUrl") == "http://10.0.2.2:18316")
        require(Regex("passkey-[0-9a-f-]{36}@example\\.invalid").matches(config.getString("email")))
        val expected = config.getJSONObject("expected")
        val db = PasswordDatabase.getDatabase(context)
        val security = SecurityManager(context)
        assertFalse("Never replace an existing vault", security.isMasterPasswordSet())
        assertTrue(db.passkeyDao().getAllPasskeysSync().isEmpty())
        assertTrue(security.setMasterPassword("31724680"))
        val repository = PasskeyRepository(db.passkeyDao(), context = context)
        val key = BitwardenCrypto.SymmetricCryptoKey(Base64.getDecoder().decode(config.getString("vaultKeyEnc")),
            Base64.getDecoder().decode(config.getString("vaultKeyMac")))
        val token = config.getString("accessToken")
        val previousProxy = ProxySelector.getDefault()
        ProxySelector.setDefault(object : ProxySelector() {
            override fun select(uri: URI): MutableList<Proxy> = if (uri.host == "10.0.2.2" && uri.port == 18316)
                mutableListOf(Proxy.NO_PROXY) else (previousProxy?.select(uri) ?: listOf(Proxy.NO_PROXY)).toMutableList()
            override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) {
                previousProxy?.connectFailed(uri, address, error)
            }
        })
        val client = OkHttpClient()
        val cycles = JSONArray()
        fun digest(bytes: ByteArray) = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes))
        fun checkIdentity(entry: PasskeyEntry) {
            assertEquals(expected.getString("credentialId"), PasskeyCredentialIdCodec.toWebAuthnId(entry.credentialId))
            assertEquals(32, Base64.getUrlDecoder().decode(PasskeyCredentialIdCodec.toWebAuthnId(entry.credentialId)).size)
            assertEquals(expected.getString("rpId"), entry.rpId)
            assertEquals(expected.getString("userHandle"), entry.userId)
            assertEquals(expected.getString("userName"), entry.userName)
            assertEquals(expected.getString("userDisplayName"), entry.userDisplayName)
            assertEquals(-7, entry.publicKeyAlgorithm)
            assertEquals(0L, entry.signCount)
            assertTrue(PasskeyPrivateKeyStore.isProtectedReference(entry.privateKeyAlias))
            val material = requireNotNull(PasskeyPrivateKeySupport.decodeFlexiblePrivateKey(
                PasskeyPrivateKeyStore.resolve(context, entry.privateKeyAlias)))
            assertEquals(expected.getString("keyMaterialSha256"), digest(material.pkcs8Bytes))
        }
        fun download(): SyncResponse = client.newCall(Request.Builder()
            .url(config.getString("baseUrl") + "/api/sync?excludeDomains=true")
            .header("Authorization", "Bearer $token").build()).execute().use {
            assertEquals(200, it.code)
            Json { ignoreUnknownKeys = true }.decodeFromString<SyncResponse>(requireNotNull(it.body).string()).also { remote ->
                assertEquals(config.getString("email"), remote.profile.email)
                assertEquals(1, remote.ciphers.size)
                assertEquals(expected.getString("cipherId"), remote.ciphers.single().id)
            }
        }
        suspend fun freshVault(index: Int): BitwardenVault {
            val id = db.bitwardenVaultDao().insert(BitwardenVault(email = config.getString("email"),
                canonicalEmail = config.getString("email"), accountKey = "repair317-$index",
                serverUrl = config.getString("baseUrl"), identityUrl = config.getString("baseUrl") + "/identity/",
                apiUrl = config.getString("baseUrl") + "/api/", displayName = "Repair317-$index", syncEnabled = false))
            return requireNotNull(db.bitwardenVaultDao().getVaultById(id))
        }
        suspend fun row(vault: BitwardenVault) = db.passkeyDao().getAllPasskeysSync().single { it.bitwardenVaultId == vault.id }
        try {
            var vault = freshVault(0)
            assertTrue(CipherSyncProcessor(context).syncCipherFromServer(vault, download().ciphers.single(), key) is CipherSyncResult.Added)
            checkIdentity(row(vault))
            assertEquals(expected.getString("notes"), row(vault).notes)
            val notes = listOf("  保留正文\r\n---\n[Monica Passkey Metadata]\n不是完整历史尾注\t  ", "", "PRIVATE_NOTE_REPAIR_317\n---\n只属于备注的内容  ")
            for ((index, note) in notes.withIndex()) {
                val prior = row(vault)
                repository.updatePasskey(prior.copy(notes = note))
                assertEquals("PENDING", row(vault).syncStatus)
                val upload = BitwardenSyncService(context).uploadModifiedEntries(vault, token, key)
                assertTrue(upload.toString(), upload is UploadResult.Success)
                upload as UploadResult.Success
                assertEquals(1, upload.uploaded)
                assertEquals(0, upload.failed)
                val fresh = freshVault(index + 1)
                assertTrue(CipherSyncProcessor(context).syncCipherFromServer(fresh, download().ciphers.single(), key) is CipherSyncResult.Added)
                val returned = row(fresh)
                checkIdentity(returned)
                assertEquals("Exact notes after real upload/fresh import", note, returned.notes)
                assertNotEquals(prior.id, returned.id)
                cycles.put(JSONObject().put("index", index).put("notes", returned.notes).put("sameKeyAndId", true)
                    .put("uploaded", upload.uploaded).put("freshRecordId", returned.id))
                // Remove only the obsolete synthetic local projection; never send a remote deletion.
                db.passkeyDao().deleteByRecordId(prior.id)
                vault = fresh
            }
            val final = row(vault)
            assertEquals(1, db.passkeyDao().getAllPasskeysSync().size)
            File(output, "repair-roundtrip.json").writeText(JSONObject().put("status", "passed")
                .put("scope", "Real Vaultwarden HTTP + production import/update/upload/fresh import, system authentication follows separately")
                .put("cycles", cycles).put("credentialId", expected.getString("credentialId"))
                .put("keyMaterialSha256", expected.getString("keyMaterialSha256")).toString(2))
            File(output, "ready.json").writeText(JSONObject().put("synthetic", true).put("records", JSONArray().put(
                JSONObject().put("tag", "bitwarden32").put("recordId", final.id)
                    .put("credentialId", PasskeyCredentialIdCodec.toWebAuthnId(final.credentialId))
                    .put("rpId", final.rpId).put("userHandle", final.userId).put("userName", final.userName)
                    .put("userDisplayName", final.userDisplayName).put("notes", final.notes).put("signCount", final.signCount)
                    .put("useCount", final.useCount).put("bitwardenVaultId", final.bitwardenVaultId)
            )).toString(2))
        } finally {
            SessionManager.markLocked()
            key.clear()
            ProxySelector.setDefault(previousProxy)
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
            check(input.delete())
        }
    }
}
