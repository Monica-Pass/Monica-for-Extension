package takagi.ru.monica.credentialexchange

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.IOException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
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
import takagi.ru.monica.data.LocalKeePassDatabase
import takagi.ru.monica.data.PasskeyEntry
import takagi.ru.monica.data.PasswordDatabase
import takagi.ru.monica.data.bitwarden.BitwardenVault
import takagi.ru.monica.passkey.PasskeyCredentialIdCodec
import takagi.ru.monica.passkey.PasskeyPrivateKeyStore
import takagi.ru.monica.passkey.PasskeyPrivateKeySupport
import takagi.ru.monica.repository.PasskeyRepository
import takagi.ru.monica.security.SecurityManager
import takagi.ru.monica.security.SessionManager
import takagi.ru.monica.utils.AppLocaleStringResolver
import takagi.ru.monica.utils.KeePassKdbxService
import takagi.ru.monica.utils.WebDavKeePassFileSource

/** Import only. The separately signed RP and real master-password UI perform all authentication.
 * A fresh installation is mandatory; the device journal owns removal of this synthetic installation.
 * Finish instrumentation before launching the RP, so test process/session state cannot grant UV.
 */
@RunWith(AndroidJUnit4::class)
class ExtensionSystemBackendCredentialInteropTest {
    @Test fun seedBackendKeysForSystemCredentialManager(): Unit = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val output = File(context.filesDir, "extension-credential-manager-317")
        val configFile = File(output, "backend-config.json")
        val config = JSONObject(configFile.readText())
        require(config.getBoolean("syntheticFreshInstallation"))
        val db = PasswordDatabase.getDatabase(context)
        val security = SecurityManager(context)
        assertFalse("Never replace an existing master password", security.isMasterPasswordSet())
        assertTrue("Never seed into existing credential storage", db.passkeyDao().getAllPasskeysSync().isEmpty())
        assertTrue(security.setMasterPassword("31724680"))
        val repository = PasskeyRepository(db.passkeyDao(), context = context)
        val records = JSONArray()
        fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
        fun hex(bytes: ByteArray) = sha(bytes).joinToString("") { "%02x".format(it) }
        fun record(tag: String, entry: PasskeyEntry, expected: JSONObject): JSONObject {
            val id = PasskeyCredentialIdCodec.toWebAuthnId(entry.credentialId)
            assertEquals(expected.getString("credentialId"), id)
            assertEquals(expected.getString("rpId"), entry.rpId)
            assertEquals(expected.getString("userHandle"), entry.userId)
            assertEquals(expected.getString("userName"), entry.userName)
            assertEquals(expected.getString("userDisplayName"), entry.userDisplayName)
            assertEquals(expected.getInt("algorithm"), entry.publicKeyAlgorithm)
            assertEquals(expected.getLong("signCount"), entry.signCount)
            assertTrue(PasskeyPrivateKeyStore.isProtectedReference(entry.privateKeyAlias))
            val material = requireNotNull(PasskeyPrivateKeySupport.decodeFlexiblePrivateKey(
                PasskeyPrivateKeyStore.resolve(context, entry.privateKeyAlias)))
            assertEquals(expected.getString("keyMaterialSha256"), Base64.getEncoder().encodeToString(sha(material.pkcs8Bytes)))
            return JSONObject().put("tag", tag).put("credentialId", id).put("recordId", entry.id)
                .put("rpId", entry.rpId).put("userHandle", entry.userId).put("userName", entry.userName)
                .put("algorithm", entry.publicKeyAlgorithm).put("signCount", entry.signCount)
                .put("isBackedUp", entry.isBackedUp).put("useCount", entry.useCount).put("protectedKey", true)
                .put("keepassDatabaseId", entry.keepassDatabaseId).put("bitwardenVaultId", entry.bitwardenVaultId)
        }
        val previousProxy = ProxySelector.getDefault()
        ProxySelector.setDefault(object : ProxySelector() {
            override fun select(uri: URI): MutableList<Proxy> =
                if (uri.host == "10.0.2.2" && uri.port in listOf(18315, 18316)) mutableListOf(Proxy.NO_PROXY)
                else (previousProxy?.select(uri) ?: listOf(Proxy.NO_PROXY)).toMutableList()
            override fun connectFailed(uri: URI, address: SocketAddress, error: IOException) {
                previousProxy?.connectFailed(uri, address, error)
            }
        })
        val client = OkHttpClient()
        try {
            for (tag in listOf("kdbx", "webdav")) {
                val source = config.getJSONObject(tag)
                val bytes = if (tag == "kdbx") File(output, "edge-local.kdbx").readBytes() else {
                    require(source.getString("baseUrl") == "http://10.0.2.2:18315")
                    require(Regex("passkey-[0-9a-f-]{36}/vault\\.kdbx").matches(source.getString("remotePath")))
                    val remote = WebDavKeePassFileSource(source.getString("baseUrl"), source.getString("username"),
                        source.getString("password"), source.getString("remotePath"), AppLocaleStringResolver(context))
                    assertNotNull(remote.stat().etag)
                    remote.read()
                }
                assertEquals(source.getString("inputSha256"), hex(bytes))
                val file = File(output, "imported-$tag.kdbx")
                assertFalse(file.exists())
                file.writeBytes(bytes)
                val id = db.localKeePassDatabaseDao().insertDatabase(LocalKeePassDatabase(name = "CM317-$tag",
                    filePath = file.relativeTo(context.filesDir).path,
                    encryptedPassword = security.encryptData(source.getString("databasePassword"))))
                val service = KeePassKdbxService(context, db.localKeePassDatabaseDao(), security)
                val imported = service.readPasskeyEntries(id).getOrThrow()
                assertEquals(1, imported.size)
                repository.syncKeePassPasskeys(id, imported)
                val stored = db.passkeyDao().getAllPasskeysSync().single { it.keepassDatabaseId == id }
                records.put(record(tag, stored, source.getJSONObject("expected")).put("inputSha256", hex(bytes)))
                KeePassKdbxService.invalidateProcessCache(id)
            }
            val source = config.getJSONObject("bitwarden")
            require(source.getString("baseUrl") == "http://10.0.2.2:18316")
            require(Regex("passkey-[0-9a-f-]{36}@example\\.invalid").matches(source.getString("email")))
            val key = BitwardenCrypto.SymmetricCryptoKey(Base64.getDecoder().decode(source.getString("vaultKeyEnc")),
                Base64.getDecoder().decode(source.getString("vaultKeyMac")))
            try {
                val body = client.newCall(Request.Builder().url("${source.getString("baseUrl")}/api/sync?excludeDomains=true")
                    .header("Authorization", "Bearer ${source.getString("accessToken")}").build()).execute().use {
                    assertEquals(200, it.code)
                    requireNotNull(it.body).string()
                }
                val remote = Json { ignoreUnknownKeys = true }.decodeFromString<SyncResponse>(body)
                assertEquals(source.getString("email"), remote.profile.email)
                assertEquals(1, remote.ciphers.size)
                assertEquals(source.getJSONObject("expected").getString("cipherId"), remote.ciphers.single().id)
                // No stored token or long-lived server key is needed by this read-only seed.
                val id = db.bitwardenVaultDao().insert(BitwardenVault(email = remote.profile.email,
                    canonicalEmail = remote.profile.email, accountKey = "cm317-${remote.profile.id}",
                    serverUrl = source.getString("baseUrl"), displayName = "CM317-Bitwarden", syncEnabled = false))
                val vault = requireNotNull(db.bitwardenVaultDao().getVaultById(id))
                assertTrue(CipherSyncProcessor(context).syncCipherFromServer(vault, remote.ciphers.single(), key) is CipherSyncResult.Added)
                records.put(record("bitwarden", db.passkeyDao().getAllPasskeysSync().single { it.bitwardenVaultId == id },
                    source.getJSONObject("expected")))
            } finally { key.clear() }
            assertEquals(3, db.passkeyDao().getAllPasskeysSync().size)
            File(output, "ready.json").writeText(JSONObject().put("synthetic", true)
                .put("scope", "Production backend import only; instrumentation ends before platform RP authentication")
                .put("records", records).toString(2))
        } finally {
            SessionManager.markLocked()
            ProxySelector.setDefault(previousProxy)
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
            check(configFile.delete())
        }
    }
}
