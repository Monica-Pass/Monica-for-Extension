package takagi.ru.monica.credentialexchange

import android.graphics.Bitmap
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.viewModelScope
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import takagi.ru.monica.data.LocalMdbxDatabase
import takagi.ru.monica.repository.CustomFieldRepository
import takagi.ru.monica.repository.Mdbx2NativeReadSessions
import takagi.ru.monica.ui.LocalUiSecurityManager
import takagi.ru.monica.ui.screens.AddEditPasswordInitialDraft
import takagi.ru.monica.ui.screens.AddEditPasswordScreen
import takagi.ru.monica.ui.screens.PasswordDetailScreen
import takagi.ru.monica.utils.AppLocaleStringResolver
import takagi.ru.monica.viewmodel.PasswordViewModel
import takagi.ru.monica.viewmodel.MdbxViewModel
import uniffi.mdbx_ffi.openVault

/** Real Compose editor -> application ViewModel -> native MDBX -> detail screen. */
class ExtensionAndroid315UiTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var fixture: TransferFixture
    private lateinit var model: PasswordViewModel
    private lateinit var database: LocalMdbxDatabase
    private var saved: Long? = null
    private var detail by mutableStateOf(false)
    private lateinit var focusManager: FocusManager

    @Before fun setup() = runBlocking {
        fixture = TransferFixture()
        val target = fixture.mdbx()
        database = requireNotNull(fixture.db.localMdbxDatabaseDao().getDatabaseById(target.databaseId))
        model = PasswordViewModel(fixture.passwords, fixture.security,
            customFieldRepository = CustomFieldRepository(fixture.db.customFieldDao()), context = fixture.context,
            localKeePassDatabaseDao = fixture.db.localKeePassDatabaseDao(), strings = AppLocaleStringResolver(fixture.context))
    }
    @After fun cleanup() = runBlocking { model.viewModelScope.cancel(); fixture.close() }

    @Test fun createNativeLoginInAndroidUiAndReopenDetails() {
        val title = "${fixture.prefix}-android-ui"
        val directory = File(fixture.context.filesDir, "extension-interop-315").apply { mkdirs() }
        File(directory, "ui-fixture-prefix.txt").writeText(fixture.prefix)
        compose.setContent {
            focusManager = LocalFocusManager.current
            CompositionLocalProvider(LocalUiSecurityManager provides fixture.security) { MaterialTheme {
                if (detail) PasswordDetailScreen(model, passwordId = requireNotNull(saved), biometricEnabled = false,
                    onNavigateBack = {}, onEditPassword = {})
                else AddEditPasswordScreen(model, passwordId = null, initialStorageExplicit = true,
                    initialMdbxDatabaseId = database.id, mdbxDatabasesFallback = listOf(database),
                    initialDraft = AddEditPasswordInitialDraft(title = title, username = "android-ui-initial", password = "synthetic-ui-secret",
                        website = "https://android-ui.example.invalid"), onSaveCompleted = { saved = it }, onNavigateBack = {})
            } }
        }
        compose.onNode(hasSetTextAction() and hasText("android-ui-initial")).performTextReplacement("android-ui-edited-用户")
        compose.runOnIdle { focusManager.clearFocus(force = true) }
        compose.onNodeWithTag("password_editor_save").performClick()
        compose.waitUntil(45_000) { saved != null }
        runBlocking {
            Mdbx2NativeReadSessions.clear()
            val record = fixture.mdbx.readStoredEntries(database.id).single { !it.deleted }
            assertEquals("android-ui-edited-用户", JSONObject(record.payloadJson).getString("username"))
            File(directory, "android-ui-record.json").writeText(JSONObject().put("entryId", record.entryId)
                .put("title", record.title).put("payloadJson", record.payloadJson).toString(2))
            openVault(database.filePath, "Synthetic transfer fixture password", "android-ui-export-315").use {
                val destination = File(directory, "android-ui.mdbx")
                if (destination.exists()) check(destination.renameTo(File(directory, "previous-${System.nanoTime()}-android-ui.mdbx")))
                it.createBackup(destination.absolutePath)
            }
        }
        compose.runOnIdle { detail = true }
        compose.onAllNodesWithText(title).onFirst().assertExists()
        compose.onAllNodes(isRoot()).onLast().captureToImage().asAndroidBitmap().let { image ->
            File(directory, "android-ui-details.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
    }

    @Test fun reopenEdgeEditedVaultAndEditAgainInAndroidUi() = runBlocking {
        val directory = File(fixture.context.filesDir, "extension-interop-315")
        val incoming = File(directory, "edge-ui-return.mdbx")
        require(incoming.isFile) { "Push the actual Edge UI edited fixture first" }
        Mdbx2NativeReadSessions.clear()
        openVault(incoming.absolutePath, "Synthetic transfer fixture password", "edge-ui-incoming-315").use {
            File(database.filePath).delete() // Only this test's newly-created empty synthetic vault.
            it.createBackup(database.filePath)
        }
        val manager = MdbxViewModel(fixture.context.applicationContext as android.app.Application,
            fixture.db.localMdbxDatabaseDao(), fixture.db.mdbxRemoteSourceDao(), fixture.db.passwordEntryDao(),
            fixture.db.secureItemDao(), fixture.db.passkeyDao(), fixture.db.attachmentDao(), fixture.db.customFieldDao(), fixture.security)
        try {
            manager.syncVault(database.id)
            val state = withTimeout(45_000) { manager.operationState.first {
                it is MdbxViewModel.OperationState.Success || it is MdbxViewModel.OperationState.Error
            } }
            assertTrue(state.toString(), state is MdbxViewModel.OperationState.Success)
        } finally { manager.viewModelScope.cancel() }
        val entry = fixture.db.passwordEntryDao().getAllPasswordEntriesSync().single { it.mdbxDatabaseId == database.id }
        saved = entry.id
        detail = true
        compose.setContent {
            focusManager = LocalFocusManager.current
            CompositionLocalProvider(LocalUiSecurityManager provides fixture.security) { MaterialTheme {
                if (detail) PasswordDetailScreen(model, passwordId = entry.id, biometricEnabled = false,
                    onNavigateBack = {}, onEditPassword = {})
                else AddEditPasswordScreen(model, passwordId = entry.id, initialStorageExplicit = true,
                    initialMdbxDatabaseId = database.id, mdbxDatabasesFallback = listOf(database),
                    onSaveCompleted = { saved = it }, onNavigateBack = {})
            } }
        }
        compose.onAllNodesWithText(entry.title).onFirst().assertExists()
        compose.runOnIdle { detail = false; saved = null }
        val editedUsername = "${entry.username} · Android UI return"
        compose.onNode(hasSetTextAction() and hasText(entry.username)).performTextReplacement(editedUsername)
        compose.runOnIdle { focusManager.clearFocus(force = true) }
        compose.onNodeWithTag("password_editor_save").performClick()
        compose.waitUntil(45_000) { saved != null }
        Mdbx2NativeReadSessions.clear()
        val record = fixture.mdbx.readStoredEntries(database.id).single { !it.deleted }
        assertEquals(editedUsername, JSONObject(record.payloadJson).getString("username"))
        File(directory, "android-edge-ui-return.json").writeText(JSONObject().put("entryId", record.entryId)
            .put("edgeReadUsername", entry.username).put("title", record.title).put("payloadJson", record.payloadJson).toString(2))
        openVault(database.filePath, "Synthetic transfer fixture password", "android-edge-ui-return-315").use {
            val destination = File(directory, "android-edge-ui-return.mdbx")
            if (destination.exists()) check(destination.renameTo(File(directory, "previous-${System.nanoTime()}-android-edge-ui-return.mdbx")))
            it.createBackup(destination.absolutePath)
        }
        compose.runOnIdle { detail = true }
        compose.onAllNodesWithText(entry.title).onFirst().assertExists()
        compose.onAllNodes(isRoot()).onLast().captureToImage().asAndroidBitmap().let { bitmap ->
            File(directory, "android-edge-ui-return.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        }
        Unit
    }
}
