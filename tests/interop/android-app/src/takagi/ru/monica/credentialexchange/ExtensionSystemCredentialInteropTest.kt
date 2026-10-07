package takagi.ru.monica.credentialexchange

import android.app.Application
import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import takagi.ru.monica.passkey.PasskeyPrivateKeyStore
import takagi.ru.monica.repository.Mdbx2NativeReadSessions
import takagi.ru.monica.viewmodel.MdbxViewModel
import uniffi.mdbx_ffi.openVault

/** Seeds only an isolated fresh installation. The separate RP drives the real system/UI path. */
@RunWith(AndroidJUnit4::class)
class ExtensionSystemCredentialInteropTest {
    @Test fun importedKeysThroughSystemCredentialManager(): Unit = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val output = File(context.filesDir, "extension-credential-manager-317")
        val input = File(output, "extension-passkeys.mdbx")
        val config = JSONObject(File(output, "config.json").readText())
        require(config.getBoolean("syntheticFreshInstallation"))
        val sourceHash = MessageDigest.getInstance("SHA-256").digest(input.readBytes()).joinToString("") { "%02x".format(it) }
        assertEquals(config.getString("inputSha256"), sourceHash)
        val fixture = TransferFixture()
        var targetId: Long? = null
        try {
            // Never overwrite an existing master password or a user's records.
            assertFalse(fixture.security.isMasterPasswordSet())
            assertTrue(fixture.db.passkeyDao().getAllPasskeysSync().isEmpty())
            assertTrue(fixture.security.setMasterPassword("SyntheticCM317Password"))
            val target = fixture.mdbx()
            targetId = target.databaseId
            Mdbx2NativeReadSessions.clear()
            val path = requireNotNull(fixture.db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
            openVault(input.absolutePath, "Synthetic transfer fixture password", "system-cm-import").use { vault ->
                check(File(path).delete()) // Newly created empty fixture vault, never a pre-existing file.
                vault.createBackup(path)
            }
            val model = MdbxViewModel(context.applicationContext as Application, fixture.db.localMdbxDatabaseDao(),
                fixture.db.mdbxRemoteSourceDao(), fixture.db.passwordEntryDao(), fixture.db.secureItemDao(), fixture.db.passkeyDao(),
                fixture.db.attachmentDao(), fixture.db.customFieldDao(), fixture.security)
            try {
                model.syncVault(target.databaseId)
                val state = withTimeout(45_000) { model.operationState.first { it is MdbxViewModel.OperationState.Success || it is MdbxViewModel.OperationState.Error } }
                assertTrue(state.toString(), state is MdbxViewModel.OperationState.Success)
            } finally { model.viewModelScope.cancel() }

            suspend fun snapshot(): JSONObject {
                val rows = fixture.db.passkeyDao().getAllPasskeysSync().filter { it.mdbxDatabaseId == target.databaseId }
                assertEquals(5, rows.size)
                return JSONObject().put("synthetic", true).put("inputSha256", sourceHash).put("records", JSONArray().apply {
                    rows.forEach { row ->
                        assertTrue(PasskeyPrivateKeyStore.isProtectedReference(row.privateKeyAlias))
                        put(JSONObject().put("credentialId", row.credentialId).put("recordId", row.id)
                            .put("rpId", row.rpId).put("userName", row.userName).put("userHandle", row.userId)
                            .put("algorithm", row.publicKeyAlgorithm).put("signCount", row.signCount)
                            .put("isBackedUp", row.isBackedUp).put("useCount", row.useCount)
                            .put("protectedKey", true))
                    }
                })
            }
            File(output, "ready.json").writeText(snapshot().toString(2))
            // Test runner observes real UI and signals completion. No signing helpers/reflection here.
            withTimeout(1_200_000) {
                while (!File(output, "finish").exists()) {
                    if (File(output, "snapshot-request").exists()) {
                        File(output, "storage.json").writeText(snapshot().toString(2))
                        check(File(output, "snapshot-request").delete())
                    }
                    delay(250)
                }
            }
            File(output, "storage-final.json").writeText(snapshot().toString(2))
        } finally {
            try {
                targetId?.let { id -> fixture.db.passkeyDao().getAllPasskeysSync().filter { it.mdbxDatabaseId == id }
                    .forEach { fixture.passkeys.deletePasskeyByRecordId(it.id) } }
            } finally {
                fixture.close()
                File(output, "fixture-cleanup.json").writeText(JSONObject().put("complete", true).toString())
            }
        }
    }
}
