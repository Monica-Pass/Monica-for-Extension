package takagi.ru.monica.credentialexchange

import androidx.lifecycle.viewModelScope
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import takagi.ru.monica.attachments.AttachmentContainer
import takagi.ru.monica.attachments.facade.AttachmentFacade
import takagi.ru.monica.attachments.model.AttachmentOwner
import takagi.ru.monica.attachments.model.AttachmentSource
import takagi.ru.monica.data.*
import takagi.ru.monica.data.model.*
import takagi.ru.monica.repository.*
import takagi.ru.monica.utils.AppLocaleStringResolver
import takagi.ru.monica.utils.WebDavHelper
import takagi.ru.monica.viewmodel.MdbxViewModel
import takagi.ru.monica.viewmodel.PasswordViewModel
import uniffi.mdbx_ffi.*

/** App repository/ViewModel tests, not engine-only or UI coverage. Synthetic, isolated vaults only. */
@RunWith(AndroidJUnit4::class)
class ExtensionAndroid315InteropTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val output get() = File(context.filesDir, "extension-interop-315").apply { mkdirs() }
    private val fields = listOf(
        SecureCustomField("Recovery", "synthetic-恢复", SecureCustomFieldType.HIDDEN),
        SecureCustomField("Enabled", "true", SecureCustomFieldType.BOOLEAN),
        SecureCustomField("Future", "  preserved  ")
    )
    private val asset = "synthetic-wallet-attachment\nUnicode 文件 🔑\n".toByteArray()
    private val cardImage = java.util.Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=")
    private val card get() = BankCardData(cardNumber = "0000424242424242", cardholderName = "合成 ALICE", expiryMonth = "09", expiryYear = "2030",
        cvv = "007", bankName = "Synthetic Bank", cardType = CardType.DEBIT, billingAddress = "{\"streetAddress\":\"测试\"}",
        brand = "visa", nickname = "Synthetic card", validFromMonth = "01", validFromYear = "2025", pin = "0007",
        iban = "GB00SYNTHETIC001", swiftBic = "SYNTHETIC", routingNumber = "000001", accountNumber = "000002",
        branchCode = "0003", currency = "CNY", customerServicePhone = "+1 202 555 0100", customFields = fields,
        cardFace = CardFaceConfig("wallet-cardface-315", CardFaceDisplayMode.CARD_NUMBER_ONLY, false))
    private val note get() = NoteData(content = "# 完整笔记\n\n  preserve spaces  \n🔑", tags = listOf("合成", "interop"), isMarkdown = true, customFields = fields)

    private suspend fun <T> scenario(block: suspend TransferFixture.(PasswordViewModel) -> T): T {
        val fixture = TransferFixture()
        val model = PasswordViewModel(fixture.passwords, fixture.security,
            customFieldRepository = CustomFieldRepository(fixture.db.customFieldDao()), context = fixture.context,
            localKeePassDatabaseDao = fixture.db.localKeePassDatabaseDao(), strings = AppLocaleStringResolver(fixture.context))
        return try { fixture.block(model) } finally { model.viewModelScope.cancel(); fixture.close() }
    }

    private suspend fun save(model: PasswordViewModel, entry: PasswordEntry, target: StorageTarget,
        secrets: List<String> = listOf(entry.password), custom: List<CustomFieldDraft> = emptyList()): Long {
        val done = CompletableDeferred<Long?>()
        model.savePasswordsAcrossTargets(listOf(entry.id).filter { it > 0 }, entry, secrets, listOf(target), custom,
            onComplete = { done.complete(it) })
        return requireNotNull(withTimeout(45_000) { done.await() })
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

    @Test fun exportAndroidApplicationFixtures(): Unit = runBlocking {
        scenario { model ->
            val target = mdbx()
            val storage = StorageTarget.Mdbx(target.databaseId, null)
            val basic = PasswordEntry(title = "$prefix-independent", website = "https://one.example.invalid\nhttps://two.example.invalid",
                username = "用户", password = "synthetic-0007", appPackageName = "invalid.synthetic.app", appName = "合成应用",
                email = "test@example.invalid", phone = "00001", addressLine = "测试路 12", city = "City", state = "State", zipCode = "00007", country = "CN",
                notes = "Recovery codes: synthetic-only\n", creditCardNumber = "00001234", creditCardHolder = "ALICE", creditCardExpiry = "09/30", creditCardCVV = "007")
            save(model, basic, storage)
            save(model, basic.copy(password = "independent-second"), storage)
            var walletFields = listOf(
                CustomFieldDraft(title = "monica.content.order", value = "NOTES,PAYMENT,FUTURE,CONTACT,ADDRESS", isProtected = true),
                CustomFieldDraft(title = "monica.content.payment.pin", value = "0007", isProtected = true),
                CustomFieldDraft(title = "monica.content.future.metadata", value = "{\"counter\":9007199254740993,\"empty\":null}", isProtected = true),
                CustomFieldDraft(title = EmbeddedWalletContent.fieldName(EmbeddedWalletContent.Kind.BANK_CARD), value =
                    EmbeddedWalletContent.create(SecureItem(itemType = ItemType.BANK_CARD, title = "Full card copy", notes = "card note", itemData = Json.encodeToString(card)))
                        .withAssets(listOf(EmbeddedWalletContent.Asset("wallet-cardface-315", "synthetic.png", "image/png", EmbeddedWalletContent.AssetRole.CARD_FACE,
                            cardImage.size.toLong(), sha(cardImage)))).encode(), isProtected = true),
                CustomFieldDraft(title = EmbeddedWalletContent.fieldName(EmbeddedWalletContent.Kind.NOTE), value =
                    EmbeddedWalletContent.create(SecureItem(itemType = ItemType.NOTE, title = "Full note copy", notes = "note outer", itemData = Json.encodeToString(note)))
                        .withAssets(listOf(EmbeddedWalletContent.Asset("wallet-note-315", "note.txt", "text/plain", EmbeddedWalletContent.AssetRole.ATTACHMENT,
                            asset.size.toLong(), sha(asset)))).encode(), isProtected = true)
            )
            PasswordContentBlocks.Kind.entries.forEach { kind ->
                val block = PasswordContentBlocks.create(kind).edited("Synthetic $kind", PasswordContentBlocks.editableKeys(kind)
                    .associateWith { "synthetic-测试-$it\n".repeat(120) })
                walletFields = PasswordContentBlocks.put(walletFields, block)
            }
            val grouped = save(model, basic.copy(title = "$prefix-group", authenticatorKey = "otpauth://hotp/合成:user?secret=JBSWY3DPEHPK3PXP&counter=9007199254740993&digits=8&algorithm=SHA256",
                passkeyBindings = "[{\"credentialId\":\"metadata-only\",\"rpId\":\"example.invalid\"}]"), storage,
                listOf("group-first", "group-second", "group-third"), walletFields)
            val facade = AttachmentContainer.facade(context)
            for (name in listOf("wallet-cardface-315", "wallet-note-315")) facade.addInlineAttachment(AttachmentFacade.InlineUploadRequest(
                owner = AttachmentOwner.password(grouped), source = AttachmentSource.LOCAL, fileName = name,
                mimeType = if (name == "wallet-cardface-315") "image/png" else "text/plain",
                bytes = if (name == "wallet-cardface-315") cardImage else asset, isPlusActivated = true))
            facade.mirrorAttachmentsForPassword(grouped)

            val wifi = basic.copy(title = "$prefix-WIFI", loginType = "WIFI",
                wifiMetadata = WifiData(ssid = "Synthetic Enterprise", hiddenNetwork = true, security = WifiSecurity.WPA2_ENTERPRISE,
                    eap = WifiEapSettings(anonymousIdentity = "0007", domain = "example.invalid"),
                    proxy = WifiProxy.Manual("proxy.invalid", 8080, "localhost"), ip = WifiIp.Static("192.0.2.7", "192.0.2.1", 24, "192.0.2.2", "192.0.2.3")).toJson(),
                customIconType = "SIMPLE_ICON", customIconValue = "wifi", customIconUpdatedAt = 1700000000000L)
            save(model, wifi, storage)
            save(model, basic.copy(title = "$prefix-SSO", loginType = "SSO", ssoProvider = "GOOGLE", ssoRefEntryId = grouped), storage)
            save(model, basic.copy(title = "$prefix-SSH_KEY", loginType = "SSH_KEY", sshKeyData =
                "{\"schema\":\"monica.ssh-key.v1\",\"algorithm\":\"ED25519\",\"keySize\":256,\"publicKeyOpenSsh\":\"ssh-ed25519 SYNTHETIC\",\"privateKeyOpenSsh\":\"SYNTHETIC PRIVATE KEY\",\"fingerprintSha256\":\"SHA256:synthetic\",\"comment\":\"合成\",\"format\":\"OPENSSH\",\"future\":null}"), storage)
            save(model, basic.copy(title = "$prefix-GPG_KEY", loginType = "GPG_KEY"), storage, custom = listOf(
                CustomFieldDraft(title = "monica_gpg_type", value = "GPG_KEY"), CustomFieldDraft(title = "monica_gpg_encoding", value = "base64"),
                CustomFieldDraft(title = "monica_gpg_public_0000", value = "U1lOVEhFVElD", isProtected = true)))
            save(model, basic.copy(title = "$prefix-API_KEY", loginType = "API_KEY"), storage, custom = listOf(
                CustomFieldDraft(title = "monica_api_key_type", value = "API_KEY"), CustomFieldDraft(title = "monica_api_key_url", value = "https://api.example.invalid")))

            val samples = OtpType.entries.map { type -> ItemType.TOTP to Json.encodeToString(TotpData(secret = "JBSWY3DPEHPK3PXP", issuer = "Synthetic", accountName = type.name,
                otpType = type, algorithm = "SHA256", digits = if (type == OtpType.STEAM) 5 else 8, period = 45,
                counter = 9007199254740993L, pin = "0007", steamRawJson = if (type == OtpType.STEAM) "{\"steamid\":\"0007\"}" else "")) } + listOf(
                ItemType.BANK_CARD to Json.encodeToString(card), ItemType.NOTE to Json.encodeToString(note),
                ItemType.DOCUMENT to Json.encodeToString(DocumentData(documentType = DocumentType.PASSPORT, documentNumber = "000007", fullName = "合成 User", customFields = fields)),
                ItemType.BILLING_ADDRESS to Json.encodeToString(BillingAddressData(fullName = "User", company = "Synthetic", streetAddress = "Street", apartment = "0007", postalCode = "00001", country = "CN", isDefault = true, customFields = fields)),
                ItemType.PAYMENT_ACCOUNT to Json.encodeToString(PaymentAccountData(paymentType = PaymentAccountType.BANK_ACCOUNT, provider = "Synthetic", accountId = "0007", routingNumber = "0001", iban = "GB00SYNTHETIC", swiftBic = "SYNTHETIC", currency = "CNY", customFields = fields)))
            mdbx.upsertSecureItems(samples.mapIndexed { index, (type, data) -> SecureItem(id = 315000L + index, itemType = type, title = "$prefix-$type-$index",
                itemData = data, notes = "outer notes ≠ content", mdbxDatabaseId = target.databaseId, replicaGroupId = UUID.randomUUID().toString()) })
            reopen(target)
            val projected = importedPasswords(target)
            val projectGroup = projected.filter { it.title.endsWith("-group") }
            assertEquals(3, projectGroup.size)
            assertEquals(1, projectGroup.map { it.passwordGroupId }.distinct().size)
            val independent = projected.filter { it.title.endsWith("-independent") }
            assertEquals(2, independent.size)
            assertEquals(2, independent.map { takagi.ru.monica.ui.password.getPasswordInfoKey(it) }.distinct().size)
            assertEquals(samples.size, db.secureItemDao().getByMdbxDatabaseIdSync(target.databaseId).size)
            val standaloneCard = db.secureItemDao().getByMdbxDatabaseIdSync(target.databaseId).single { it.itemType == ItemType.BANK_CARD }
            facade.addInlineAttachment(AttachmentFacade.InlineUploadRequest(owner = AttachmentOwner.secureItem(standaloneCard.id),
                source = AttachmentSource.LOCAL, fileName = "wallet-cardface-315", mimeType = "image/png", bytes = cardImage, isPlusActivated = true))
            facade.mirrorAttachmentsForOwner(AttachmentOwner.secureItem(standaloneCard.id))
            val archive = this.model.prepareZipBackup(backupEncryptionPassword = "synthetic archive password", source = target,
                preferences = BackupPreferences(includeImages = true)).getOrThrow().first
            try { archive.copyTo(File(output, "android.zip"), overwrite = true) } finally { archive.delete() }
            val native = mdbx.readStoredEntries(target.databaseId).filterNot { it.deleted }
            File(output, "android-records.json").writeText(JSONArray(native.map { record -> JSONObject()
                .put("entryId", record.entryId).put("type", record.entryType).put("title", record.title).put("payloadJson", record.payloadJson) }).toString(2))
            val wifiWire = JSONObject(native.single { it.title.endsWith("-WIFI") }.payloadJson)
            val ssoWire = JSONObject(native.single { it.title.endsWith("-SSO") }.payloadJson)
            File(output, "android-writer-gaps.json").writeText(JSONObject().put("layer", "Android PasswordViewModel -> Mdbx2Repository -> native persisted payload")
                .put("wifiMetadataPresent", wifiWire.has("wifi_metadata")).put("customIconPresent", wifiWire.has("custom_icon_type"))
                .put("ssoProviderPresent", ssoWire.has("sso_provider")).put("ssoReferencePresent", ssoWire.has("sso_ref_entry_id"))
                .put("multiPasswordMemberCount", projectGroup.size).put("independentSameTitleCount", independent.size).put("secureCount", samples.size).toString(2))
            Mdbx2NativeReadSessions.clear()
            val file = requireNotNull(db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
            openVault(file, "Synthetic transfer fixture password", "extension-app-export-315").use { vault ->
                outputBackup(vault, "android.mdbx")
                exportBlobs(vault, "android")
            }
            // Reproduce ordinary Android title editing of a future field in a
            // separate in-memory payload, after exporting the source fixture.
            val ordinary = projected.first { it.title.endsWith("-independent") }
            val original = native.single { it.entryType == "login" && JSONObject(it.payloadJson).optLong("room_id") == ordinary.id }
            val future = kotlinx.serialization.json.Json.parseToJsonElement("""{"large":9007199254740993,"precise":1.234567890123456789012345,"null":null,"nested":[false,""]}""")
            val payload = kotlinx.serialization.json.Json.parseToJsonElement(original.payloadJson) as kotlinx.serialization.json.JsonObject
            val extended = kotlinx.serialization.json.JsonObject(payload + ("future_315" to future)).toString()
            openVault(file, "Synthetic transfer fixture password", "android-app-future-repro-315").use { vault ->
                val id = mdbx2PhysicalEntryId(vault.info().vaultId, original.entryId)
                val record = requireNotNull(vault.revealObject(id).`object`)
                vault.executeWriteOperation(UUID.randomUUID().toString(), "synthetic-future-field", listOf(
                    MdbxWriteCommand.UpdateEntry(id, record.collectionId, record.objectTypeId, record.title, extended)))
            }
            save(model, ordinary.copy(password = security.decryptDataIfMonicaCiphertext(ordinary.password), title = "$prefix-ordinary-edited"), storage)
            Mdbx2NativeReadSessions.clear()
            val after = mdbx.readStoredEntries(target.databaseId).single { it.title == "$prefix-ordinary-edited" }
            File(output, "android-known-field-writeback.json").writeText(JSONObject().put("operation", "Android ordinary title edit")
                .put("futureFieldPresentBefore", true).put("futureFieldPresentAfter", JSONObject(after.payloadJson).has("future_315"))
                .put("entryIdStable", original.entryId == after.entryId).toString(2))
        }
    }

    @Test fun exportBoundNoteArchive(): Unit = runBlocking {
        scenario { model ->
            val destination = mdbx()
            val bodies = listOf("# First note\n\n  中文 🔑  \n", "# Second note\n\nSame title, different ID\n")
            mdbx.upsertSecureItems(bodies.mapIndexed { index, body -> SecureItem(
                id = 316000L + index, itemType = ItemType.NOTE, title = "$prefix-same-note-title",
                itemData = Json.encodeToString(NoteData(content = body, tags = listOf("interop", "关联"), isMarkdown = true)),
                mdbxDatabaseId = destination.databaseId, replicaGroupId = UUID.randomUUID().toString()) })
            reopen(destination)
            val notes = db.secureItemDao().getByMdbxDatabaseIdSync(destination.databaseId)
            val first = notes.single { Json.decodeFromString<NoteData>(security.decryptDataIfMonicaCiphertext(it.itemData)).content == bodies.first() }
            for (role in listOf("keep", "replace", "unlink")) save(model, PasswordEntry(
                title = "$prefix-$role", username = "用户-$role", password = "synthetic-$role-0007",
                website = "https://$role.example.invalid", boundNoteId = first.id,
                notes = "password note ≠ linked note"), StorageTarget.Mdbx(destination.databaseId))
            reopen(destination)
            val passwords = importedPasswords(destination)
            assertEquals(3, passwords.size)
            assertTrue(passwords.all { it.boundNoteId == first.id })
            val archive = this.model.prepareZipBackup(backupEncryptionPassword = "synthetic archive password",
                source = destination, preferences = BackupPreferences(includeImages = false)).getOrThrow().first
            try { archive.copyTo(File(output, "android-note.zip"), overwrite = true) } finally { archive.delete() }
            File(output, "android-note-seed.json").writeText(JSONObject().put("prefix", prefix)
                .put("passwordCount", passwords.size).put("noteCount", notes.size)
                .put("sameTitleNotes", true).put("boundNoteRoomId", first.id).toString(2))
        }
    }

    @Test fun restoreBoundNoteArchiveAndExportAgain(): Unit = runBlocking {
        restoreNoteArchive("extension-note.zip", "android-note", 4)
    }

    @Test fun restoreEdgeBoundNoteArchiveAndExportAgain(): Unit = runBlocking {
        restoreNoteArchive("edge-note.zip", "android-edge-note", 5)
    }

    private suspend fun restoreNoteArchive(incomingName: String, outputPrefix: String, expectedPasswords: Int) {
        val incoming = File(output, incomingName)
        assertTrue("Push the independently verified note archive first", incoming.isFile)
        val restored = WebDavHelper(context).restoreFromBackupFile(incoming, "synthetic archive password",
            restoreMonicaConfig = false, importDataOnly = true).getOrThrow().content
        val report = JSONObject().put("layer", "Android ZIP decoder -> targeted MDBX restore -> reopen -> Android ZIP export")
            .put("status", "failed").put("decodedPasswords", restored.passwords.size).put("decodedNotes", restored.secureItems.size)
        try {
            assertEquals(expectedPasswords, restored.passwords.size)
            assertEquals(3, restored.secureItems.size)
            assertEquals(1, restored.passwords.count { it.boundNoteId == null })
            assertTrue(restored.passwords.single { it.boundNoteId == null }.title.endsWith("-unlink"))
            scenario { _ ->
                val destination = mdbx()
                val imported = importer.apply(restored, destination)
                assertEquals(0, imported.failed)
                assertEquals(expectedPasswords + 3, imported.imported)
                reopen(destination)
                val actual = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == destination.databaseId }
                val notes = db.secureItemDao().getByMdbxDatabaseIdSync(destination.databaseId)
                assertEquals(expectedPasswords, actual.size)
                assertEquals(3, notes.size)
                val links = JSONArray()
                report.put("links", links)
                for (source in restored.passwords) {
                    val entry = actual.single { it.title == source.title }
                    val target = notes.singleOrNull { it.id == entry.boundNoteId }
                    val expected = source.boundNoteId?.let { id -> restored.secureItems.single { it.id == id } }
                    links.put(JSONObject().put("passwordTitle", source.title).put("backupNoteId", source.boundNoteId ?: JSONObject.NULL)
                        .put("restoredNoteId", entry.boundNoteId ?: JSONObject.NULL).put("targetFound", target != null))
                    assertEquals(source.username, entry.username)
                    assertEquals(security.decryptDataIfMonicaCiphertext(source.password), security.decryptDataIfMonicaCiphertext(entry.password))
                    assertEquals(source.notes, entry.notes)
                    if (source.boundNoteId == null) {
                        assertNull(source.boundNoteId)
                        assertNull(entry.boundNoteId)
                    } else {
                        assertNotNull("${source.title} must resolve its remapped Room ID", target)
                        assertNotNull(expected)
                        assertEquals(Json.parseToJsonElement(security.decryptDataIfMonicaCiphertext(requireNotNull(expected).itemData)),
                            Json.parseToJsonElement(security.decryptDataIfMonicaCiphertext(requireNotNull(target).itemData)))
                        assertNotEquals("Restoring into a fresh database must remap backup IDs", source.boundNoteId, entry.boundNoteId)
                    }
                }
                val archive = this.model.prepareZipBackup(backupEncryptionPassword = "synthetic archive password",
                    source = destination, preferences = BackupPreferences(includeImages = false)).getOrThrow().first
                try { archive.copyTo(File(output, "$outputPrefix-return.zip"), overwrite = true) } finally { archive.delete() }
                report.put("status", "passed").put("imported", imported.imported)
            }
        } finally { File(output, "$outputPrefix-restore.json").writeText(report.toString(2)) }
    }

    @Test fun importExtensionArchiveWithoutModifyingUserData(): Unit = runBlocking {
        val file = File(output, "extension.zip")
        assertTrue("Push extension.zip produced by the browser codec first", file.isFile)
        val restored = WebDavHelper(context).restoreFromBackupFile(file, "synthetic archive password",
            restoreMonicaConfig = false, importDataOnly = true).getOrThrow().content
        assertTrue(restored.passwords.isNotEmpty())
        File(output, "extension-zip-decoded.json").writeText(JSONObject().put("passwordCount", restored.passwords.size)
            .put("secureItems", JSONArray(restored.secureItems.map { JSONObject().put("id", it.id).put("title", it.title).put("itemType", it.itemType) })).toString(2))
        assertEquals(10, restored.passwords.size)
        assertEquals(10, restored.secureItems.size)
        val expectedAttachments = restored.portableAttachments.entries.map {
            val bytes = restored.portableAttachments.payloads.getValue(it.payloadPath).readBytes()
            assertEquals(it.sha256Hex, sha(bytes))
            it.fileName to sha(bytes)
        }.sortedBy { it.toString() }
        assertEquals(3, expectedAttachments.size)
        scenario { _ ->
            val destination = mdbx()
            val imported = importer.apply(restored, destination)
            reopen(destination)
            val actual = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == destination.databaseId }
            assertEquals(restored.passwords.size, actual.size)
            val secure = db.secureItemDao().getByMdbxDatabaseIdSync(destination.databaseId)
            assertEquals(10, secure.size)
            val bindingDefaults = JSONArray()
            for (entry in secure) {
                val original = restored.secureItems.single { it.title == entry.title }
                assertEquals("Secure type must survive ZIP import: ${entry.title}", original.itemType, entry.itemType.name)
                val expectedPayload = Json.parseToJsonElement(security.decryptDataIfMonicaCiphertext(original.itemData))
                val actualPayload = Json.parseToJsonElement(security.decryptDataIfMonicaCiphertext(entry.itemData))
                // BackupRestoreApplier -> PortableTotpBackupCodec.withBindings explicitly adds
                // these null routing fields to unbound OTPs. Preserve every original property;
                // allow only those exact additions, never arbitrary nulls or changed values.
                val expectedImportedPayload = if (entry.itemType == ItemType.TOTP) {
                    val source = expectedPayload as JsonObject
                    val absentBindings = listOf("boundPasswordId", "categoryId", "keepassDatabaseId")
                        .filter { it !in source }
                    if (absentBindings.isNotEmpty()) bindingDefaults.put(JSONObject()
                        .put("title", entry.title).put("addedNullFields", JSONArray(absentBindings)))
                    JsonObject(source + absentBindings.associateWith { JsonNull })
                } else expectedPayload
                assertEquals("Full secure payload plus explicit Android binding defaults must survive ZIP import: ${entry.title}",
                    expectedImportedPayload, actualPayload)
            }
            assertEquals(Json.parseToJsonElement(Json.encodeToString(card)), Json.parseToJsonElement(
                security.decryptDataIfMonicaCiphertext(secure.single { it.itemType == ItemType.BANK_CARD }.itemData)))
            assertEquals(Json.parseToJsonElement(Json.encodeToString(note)), Json.parseToJsonElement(
                security.decryptDataIfMonicaCiphertext(secure.single { it.itemType == ItemType.NOTE }.itemData)))
            val group = actual.filter { it.title.contains("-group") }
            assertEquals(3, group.size)
            assertEquals(1, group.map { it.passwordGroupId }.distinct().size)
            val independent = actual.filter { it.title.contains("-independent") }
            assertEquals(2, independent.size)
            assertEquals(2, independent.map { takagi.ru.monica.ui.password.getPasswordInfoKey(it) }.distinct().size)
            for (entry in actual) {
                val original = restored.passwords.single { it.title == entry.title &&
                    security.decryptDataIfMonicaCiphertext(it.password) == security.decryptDataIfMonicaCiphertext(entry.password) }
                val expectedFields = restored.customFieldsMap[original.id].orEmpty().map { it.title to it.value }.sortedBy { it.toString() }
                val actualFields = db.customFieldDao().getFieldsByEntryIdSync(entry.id)
                    .map { it.title to security.decryptDataIfMonicaCiphertext(it.value) }.sortedBy { it.toString() }
                assertEquals("Full content order/wallet/blocks must survive targeted import", expectedFields, actualFields)
            }
            val facade = AttachmentContainer.facade(context)
            val owners = actual.map { AttachmentOwner.password(it.id) } + secure.map { AttachmentOwner.secureItem(it.id) }
            val actualAttachments = owners.flatMap { owner -> facade.list(owner).map {
                it.fileName to sha(facade.readAttachmentBytes(it.id, 1024 * 1024))
            } }.sortedBy { it.toString() }
            assertEquals(expectedAttachments, actualAttachments)
            val returnedArchive = this.model.prepareZipBackup(backupEncryptionPassword = "synthetic archive password", source = destination,
                preferences = BackupPreferences(includeImages = true)).getOrThrow().first
            try { returnedArchive.copyTo(File(output, "extension-zip-return.zip"), overwrite = true) } finally { returnedArchive.delete() }
            File(output, "extension-zip-readback.json").writeText(JSONObject().put("passwords", restored.passwords.size)
                .put("secureItems", restored.secureItems.size).put("groups", actual.mapNotNull { it.passwordGroupId }.distinct().size)
                .put("attachmentCount", actualAttachments.size).put("attachmentsSha256", JSONArray(actualAttachments.map { it.second }))
                .put("fullCustomFieldsUnchanged", true).put("sameTitleIndependentCount", independent.size).put("threePasswordGroupCount", group.size)
                .put("otpBindingDefaults", bindingDefaults).put("otherSecurePayloadPropertiesUnchanged", true)
                .put("imported", imported.imported).put("layer", "Android ZIP decode -> targeted import -> independent native MDBX -> Android reopen").toString(2))
        }
    }

    @Test fun reopenExtensionVaultThroughAndroidProjection(): Unit = runBlocking {
        val incoming = File(output, "extension.mdbx")
        assertTrue("Push extension.mdbx produced by the Native Host first", incoming.isFile)
        scenario { model ->
            val target = mdbx()
            Mdbx2NativeReadSessions.clear()
            val path = requireNotNull(db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
            // Only replace this method's newly-created empty synthetic vault.
            openVault(incoming.absolutePath, "Synthetic transfer fixture password", "extension-app-import-315").use { vault ->
                File(path).delete(); vault.createBackup(path)
            }
            openVault(path, "Synthetic transfer fixture password", "extension-app-blobs-315").use { vault ->
                installBlobs(vault, "extension")
            }
            reopen(target)
            val records = mdbx.readStoredEntries(target.databaseId).filterNot { it.deleted }
            val passwords = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == target.databaseId }
            val secure = db.secureItemDao().getByMdbxDatabaseIdSync(target.databaseId)
            assertTrue(passwords.isNotEmpty())
            val facade = AttachmentContainer.facade(context)
            suspend fun attachmentProofs(): JSONArray {
                val current = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == target.databaseId }
                return JSONArray(current.flatMap { entry -> facade.list(AttachmentOwner.password(entry.id)).map { attachment ->
                    val bytes = facade.readAttachmentBytes(attachment.id, 1024 * 1024)
                    JSONObject().put("replicaGroupId", entry.replicaGroupId).put("fileName", attachment.fileName)
                        .put("sizeBytes", bytes.size).put("sha256", sha(bytes))
                } }.sortedBy { it.toString() })
            }
            val attachmentsBeforeEdit = attachmentProofs()
            val contentOrders = JSONArray(passwords.map { entry -> JSONObject()
                .put("entryId", entry.id).put("title", entry.title).put("replicaGroupId", entry.replicaGroupId)
                .put("order", db.customFieldDao().getFieldsByEntryIdSync(entry.id)
                    .firstOrNull { it.title == "monica.content.order" }?.let { security.decryptDataIfMonicaCiphertext(it.value) } ?: "") })
            val noteLinks = JSONArray(passwords.map { entry ->
                val linked = secure.singleOrNull { it.id == entry.boundNoteId && it.itemType == ItemType.NOTE }
                JSONObject().put("passwordReplicaGroupId", entry.replicaGroupId).put("passwordTitle", entry.title)
                    .put("boundNoteRoomId", entry.boundNoteId ?: JSONObject.NULL)
                    .put("resolvedNoteRoomId", linked?.id ?: JSONObject.NULL)
                    .put("noteReplicaGroupId", linked?.replicaGroupId ?: JSONObject.NULL)
                    .put("noteTitle", linked?.title ?: JSONObject.NULL)
            })
            val first = passwords.first { it.loginType == "PASSWORD" }
            val custom = db.customFieldDao().getFieldsByEntryIdSync(first.id).map { CustomFieldDraft(it.id, it.title, security.decryptDataIfMonicaCiphertext(it.value), it.isProtected) }
            save(model, first.copy(password = security.decryptDataIfMonicaCiphertext(first.password), notes = first.notes + "\nAndroid roundtrip edit"), StorageTarget.Mdbx(target.databaseId), custom = custom)
            reopen(target)
            val attachmentsAfterEdit = attachmentProofs()
            assertEquals("Attachments must survive Android edit and reopen", attachmentsBeforeEdit.toString(), attachmentsAfterEdit.toString())
            File(output, "extension-native-readback.json").writeText(JSONObject().put("nativeRecords", records.size).put("passwords", passwords.size)
                .put("attachmentsBeforeEdit", attachmentsBeforeEdit).put("attachmentsAfterEdit", attachmentsAfterEdit)
                .put("contentOrders", contentOrders)
                .put("noteLinks", noteLinks)
                .put("secureItems", secure.size).put("groups", passwords.mapNotNull { it.passwordGroupId }.distinct().size)
                .put("loginTypes", JSONArray(passwords.map { it.loginType }.distinct())).put("secureTypes", JSONArray(secure.map { it.itemType.name }.distinct())).toString(2))
            Mdbx2NativeReadSessions.clear()
            openVault(path, "Synthetic transfer fixture password", "android-app-return-315").use {
                outputBackup(it, "android-return.mdbx")
                exportBlobs(it, "android-return")
            }
        }
    }

    @Test fun reopenRestoredPasswordProject(): Unit = runBlocking {
        reopenVerifiedPasswordProject(false)
    }

    @Test fun reopenRemovedPasswordProject(): Unit = runBlocking {
        reopenVerifiedPasswordProject(true)
    }

    private suspend fun reopenVerifiedPasswordProject(removal: Boolean) {
        val incoming = File(output, "extension.mdbx")
        val expected = JSONObject(File(output, "edge-restored-project-expected.json").readText())
        assertTrue(expected.getBoolean("synthetic"))
        val expectedRows = expected.getJSONArray("restored")
        val expectedNative = expected.getJSONArray("originalRecords")
        val removed = expected.optJSONArray("removedRecords") ?: JSONArray()
        if (removal) {
            assertTrue(expected.getString("removalMode") in setOf("complete", "cancel", "restart"))
            assertEquals(if (expected.getString("removalMode") == "cancel") 3 else 1, expectedRows.length())
            assertEquals(3 - expectedRows.length(), removed.length())
        } else {
            val mode = expected.optString("restorationMode")
            assertTrue("Known restoration mode required", mode in setOf("", "mixed"))
            assertEquals(if (mode == "mixed") 4 else 3, expectedRows.length())
        }
        assertEquals(expectedRows.length(), expectedNative.length())
        assertEquals(expectedRows.length(), (0 until expectedRows.length()).map {
            expectedRows.getJSONObject(it).getString("replicaGroupId")
        }.toSet().size)
        assertEquals(expectedRows.length(), (0 until expectedNative.length()).map {
            expectedNative.getJSONObject(it).getJSONObject("native").getString("objectId")
        }.toSet().size)
        scenario { writer ->
            val target = mdbx()
            Mdbx2NativeReadSessions.clear()
            val path = requireNotNull(db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
            openVault(incoming.absolutePath, "Synthetic transfer fixture password", "restored-project-import").use { vault ->
                check(File(path).delete()); vault.createBackup(path)
            }
            openVault(path, "Synthetic transfer fixture password", "restored-project-blobs").use { installBlobs(it, "extension") }
            reopen(target)
            val entries = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == target.databaseId }
            val groupId = expectedRows.getJSONObject(0).getString("passwordGroupId")
            val members = entries.filter { it.passwordGroupId == groupId && !it.isDeleted }
            assertEquals("All restored passwords must return to the same Android project", expectedRows.length(), members.size)
            val readback = JSONArray()
            for (index in 0 until expectedRows.length()) {
                val row = expectedRows.getJSONObject(index)
                val entry = members.single { it.replicaGroupId == row.getString("replicaGroupId") }
                assertEquals(row.getString("title"), entry.title)
                assertEquals(row.getString("username"), entry.username)
                assertEquals(row.getString("password"), security.decryptDataIfMonicaCiphertext(entry.password))
                assertEquals(row.getString("notes"), entry.notes)
                assertEquals(row.optString("email"), entry.email)
                for ((key, value) in mapOf("appPackageName" to entry.appPackageName, "appName" to entry.appName,
                    "phone" to entry.phone, "addressLine" to entry.addressLine, "city" to entry.city, "state" to entry.state,
                    "zipCode" to entry.zipCode, "country" to entry.country, "creditCardNumber" to entry.creditCardNumber,
                    "creditCardHolder" to entry.creditCardHolder, "creditCardExpiry" to entry.creditCardExpiry, "creditCardCVV" to entry.creditCardCVV)) {
                    assertEquals(key, row.optString(key), value)
                }
                val customRows = db.customFieldDao().getFieldsByEntryIdSync(entry.id)
                val custom = customRows.associate { it.title to security.decryptDataIfMonicaCiphertext(it.value) }
                val fields = row.getJSONArray("customFields")
                for (fieldIndex in 0 until fields.length()) {
                    val field = fields.getJSONObject(fieldIndex)
                    assertEquals(field.getString("name"), field.getString("value"), custom[field.getString("name")])
                    assertEquals(field.optBoolean("protected"), customRows.single { it.title == field.getString("name") }.isProtected)
                }
                readback.put(JSONObject().put("nativeId", entry.replicaGroupId).put("projectId", entry.passwordGroupId)
                    .put("title", entry.title).put("customFields", custom.size))
            }
            Mdbx2NativeReadSessions.clear()
            openVault(path, "Synthetic transfer fixture password", "restored-project-raw").use { vault ->
                for (index in 0 until expectedNative.length()) {
                    val original = expectedNative.getJSONObject(index).getJSONObject("native")
                    val actual = requireNotNull(vault.revealObject(original.getString("objectId")).`object`)
                    assertEquals(original.getString("payloadJson"), actual.payloadJson)
                    assertEquals(original.getString("collectionId"), actual.collectionId)
                }
                for (index in 0 until removed.length()) {
                    val original = removed.getJSONObject(index)
                    val actual = requireNotNull(vault.getObjectSummary(original.getString("objectId")))
                    assertTrue("Removed native member must remain deleted", actual.deleted)
                    assertEquals(original.getString("collectionId"), actual.collectionId)
                    assertEquals(original.getString("headCommitId"), actual.headCommitId)
                }
            }
            val facade = AttachmentContainer.facade(context)
            suspend fun attachmentProofs() = JSONArray(members.flatMap { entry -> facade.list(AttachmentOwner.password(entry.id)).map { attachment ->
                val bytes = facade.readAttachmentBytes(attachment.id, 1024 * 1024)
                JSONObject().put("nativeId", entry.replicaGroupId).put("fileName", attachment.fileName)
                    .put("sizeBytes", bytes.size).put("sha256", sha(bytes))
            } }.sortedBy { it.toString() })
            val beforeAttachments = attachmentProofs()
            assertTrue("Restored project must include real readable attachments", beforeAttachments.length() > 0)
            val anchor = members.single { it.replicaGroupId == expectedRows.getJSONObject(0).getString("replicaGroupId") }
            val custom = db.customFieldDao().getFieldsByEntryIdSync(anchor.id).map {
                CustomFieldDraft(it.id, it.title, security.decryptDataIfMonicaCiphertext(it.value), it.isProtected)
            }
            val returnedNote = anchor.notes + if (removal) "\nAndroid removed-project edit" else "\nAndroid restored-project edit"
            save(writer, anchor.copy(password = security.decryptDataIfMonicaCiphertext(anchor.password), notes = returnedNote),
                StorageTarget.Mdbx(target.databaseId), custom = custom)
            reopen(target)
            val after = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == target.databaseId && it.passwordGroupId == groupId && !it.isDeleted }
            assertEquals(members.map { it.replicaGroupId }.toSet(), after.map { it.replicaGroupId }.toSet())
            assertEquals(returnedNote, after.single { it.replicaGroupId == anchor.replicaGroupId }.notes)
            val afterAttachments = attachmentProofs()
            assertEquals(beforeAttachments.toString(), afterAttachments.toString())
            File(output, if (removal) "removed-project-android-readback.json" else "restored-project-android-readback.json").writeText(JSONObject().put("status", "passed")
                .put("members", readback).put("editedNativeId", anchor.replicaGroupId).put("returnedNote", returnedNote)
                .put("removalMode", expected.optString("removalMode")).put("removedCount", removed.length())
                .put("attachmentsBefore", beforeAttachments).put("attachmentsAfter", afterAttachments)
                .put("layer", "Current Android native import + Room project/field/attachment projection + edit + reopen + export").toString(2))
            Mdbx2NativeReadSessions.clear()
            openVault(path, "Synthetic transfer fixture password", "restored-project-export").use {
                outputBackup(it, "android-return.mdbx"); exportBlobs(it, "android-return")
            }
        }
    }

    @Test fun exportPasswordEncodingProbe(): Unit = runBlocking {
        scenario { writer ->
            val target = mdbx()
            val cleartext = "synthetic-inner-${UUID.randomUUID()}-密码"
            val literal = security.encryptData(cleartext)
            assertTrue(security.looksLikeMonicaCiphertext(literal))
            assertNotEquals(cleartext, literal)
            assertEquals(cleartext, security.decryptDataIfMonicaCiphertext(literal))
            save(writer, PasswordEntry(title = "$prefix-encoding-changed", password = "original-password", username = "synthetic", website = "https://encoding.example.invalid"),
                StorageTarget.Mdbx(target.databaseId))
            Mdbx2NativeReadSessions.clear()
            val path = requireNotNull(db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
            openVault(path, "Synthetic transfer fixture password", "encoding-seed-export").use { outputBackup(it, "android.mdbx") }
            File(output, "password-encoding-probe.json").writeText(JSONObject().put("synthetic", true)
                .put("literal", literal).put("cleartext", cleartext).toString(2))
        }
    }

    @Test fun reopenLiteralCiphertextPasswords(): Unit = runBlocking {
        val probe = JSONObject(File(output, "password-encoding-probe.json").readText())
        assertTrue(probe.getBoolean("synthetic"))
        val literal = probe.getString("literal")
        val cleartext = probe.getString("cleartext")
        scenario { writer ->
            // Authentication proves this is a real ciphertext for this installation,
            // not just a prefix that its repair code would ignore anyway.
            assertEquals(cleartext, security.decryptDataIfMonicaCiphertext(literal))
            val target = mdbx()
            Mdbx2NativeReadSessions.clear()
            val path = requireNotNull(db.localMdbxDatabaseDao().getDatabaseById(target.databaseId)).filePath
            openVault(File(output, "extension.mdbx").absolutePath, "Synthetic transfer fixture password", "encoding-import").use {
                check(File(path).delete()); it.createBackup(path)
            }
            val before = mdbx.readStoredEntries(target.databaseId).filter { !it.deleted }
            assertEquals(3, before.size)
            assertTrue(before.all { JSONObject(it.payloadJson).getString("password_plain") == literal })
            val marked = before.filter { it.title.endsWith("-encoding-new") || it.title.endsWith("-encoding-changed") }
            assertEquals(2, marked.size)
            assertTrue(marked.all { JSONObject(it.payloadJson).getString("monica_password_encoding") == "plaintext-v1" })
            assertFalse(JSONObject(before.single { it.title.endsWith("-encoding-legacy") }.payloadJson).has("monica_password_encoding"))
            assertEquals("Only the unmarked historical ciphertext is repaired", 1, mdbx.repairReadablePasswordCiphertexts(target.databaseId))
            assertEquals(0, mdbx.repairReadablePasswordCiphertexts(target.databaseId))
            reopen(target)
            // These rows originated in an earlier fixture or the extension, so
            // scope by this newly created vault, not TransferFixture's new prefix.
            val entries = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == target.databaseId }
            assertEquals(3, entries.size)
            for (entry in entries) {
                val expected = if (entry.title.endsWith("-encoding-legacy")) cleartext else literal
                assertEquals(expected, security.decryptDataIfMonicaCiphertext(entry.password))
            }
            for (entry in entries.filterNot { it.title.endsWith("-encoding-legacy") }) {
                save(writer, entry.copy(password = literal, notes = "Android encoding edit"), StorageTarget.Mdbx(target.databaseId))
            }
            reopen(target)
            val reopened = db.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == target.databaseId }
            assertEquals(entries.map { it.replicaGroupId }.toSet(), reopened.map { it.replicaGroupId }.toSet())
            val after = mdbx.readStoredEntries(target.databaseId).filter { !it.deleted }
            for (row in after) {
                val payload = JSONObject(row.payloadJson)
                assertEquals("plaintext-v1", payload.getString("monica_password_encoding"))
                assertEquals(if (row.title.endsWith("-encoding-legacy")) cleartext else literal, payload.getString("password_plain"))
                if (!row.title.endsWith("-encoding-legacy")) assertEquals("Android encoding edit", payload.getString("notes"))
            }
            assertEquals(0, mdbx.repairReadablePasswordCiphertexts(target.databaseId))
            Mdbx2NativeReadSessions.clear()
            openVault(path, "Synthetic transfer fixture password", "encoding-return").use { outputBackup(it, "android-return.mdbx") }
            File(output, "password-encoding-readback.json").writeText(JSONObject().put("status", "passed")
                .put("actualCiphertextAuthenticated", true).put("literalPasswordsPreserved", 2).put("legacyCiphertextsRepaired", 1)
                .put("editedThroughPasswordViewModel", true).put("reopened", true).toString(2))
        }
    }

    /** createBackup copies the encrypted database but not its external Blob directory. */
    private fun outputBackup(vault: MdbxVault, name: String) {
        require(name in setOf("android.mdbx", "android-return.mdbx"))
        val destination = File(output, name)
        if (destination.exists()) check(destination.renameTo(File(output, "previous-${System.nanoTime()}-$name")))
        vault.createBackup(destination.absolutePath)
    }

    private fun exportBlobs(vault: MdbxVault, prefix: String) {
        val blobs = JSONArray()
        var cursor: String? = null
        do {
            val page = vault.listExternalBlobReferences(cursor, 100u)
            page.items.forEach { reference ->
                require(reference.blobId.matches(Regex("[0-9a-f]{64}")))
                val total = requireNotNull(reference.totalSize)
                assertEquals(MdbxExternalBlobState.AVAILABLE, reference.state)
                val relative = "$prefix-blobs/${reference.blobId}"
                val destination = File(output, relative).also { it.parentFile!!.mkdirs() }
                destination.outputStream().use { stream ->
                    var offset = 0uL
                    while (offset < total) {
                        val chunk = vault.readExternalBlobChunk(reference.blobId, total, offset, 262144u)
                        assertEquals(offset, chunk.offset)
                        assertTrue(chunk.ciphertext.isNotEmpty())
                        stream.write(chunk.ciphertext)
                        offset += chunk.ciphertext.size.toULong()
                    }
                }
                assertEquals(total.toLong(), destination.length())
                assertEquals(reference.blobId, sha(destination.readBytes()))
                blobs.put(JSONObject().put("path", relative).put("blobId", reference.blobId).put("sizeBytes", total.toLong()))
            }
            cursor = page.nextCursor
        } while (cursor != null)
        File(output, "$prefix-blobs.json").writeText(blobs.toString(2))
    }

    private fun installBlobs(vault: MdbxVault, prefix: String) {
        var cursor: String? = null
        do {
            val page = vault.listExternalBlobReferences(cursor, 100u)
            page.items.forEach { reference ->
                require(reference.blobId.matches(Regex("[0-9a-f]{64}")))
                val source = File(output, "$prefix-blobs/${reference.blobId}")
                assertTrue("Missing external Blob ${reference.blobId}", source.isFile)
                assertEquals(reference.blobId, sha(source.readBytes()))
                val total = reference.totalSize ?: source.length().toULong()
                assertEquals(total.toLong(), source.length())
                val owner = "android-app-315-${UUID.randomUUID()}"
                vault.acquireExternalBlobLease(reference.blobId, owner, System.currentTimeMillis() / 1000, 300)
                try {
                    val bytes = source.readBytes()
                    var offset = 0
                    while (offset < bytes.size) {
                        val end = minOf(offset + 262144, bytes.size)
                        vault.writeExternalBlobChunk(reference.blobId, total, offset.toULong(), bytes.copyOfRange(offset, end), end == bytes.size)
                        offset = end
                    }
                } finally { vault.releaseExternalBlobLease(reference.blobId, owner) }
                assertTrue(vault.hasExternalBlob(reference.blobId, total))
            }
            cursor = page.nextCursor
        } while (cursor != null)
    }

    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test fun cleanupAbortedSyntheticUiFixture(): Unit = runBlocking {
        val prefix = requireNotNull(InstrumentationRegistry.getArguments().getString("syntheticPrefix"))
        require(prefix.matches(Regex("credential-transfer-[0-9a-f-]{36}")))
        val root = File(context.filesDir, prefix).canonicalFile
        require(root.parentFile == context.filesDir.canonicalFile && root.isDirectory)
        val database = PasswordDatabase.getDatabase(context)
        val owned = database.localMdbxDatabaseDao().getAllDatabasesSnapshot().filter { it.name == "$prefix-MDBX" }
        require(owned.size <= 1)
        val repository = Mdbx2Repository(context, database.localMdbxDatabaseDao(), takagi.ru.monica.security.SecurityManager(context))
        val attachments = AttachmentContainer.facade(context)
        owned.forEach { vault ->
            database.passwordEntryDao().getAllPasswordEntriesSync().filter { it.mdbxDatabaseId == vault.id }.forEach { item ->
                require(item.title.startsWith(prefix))
                attachments.purgeByPassword(item.id)
                database.passwordEntryDao().deletePasswordEntryById(item.id)
            }
            require(database.secureItemDao().getByMdbxDatabaseIdSync(vault.id).isEmpty())
            database.localMdbxDatabaseDao().deleteDatabaseById(vault.id)
            repository.deleteOwnedVaultFile(File(vault.filePath))
        }
        require(root.listFiles().orEmpty().isEmpty())
        root.delete()
        File(output, "ui-cleanup.json").writeText(JSONObject().put("prefix", prefix).put("removedSyntheticVaults", owned.size).toString(2))
    }
}
