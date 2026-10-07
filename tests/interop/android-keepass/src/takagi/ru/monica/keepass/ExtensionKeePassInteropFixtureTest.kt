package takagi.ru.monica.keepass

import app.keemobile.kotpass.cryptography.EncryptedValue
import app.keemobile.kotpass.cryptography.format.BaseCiphers
import app.keemobile.kotpass.cryptography.format.TwofishCipher
import app.keemobile.kotpass.database.Credentials
import app.keemobile.kotpass.database.KeePassDatabase
import app.keemobile.kotpass.database.decode
import app.keemobile.kotpass.database.encode
import app.keemobile.kotpass.database.modifiers.binaries
import app.keemobile.kotpass.database.modifiers.modifyBinaries
import app.keemobile.kotpass.database.modifiers.modifyParentGroup
import app.keemobile.kotpass.models.BinaryData
import app.keemobile.kotpass.models.BinaryReference
import app.keemobile.kotpass.models.CustomDataValue
import app.keemobile.kotpass.models.CustomIcon
import app.keemobile.kotpass.models.Entry
import app.keemobile.kotpass.models.EntryFields
import app.keemobile.kotpass.models.EntryValue
import app.keemobile.kotpass.models.Group
import app.keemobile.kotpass.models.Meta
import app.keemobile.kotpass.models.TimeData
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import takagi.ru.monica.data.ItemType
import takagi.ru.monica.data.model.SshKeyData
import takagi.ru.monica.data.model.SshKeyDataCodec
import takagi.ru.monica.passkey.PasskeyPrivateKeySupport
import takagi.ru.monica.utils.KeePassCodecSupport
import takagi.ru.monica.utils.KeePassFieldReferenceResolver
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Instant
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.UUID

class ExtensionKeePassInteropFixtureTest {

    @Test
    fun generateAndroidKdbxFixtures() {
        val output = interopDirectory()
        Files.createDirectories(output)
        writeFixture(output.resolve(ANDROID_AES_FILE), BaseCiphers.Aes.uuid)
        writeFixture(output.resolve(ANDROID_CHACHA20_FILE), BaseCiphers.ChaCha20.uuid)
        writeFixture(output.resolve(ANDROID_TWOFISH_FILE), TwofishCipher.uuid)
        for (variant in listOf("aes", "chacha20")) writePlainTextFixture(output, variant)
    }

    @Test
    fun verifyExtensionKdbxExports() {
        val output = interopDirectory()
        verifyExport(
            output.resolve(EXTENSION_AES_FILE),
            BaseCiphers.Aes.uuid,
            "extension-aes-user",
            "Edited by Monica Extension through AES-256",
            "Extension Card Holder",
            "Extension Document Holder"
        )
        verifyExport(
            output.resolve(EXTENSION_CHACHA20_FILE),
            BaseCiphers.ChaCha20.uuid,
            "extension-chacha20-user",
            "Edited by Monica Extension through ChaCha20",
            "Extension Card Holder",
            "Extension Document Holder"
        )
        verifyPasskeyPortability(output, "aes")
        verifyPasskeyPortability(output, "chacha20")
        verifySshPortability(output, "aes")
        verifySshPortability(output, "chacha20")
        for (variant in listOf("aes", "chacha20")) verifyPlainTextPortability(output, variant)
    }

    private fun writePlainTextFixture(output: Path, variant: String) {
        val database = decode(Files.readAllBytes(output.resolve("android-$variant.kdbx")), credentials())
        val original = requireNotNull(findEntry(database.content.group, SSH_ENTRY_UUID))
        val fields = original.fields.toMutableMap()
        fields["MonicaSshComment"] = EntryValue.Plain(XML_PLAIN_TEXT)
        fields["MonicaSshPublicKey"] = EntryValue.Plain("ssh-rsa\tplain-public")
        fields["Email"] = EntryValue.Plain(XML_PLAIN_TEXT)
        fields["Notes"] = EntryValue.Plain(XML_PLAIN_TEXT)
        fields["Future plain\tfield"] = EntryValue.Plain(XML_PLAIN_TEXT)
        val updated = original.copy(fields = EntryFields.of(*fields.map { it.key to it.value }.toTypedArray()))
        val next = database.modifyParentGroup { copy(groups = groups.map { group ->
            if (group.uuid == INTEROP_GROUP_UUID) group.copy(entries = group.entries.map { if (it.uuid == SSH_ENTRY_UUID) updated else it }) else group
        }) }
        val bytes = encode(next)
        Files.write(output.resolve("android-plain-$variant.kdbx"), bytes)
        val decoded = requireNotNull(findEntry(decode(bytes, credentials()).content.group, SSH_ENTRY_UUID))
        for (name in listOf("MonicaSshComment", "Email", "Notes", "Future plain\tfield")) {
            assertTrue(decoded.fields.getValue(name) is EntryValue.Plain)
            assertEquals(XML_PLAIN_TEXT, KeePassFieldReferenceResolver.getFieldValue(decoded, name))
        }
    }

    private fun verifyPlainTextPortability(output: Path, variant: String) {
        val database = decode(Files.readAllBytes(output.resolve("extension-plain-$variant.kdbx")), credentials())
        val entry = requireNotNull(findEntry(database.content.group, SSH_ENTRY_UUID))
        assertEquals("Plain SSH renamed", entry.fields.getValue("Title").content)
        assertEquals(XML_PLAIN_TEXT + " Extension edit", KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshComment"))
        assertEquals("ssh-rsa\tplain-public", KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshPublicKey"))
        assertEquals(SSH_PRIVATE_TEXT, KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshPrivateKey"))
        for (name in listOf("Email", "Notes", "Future plain\tfield")) {
            assertEquals(XML_PLAIN_TEXT, KeePassFieldReferenceResolver.getFieldValue(entry, name))
            assertTrue(entry.fields.getValue(name) is EntryValue.Encrypted)
        }
        val fields = entry.fields.toMutableMap()
        fields["MonicaSshComment"] = EntryValue.Plain(XML_PLAIN_TEXT + " Android returned")
        val updated = entry.copy(fields = EntryFields.of(*fields.map { it.key to it.value }.toTypedArray()))
        val returned = database.modifyParentGroup { copy(groups = groups.map { group ->
            if (group.uuid == INTEROP_GROUP_UUID) group.copy(entries = group.entries.map { if (it.uuid == SSH_ENTRY_UUID) updated else it }) else group
        }) }
        Files.write(output.resolve("android-plain-return-$variant.kdbx"), encode(returned))
    }

    private fun verifySshPortability(output: Path, variant: String) {
        val names = listOf("MonicaSshAlgorithm", "MonicaSshKeySize", "MonicaSshPublicKey", "MonicaSshPrivateKey", "MonicaSshFingerprint", "MonicaSshComment", "MonicaSshFormat")
        for (stage in listOf("rename", "edit", "clear")) {
            val database = decode(Files.readAllBytes(output.resolve("extension-ssh-$stage-$variant.kdbx")), credentials())
            val entry = requireNotNull(findEntry(database.content.group, SSH_ENTRY_UUID))
            assertEquals("unknown SSH data", entry.fields.getValue("Future SSH Field").content)
            assertTrue(entry.fields.getValue("Future SSH Field") is EntryValue.Encrypted)
            if (stage == "clear") {
                assertTrue(names.none { entry.fields.containsKey(it) })
                assertEquals("SSH_KEY", entry.fields.getValue("MonicaLoginType").content)
                continue
            }
            for (name in names.filter { it != "MonicaSshKeySize" || stage == "rename" }) assertTrue(entry.fields.getValue(name) is EntryValue.Encrypted)
            if (stage == "rename") {
                assertEquals("Android SSH renamed", entry.fields.getValue("Title").content)
                assertEquals("4096", entry.fields.getValue("MonicaSshKeySize").content)
                assertEquals(SSH_COMMENT_TEXT, KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshComment"))
                assertEquals(SSH_PRIVATE_TEXT, KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshPrivateKey"))
                continue
            }
            assertFalse(entry.fields.containsKey("MonicaSshKeySize"))
            // Field extraction matches KeePassKdbxService; the codec below is copied verbatim from Android.
            val raw = SshKeyDataCodec.encode(SshKeyData(
                algorithm = KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshAlgorithm"),
                publicKeyOpenSsh = KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshPublicKey"),
                privateKeyOpenSsh = KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshPrivateKey"),
                fingerprintSha256 = KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshFingerprint"),
                comment = KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshComment"),
                format = KeePassFieldReferenceResolver.getFieldValue(entry, "MonicaSshFormat")
            ))
            val ssh = requireNotNull(SshKeyDataCodec.decode(raw))
            assertEquals(" ssh-rsa extension-public\n", ssh.publicKeyOpenSsh)
            assertEquals(SSH_EDITED_COMMENT, ssh.comment)
            assertEquals(SSH_PRIVATE_TEXT, ssh.privateKeyOpenSsh)
            val returnedData = requireNotNull(SshKeyDataCodec.decode(SshKeyDataCodec.encode(ssh.copy(comment = SSH_RETURNED_COMMENT))))
            val updated = entry.copy(fields = EntryFields.of(*entry.fields.map { (name, value) ->
                name to if (name == "MonicaSshComment") EntryValue.Encrypted(EncryptedValue.fromString(returnedData.comment)) else value
            }.toTypedArray()))
            val returned = database.modifyParentGroup { copy(groups = groups.map { group ->
                if (group.uuid == INTEROP_GROUP_UUID) group.copy(entries = group.entries.map { if (it.uuid == SSH_ENTRY_UUID) updated else it }) else group
            }) }
            Files.write(output.resolve("android-ssh-$variant.kdbx"), encode(returned))
        }
        val copiedDb = decode(Files.readAllBytes(output.resolve("extension-ssh-copy-$variant.kdbx")), credentials())
        fun copiedEntry(group: Group): Entry? = group.entries.firstOrNull { it.fields["Title"]?.content == "SSH copied text" }
            ?: group.groups.firstNotNullOfOrNull { copiedEntry(it) }
        val copied = requireNotNull(copiedEntry(copiedDb.content.group))
        assertEquals(SSH_PRIVATE_TEXT, KeePassFieldReferenceResolver.getFieldValue(copied, "MonicaSshPrivateKey"))
        assertEquals(SSH_COMMENT_TEXT, KeePassFieldReferenceResolver.getFieldValue(copied, "MonicaSshComment"))
        assertEquals(SSH_COMMENT_TEXT, KeePassFieldReferenceResolver.getFieldValueIgnoreCase(copied, null, "Email"))
        assertTrue(copied.fields.getValue("Email") is EntryValue.Encrypted)
        // Current Android discards metadata-only SSH JSON; record this limitation, do not hide it.
        assertEquals("", SshKeyDataCodec.encode(SshKeyData(comment = "comment only", format = "PEM")))
    }

    private fun verifyPasskeyPortability(output: Path, variant: String) {
        val database = decode(Files.readAllBytes(output.resolve("extension-passkey-$variant.kdbx")), credentials())
        val entry = requireNotNull(findEntry(database.content.group, PASSKEY_ENTRY_UUID))
        val raw = entry.fields.getValue("MonicaPasskeyData")
        assertTrue(raw is EntryValue.Encrypted)
        val updated = requireNotNull(KeePassPasskeySyncCodec.decode(raw.content, 1L, "Android Interop", INTEROP_GROUP_UUID.toString()))
        val original = requireNotNull(KeePassPasskeySyncCodec.decode(PASSKEY_PAYLOAD, 1L, "Android Interop", INTEROP_GROUP_UUID.toString()))
        assertEquals(original.credentialId, updated.credentialId)
        assertEquals(original.privateKeyAlias, updated.privateKeyAlias)
        assertEquals(original.userId, updated.userId)
        assertEquals(0L, updated.signCount)
        assertEquals(4, updated.useCount)
        assertEquals("true", entry.fields.getValue("KPEX_PASSKEY_FLAG_BE").content)
        assertEquals("true", entry.fields.getValue("KPEX_PASSKEY_FLAG_BS").content)
        assertEquals("passkey plugin must stay", entry.fields.getValue("External Passkey Plugin Field").content)

        val request = Json.parseToJsonElement(Files.readString(output.resolve("extension-passkey-$variant.json"))).jsonObject
        val decoder = Base64.getUrlDecoder()
        val authData = decoder.decode(request.getValue("authenticatorData").jsonPrimitive.content)
        val clientData = decoder.decode(request.getValue("clientDataJSON").jsonPrimitive.content)
        val clientJson = Json.parseToJsonElement(String(clientData, Charsets.UTF_8)).jsonObject
        assertEquals("webauthn.get", clientJson.getValue("type").jsonPrimitive.content)
        assertEquals("https://github.com", clientJson.getValue("origin").jsonPrimitive.content)
        assertEquals(request.getValue("challenge").jsonPrimitive.content, clientJson.getValue("challenge").jsonPrimitive.content)
        assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(updated.rpId.toByteArray()), authData.copyOfRange(0, 32))
        assertEquals(0x1d, authData[32].toInt())
        assertArrayEquals(ByteArray(4), authData.copyOfRange(33, 37))
        val signedData = authData + MessageDigest.getInstance("SHA-256").digest(clientData)
        val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getDecoder().decode(request.getValue("publicKeySpki").jsonPrimitive.content)))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey)
        verifier.update(signedData)
        assertTrue(verifier.verify(decoder.decode(request.getValue("signature").jsonPrimitive.content)))

        // These are the actual Android private-key decoder and signer used by PasskeyAuthActivity.
        val signatures = listOf(original, updated).map { passkey ->
            val key = requireNotNull(PasskeyPrivateKeySupport.decodeFlexiblePrivateKey(passkey.privateKeyAlias))
            val signer = PasskeyPrivateKeySupport.createSignature(key.privateKey, passkey.publicKeyAlgorithm)
            signer.update(signedData)
            JsonPrimitive(Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign()))
        }
        Files.writeString(output.resolve("android-passkey-$variant.json"), JsonArray(signatures).toString())

        val payload = KeePassPasskeySyncCodec.encode(updated.copy(signCount = 0L, useCount = 5))
        val updatedEntry = entry.copy(fields = EntryFields.of(*entry.fields.map { (name, value) ->
            name to if (name == "MonicaPasskeyData") EntryValue.Encrypted(EncryptedValue.fromString(payload)) else value
        }.toTypedArray()))
        val returned = database.modifyParentGroup {
            copy(groups = groups.map { group ->
                if (group.uuid == INTEROP_GROUP_UUID) group.copy(entries = group.entries.map { if (it.uuid == PASSKEY_ENTRY_UUID) updatedEntry else it }) else group
            })
        }
        Files.write(output.resolve("android-passkey-$variant.kdbx"), encode(returned))
    }

    private fun writeFixture(target: Path, cipherId: UUID) {
        val credentials = credentials()
        val attachment = BinaryData.Uncompressed(
            memoryProtection = false,
            rawContent = ATTACHMENT_BYTES.copyOf()
        )
        val cardReceipt = BinaryData.Uncompressed(
            memoryProtection = false,
            rawContent = CARD_RECEIPT_BYTES.copyOf()
        )
        val documentReceipt = BinaryData.Uncompressed(
            memoryProtection = false,
            rawContent = DOCUMENT_RECEIPT_BYTES.copyOf()
        )
        val base = KeePassDatabase.Ver4x.create(
            rootName = "Root",
            meta = Meta(
                generator = "Monica Android interop",
                customIcons = mapOf(ICON_UUID to CustomIcon(data = ICON_BYTES, name = "Android icon", lastModified = META_TIME)),
                settingsChanged = META_TIME,
                name = "Android KeePass interoperability",
                nameChanged = META_TIME,
                description = "Kotpass fixture for Monica Extension",
                descriptionChanged = META_TIME,
                defaultUser = "android-default",
                defaultUserChanged = META_TIME,
                customData = mapOf(
                    "database-plugin" to CustomDataValue("database state must stay", META_TIME)
                )
            ),
            credentials = credentials
        )
        val database = base
            .copy(header = base.header.copy(cipherId = cipherId))
            .modifyBinaries { binaries ->
                binaries +
                    (attachment.hash to attachment) +
                    (cardReceipt.hash to cardReceipt) +
                    (documentReceipt.hash to documentReceipt)
            }
            .modifyParentGroup {
                copy(
                    groups = groups + Group(
                        uuid = INTEROP_GROUP_UUID,
                        name = "Android Interop",
                        notes = "group notes must stay",
                        times = GROUP_TIMES,
                        tags = listOf("android-group", "interop"),
                        entries = listOf(
                            loginEntry(attachment),
                            sshEntry(),
                            passkeyEntry(),
                            bankCardEntry(cardReceipt),
                            documentEntry(documentReceipt)
                        ),
                        groups = listOf(
                            Group(
                                uuid = NESTED_GROUP_UUID,
                                name = "Nested Future Group",
                                notes = "nested notes",
                                times = NESTED_GROUP_TIMES,
                                tags = listOf("nested"),
                                entries = listOf(futureEntry()),
                                customData = mapOf(
                                    "nested-plugin" to CustomDataValue("nested state", META_TIME)
                                )
                            )
                        ),
                        customData = mapOf(
                            "group-plugin" to CustomDataValue("group state must stay", META_TIME)
                        )
                    )
                )
            }
        val withManagedPhotos = KeePassSecureItemPhotoAttachments.synchronize(
            database = database,
            entryUuid = CARD_ENTRY_UUID,
            itemType = ItemType.BANK_CARD,
            updates = mapOf(
                KeePassSecureItemPhotoAttachments.Slot.FRONT to KeePassSecureItemPhotoAttachments.SlotUpdate.Replace(CARD_FRONT_BYTES.copyOf()),
                KeePassSecureItemPhotoAttachments.Slot.BACK to KeePassSecureItemPhotoAttachments.SlotUpdate.Replace(CARD_BACK_BYTES.copyOf())
            )
        ).database
        val card = requireNotNull(findEntry(withManagedPhotos.content.group, CARD_ENTRY_UUID))
        assertManagedCard(withManagedPhotos, card, CARD_FRONT_BYTES, CARD_BACK_BYTES)
        val withDocumentPhotos = KeePassSecureItemPhotoAttachments.synchronize(
            database = withManagedPhotos,
            entryUuid = DOCUMENT_ENTRY_UUID,
            itemType = ItemType.DOCUMENT,
            updates = mapOf(
                KeePassSecureItemPhotoAttachments.Slot.FRONT to KeePassSecureItemPhotoAttachments.SlotUpdate.Replace(DOCUMENT_FRONT_BYTES.copyOf()),
                KeePassSecureItemPhotoAttachments.Slot.BACK to KeePassSecureItemPhotoAttachments.SlotUpdate.Replace(DOCUMENT_BACK_BYTES.copyOf())
            )
        ).database
        val document = requireNotNull(findEntry(withDocumentPhotos.content.group, DOCUMENT_ENTRY_UUID))
        assertManagedDocument(withDocumentPhotos, document, DOCUMENT_FRONT_BYTES, DOCUMENT_BACK_BYTES)
        val encoded = encode(withDocumentPhotos)
        val generated = decode(encoded, credentials())
        assertEquals("Monica Android interop", generated.content.meta.generator)
        assertEquals(cipherId, generated.header.cipherId)
        Files.write(target, encoded)
    }

    private fun verifyExport(
        source: Path,
        expectedCipherId: UUID,
        expectedUsername: String,
        expectedNotes: String,
        expectedCardHolder: String,
        expectedDocumentHolder: String
    ) {
        assertTrue("Extension export is missing: $source", Files.isRegularFile(source))
        val database = decode(Files.readAllBytes(source), credentials())
        assertTrue(database is KeePassDatabase.Ver4x)
        assertEquals(expectedCipherId, database.header.cipherId)
        assertEquals("KdbxWeb", database.content.meta.generator)
        assertEquals("Android KeePass interoperability", database.content.meta.name)
        assertEquals("Kotpass fixture for Monica Extension", database.content.meta.description)
        assertEquals("android-default", database.content.meta.defaultUser)
        assertEquals(
            "database state must stay",
            database.content.meta.customData.getValue("database-plugin").value
        )
        assertTrue(database.content.deletedObjects.isEmpty())

        val group = requireNotNull(findGroup(database.content.group, INTEROP_GROUP_UUID))
        assertEquals("Android Interop", group.name)
        assertEquals("group notes must stay", group.notes)
        assertEquals(listOf("android-group", "interop"), group.tags)
        assertEquals(GROUP_TIMES.creationTime, group.times?.creationTime)
        assertEquals(GROUP_TIMES.locationChanged, group.times?.locationChanged)
        assertEquals(GROUP_TIMES.usageCount, group.times?.usageCount)
        assertEquals("group state must stay", group.customData.getValue("group-plugin").value)

        val nested = requireNotNull(findGroup(group, NESTED_GROUP_UUID))
        assertEquals("Nested Future Group", nested.name)
        assertEquals("nested notes", nested.notes)
        assertEquals(listOf("nested"), nested.tags)
        assertEquals("nested state", nested.customData.getValue("nested-plugin").value)
        val future = nested.entries.single { it.uuid == FUTURE_ENTRY_UUID }
        assertEquals("future value must stay", future.fields.getValue("Future Plugin Field").content)
        assertTrue(future.fields.getValue("Future Protected Field") is EntryValue.Encrypted)
        assertEquals("future secret must stay", future.fields.getValue("Future Protected Field").content)

        val login = group.entries.single { it.uuid == LOGIN_ENTRY_UUID }
        assertEquals(ICON_UUID, login.customIconUuid)
        assertArrayEquals(ICON_BYTES, database.content.meta.customIcons.getValue(ICON_UUID).data)
        assertEquals("GitHub", login.fields.getValue("Title").content)
        assertEquals(expectedUsername, login.fields.getValue("UserName").content)
        assertEquals(expectedNotes, login.fields.getValue("Notes").content)
        assertEquals("old-password", login.fields.getValue("Password").content)
        assertTrue(login.fields.getValue("Password") is EntryValue.Encrypted)
        assertEquals("https://github.com", login.fields.getValue("URL").content)
        assertEquals(OTP_URI, login.fields.getValue("otp").content)
        assertEquals("JBSWY3DPEHPK3PXP", login.fields.getValue("TOTP Seed").content)
        assertTrue(login.fields.getValue("TOTP Seed") is EntryValue.Encrypted)
        assertEquals("period=30;digits=6;algorithm=SHA1", login.fields.getValue("TOTP Settings").content)
        assertEquals("9", login.fields.getValue("HOTP Counter").content)
        assertEquals("plugin must stay", login.fields.getValue("_etm_plugin_state").content)
        assertEquals("unknown must stay", login.fields.getValue("External Unknown Field").content)
        assertEquals("123456", login.fields.getValue("Recovery PIN").content)
        assertTrue(login.fields.getValue("Recovery PIN") is EntryValue.Encrypted)
        assertEquals(listOf("work", "totp"), login.tags)
        assertEquals(LOGIN_TIMES.creationTime, login.times?.creationTime)
        assertEquals(LOGIN_TIMES.locationChanged, login.times?.locationChanged)
        assertEquals(LOGIN_TIMES.expiryTime, login.times?.expiryTime)
        assertEquals(LOGIN_TIMES.expires, login.times?.expires)
        assertEquals(LOGIN_TIMES.usageCount, login.times?.usageCount)
        assertEquals("custom must stay", login.customData.getValue("plugin-state").value)
        assertAttachment(database, login)

        val card = group.entries.single { it.uuid == CARD_ENTRY_UUID }
        assertEquals("Android Bank Card", card.fields.getValue("Title").content)
        assertEquals(expectedCardHolder, card.fields.getValue("Card Holder").content)
        assertEquals("4111111111111111", card.fields.getValue("Card Number").content)
        assertManagedCard(database, card, CARD_FRONT_REPLACED_BYTES, CARD_BACK_BYTES)

        val document = group.entries.single { it.uuid == DOCUMENT_ENTRY_UUID }
        assertTrue(document.fields.getValue("MonicaItemData").content.contains("\"fullName\":\"$expectedDocumentHolder\""))
        assertManagedDocument(database, document, DOCUMENT_FRONT_REPLACED_BYTES, DOCUMENT_BACK_BYTES)

        assertEquals(2, login.history.size)
        val historical = login.history.single {
            it.uuid == HISTORY_ENTRY_UUID && it.fields.getValue("Title").content == "Historical title"
        }
        assertEquals("JBSWY3DPEHPK3PXP", historical.fields.getValue("TOTP Seed").content)
        assertTrue(historical.fields.getValue("TOTP Seed") is EntryValue.Encrypted)
        val extensionSnapshot = login.history.single {
            it.uuid == LOGIN_ENTRY_UUID && it.fields.getValue("Title").content == "GitHub"
        }
        assertEquals("octocat", extensionSnapshot.fields.getValue("UserName").content)
        assertEquals("original notes", extensionSnapshot.fields.getValue("Notes").content)
        assertTrue(extensionSnapshot.fields.getValue("Password") is EntryValue.Encrypted)
        assertEquals("old-password", extensionSnapshot.fields.getValue("Password").content)
        assertEquals("unknown must stay", extensionSnapshot.fields.getValue("External Unknown Field").content)
        assertAttachment(database, extensionSnapshot)

        val passkey = group.entries.single { it.uuid == PASSKEY_ENTRY_UUID }
        assertEquals("GitHub [Passkey]", passkey.fields.getValue("Title").content)
        assertEquals(PASSKEY_CREDENTIAL_ID, passkey.fields.getValue("MonicaPasskeyCredentialId").content)
        assertEquals("KEEPASS_COMPAT", passkey.fields.getValue("MonicaPasskeyMode").content)
        assertEquals(PASSKEY_PAYLOAD, passkey.fields.getValue("MonicaPasskeyData").content)
        assertTrue(passkey.fields.getValue("MonicaPasskeyData") is EntryValue.Encrypted)
        assertEquals(PRIVATE_KEY_PEM, passkey.fields.getValue("KPEX_PASSKEY_PRIVATE_KEY_PEM").content)
        assertTrue(passkey.fields.getValue("KPEX_PASSKEY_PRIVATE_KEY_PEM") is EntryValue.Encrypted)
        assertEquals(PASSKEY_CREDENTIAL_ID, passkey.fields.getValue("KPEX_PASSKEY_CREDENTIAL_ID").content)
        assertTrue(passkey.fields.getValue("KPEX_PASSKEY_CREDENTIAL_ID") is EntryValue.Encrypted)
        assertEquals("github-user-handle", passkey.fields.getValue("KPEX_PASSKEY_USER_HANDLE").content)
        assertTrue(passkey.fields.getValue("KPEX_PASSKEY_USER_HANDLE") is EntryValue.Encrypted)
        assertEquals("github.com", passkey.fields.getValue("KPEX_PASSKEY_RELYING_PARTY").content)
        assertEquals("true", passkey.fields.getValue("KPEX_PASSKEY_FLAG_BE").content)
        assertEquals("false", passkey.fields.getValue("KPEX_PASSKEY_FLAG_BS").content)
        assertEquals("passkey plugin must stay", passkey.fields.getValue("External Passkey Plugin Field").content)
        assertEquals(listOf("passkey"), passkey.tags)
        assertEquals(PASSKEY_TIMES.creationTime, passkey.times?.creationTime)
        assertEquals(PASSKEY_TIMES.usageCount, passkey.times?.usageCount)
        assertEquals("passkey custom must stay", passkey.customData.getValue("passkey-plugin-state").value)
        assertTrue(passkey.history.isEmpty())
        assertFalse(passkey.qualityCheck)
    }

    private fun loginEntry(attachment: BinaryData): Entry {
        val historyEntry = Entry(
            uuid = HISTORY_ENTRY_UUID,
            fields = EntryFields.of(
                "Title" to EntryValue.Plain("Historical title"),
                "TOTP Seed" to EntryValue.Encrypted(EncryptedValue.fromString("JBSWY3DPEHPK3PXP"))
            ),
            times = HISTORY_TIMES
        )
        return Entry(
            uuid = LOGIN_ENTRY_UUID,
            customIconUuid = ICON_UUID,
            fields = EntryFields.of(
                "Title" to EntryValue.Plain("GitHub"),
                "UserName" to EntryValue.Plain("octocat"),
                "Password" to EntryValue.Encrypted(EncryptedValue.fromString("old-password")),
                "URL" to EntryValue.Plain("https://github.com"),
                "Notes" to EntryValue.Plain("original notes"),
                "otp" to EntryValue.Plain(OTP_URI),
                "TOTP Seed" to EntryValue.Encrypted(EncryptedValue.fromString("JBSWY3DPEHPK3PXP")),
                "TOTP Settings" to EntryValue.Plain("period=30;digits=6;algorithm=SHA1"),
                "HOTP Counter" to EntryValue.Plain("9"),
                "_etm_plugin_state" to EntryValue.Plain("plugin must stay"),
                "External Unknown Field" to EntryValue.Plain("unknown must stay"),
                "Recovery PIN" to EntryValue.Encrypted(EncryptedValue.fromString("123456"))
            ),
            binaries = listOf(BinaryReference(hash = attachment.hash, name = ATTACHMENT_NAME)),
            history = listOf(historyEntry),
            tags = listOf("work", "totp"),
            customData = mapOf("plugin-state" to CustomDataValue("custom must stay", META_TIME)),
            times = LOGIN_TIMES
        )
    }

    private fun passkeyEntry(): Entry {
        return Entry(
            uuid = PASSKEY_ENTRY_UUID,
            fields = EntryFields.of(
                "Title" to EntryValue.Plain("GitHub [Passkey]"),
                "UserName" to EntryValue.Plain("octocat"),
                "Password" to EntryValue.Encrypted(EncryptedValue.fromString("")),
                "URL" to EntryValue.Plain("https://github.com"),
                "Notes" to EntryValue.Plain("passkey notes"),
                "MonicaPasskeyCredentialId" to EntryValue.Plain(PASSKEY_CREDENTIAL_ID),
                "MonicaPasskeyMode" to EntryValue.Plain("KEEPASS_COMPAT"),
                "MonicaPasskeyData" to EntryValue.Encrypted(EncryptedValue.fromString(PASSKEY_PAYLOAD)),
                "Passkey" to EntryValue.Plain(""),
                "KPEX_PASSKEY_USERNAME" to EntryValue.Plain("octocat"),
                "KPEX_PASSKEY_PRIVATE_KEY_PEM" to EntryValue.Encrypted(EncryptedValue.fromString(PRIVATE_KEY_PEM)),
                "KPEX_PASSKEY_CREDENTIAL_ID" to EntryValue.Encrypted(EncryptedValue.fromString(PASSKEY_CREDENTIAL_ID)),
                "KPEX_PASSKEY_USER_HANDLE" to EntryValue.Encrypted(EncryptedValue.fromString("github-user-handle")),
                "KPEX_PASSKEY_RELYING_PARTY" to EntryValue.Plain("github.com"),
                "KPEX_PASSKEY_FLAG_BE" to EntryValue.Plain("true"),
                "KPEX_PASSKEY_FLAG_BS" to EntryValue.Plain("false"),
                "External Passkey Plugin Field" to EntryValue.Plain("passkey plugin must stay")
            ),
            tags = listOf("passkey"),
            customData = mapOf(
                "passkey-plugin-state" to CustomDataValue("passkey custom must stay", META_TIME)
            ),
            times = PASSKEY_TIMES,
            qualityCheck = false
        )
    }

    private fun sshEntry(): Entry = Entry(
        uuid = SSH_ENTRY_UUID,
        fields = EntryFields.of(
            "Title" to EntryValue.Plain("Android SSH"),
            "Password" to EntryValue.Encrypted(EncryptedValue.fromString("")),
            "MonicaLoginType" to EntryValue.Plain("SSH_KEY"),
            *listOf("MonicaSshAlgorithm" to "RSA", "MonicaSshKeySize" to "4096", "MonicaSshPublicKey" to " ssh-rsa android-public\n", "MonicaSshPrivateKey" to SSH_PRIVATE_TEXT, "MonicaSshFingerprint" to "SHA256:synthetic", "MonicaSshComment" to SSH_COMMENT_TEXT, "MonicaSshFormat" to "PEM", "Future SSH Field" to "unknown SSH data").map { (name, value) -> name to EntryValue.Encrypted(EncryptedValue.fromString(value)) }.toTypedArray()
        )
    )

    private fun bankCardEntry(receipt: BinaryData): Entry {
        return Entry(
            uuid = CARD_ENTRY_UUID,
            fields = EntryFields.of(
                "Title" to EntryValue.Plain("Android Bank Card"),
                "UserName" to EntryValue.Plain(""),
                "Password" to EntryValue.Encrypted(EncryptedValue.fromString("")),
                "URL" to EntryValue.Plain(""),
                "Notes" to EntryValue.Plain("card notes"),
                "MonicaItemType" to EntryValue.Plain("BANK_CARD"),
                "Card Number" to EntryValue.Encrypted(EncryptedValue.fromString("4111111111111111")),
                "Card Holder" to EntryValue.Plain("Android Card Holder"),
                "Card Expiry" to EntryValue.Plain("12/2030"),
                "Card CVV" to EntryValue.Encrypted(EncryptedValue.fromString("123")),
                "Card Type" to EntryValue.Plain("CREDIT")
            ),
            binaries = listOf(BinaryReference(hash = receipt.hash, name = CARD_RECEIPT_NAME)),
            tags = listOf("wallet", "android-photo")
        )
    }

    private fun documentEntry(receipt: BinaryData): Entry {
        return Entry(
            uuid = DOCUMENT_ENTRY_UUID,
            fields = EntryFields.of(
                "Title" to EntryValue.Plain("Android Passport"),
                "UserName" to EntryValue.Plain(""),
                "Password" to EntryValue.Encrypted(EncryptedValue.fromString("")),
                "URL" to EntryValue.Plain(""),
                "Notes" to EntryValue.Plain("document notes"),
                "MonicaItemType" to EntryValue.Plain("DOCUMENT"),
                "MonicaItemData" to EntryValue.Encrypted(EncryptedValue.fromString(DOCUMENT_DATA))
            ),
            binaries = listOf(BinaryReference(hash = receipt.hash, name = DOCUMENT_RECEIPT_NAME)),
            tags = listOf("identity", "android-photo")
        )
    }

    private fun futureEntry(): Entry {
        return Entry(
            uuid = FUTURE_ENTRY_UUID,
            fields = EntryFields.of(
                "Title" to EntryValue.Plain("Future Plugin Entry"),
                "UserName" to EntryValue.Plain(""),
                "Password" to EntryValue.Encrypted(EncryptedValue.fromString("")),
                "URL" to EntryValue.Plain(""),
                "Notes" to EntryValue.Plain(""),
                "MonicaItemType" to EntryValue.Plain("FUTURE_PLUGIN_TYPE"),
                "Future Plugin Field" to EntryValue.Plain("future value must stay"),
                "Future Protected Field" to EntryValue.Encrypted(EncryptedValue.fromString("future secret must stay"))
            ),
            tags = listOf("future"),
            times = FUTURE_TIMES
        )
    }

    private fun assertAttachment(database: KeePassDatabase, entry: Entry) {
        val reference = entry.binaries.single { it.name == ATTACHMENT_NAME }
        val binary = database.binaries.getValue(reference.hash)
        val bytes = binary.inputStream().use { it.readBytes() }
        assertArrayEquals(ATTACHMENT_BYTES, bytes)
    }

    private fun assertManagedCard(
        database: KeePassDatabase,
        entry: Entry,
        expectedFront: ByteArray,
        expectedBack: ByteArray
    ) {
        val front = entry.binaries.single { it.name == CARD_FRONT_NAME }
        val back = entry.binaries.single { it.name == CARD_BACK_NAME }
        val receipt = entry.binaries.single { it.name == CARD_RECEIPT_NAME }
        assertArrayEquals(expectedFront, database.binaries.getValue(front.hash).inputStream().use { it.readBytes() })
        assertArrayEquals(expectedBack, database.binaries.getValue(back.hash).inputStream().use { it.readBytes() })
        assertArrayEquals(CARD_RECEIPT_BYTES, database.binaries.getValue(receipt.hash).inputStream().use { it.readBytes() })
    }

    private fun assertManagedDocument(
        database: KeePassDatabase,
        entry: Entry,
        expectedFront: ByteArray,
        expectedBack: ByteArray
    ) {
        val front = entry.binaries.single { it.name == DOCUMENT_FRONT_NAME }
        val back = entry.binaries.single { it.name == DOCUMENT_BACK_NAME }
        val receipt = entry.binaries.single { it.name == DOCUMENT_RECEIPT_NAME }
        assertArrayEquals(expectedFront, database.binaries.getValue(front.hash).inputStream().use { it.readBytes() })
        assertArrayEquals(expectedBack, database.binaries.getValue(back.hash).inputStream().use { it.readBytes() })
        assertArrayEquals(DOCUMENT_RECEIPT_BYTES, database.binaries.getValue(receipt.hash).inputStream().use { it.readBytes() })
    }

    private fun findEntry(group: Group, uuid: UUID): Entry? {
        group.entries.firstOrNull { it.uuid == uuid }?.let { return it }
        group.groups.forEach { child -> findEntry(child, uuid)?.let { return it } }
        return null
    }

    private fun findGroup(group: Group, uuid: UUID): Group? {
        if (group.uuid == uuid) return group
        group.groups.forEach { child ->
            val match = findGroup(child, uuid)
            if (match != null) return match
        }
        return null
    }

    private fun credentials(): Credentials {
        return Credentials.from(EncryptedValue.fromString(PASSWORD))
    }

    private fun encode(database: KeePassDatabase): ByteArray {
        return ByteArrayOutputStream().use { output ->
            database.encode(output, contentParser = KeePassCodecSupport.contentParser, cipherProviders = KeePassCodecSupport.cipherProviders)
            output.toByteArray()
        }
    }

    private fun decode(bytes: ByteArray, credentials: Credentials): KeePassDatabase {
        return KeePassDatabase.decode(
            ByteArrayInputStream(bytes),
            credentials,
            contentParser = KeePassCodecSupport.contentParser,
            cipherProviders = KeePassCodecSupport.cipherProviders
        )
    }

    private fun interopDirectory(): Path {
        val value = requireNotNull(System.getenv(INTEROP_DIRECTORY_ENV)) {
            "$INTEROP_DIRECTORY_ENV is required"
        }
        return Paths.get(value).toAbsolutePath().normalize()
    }

    companion object {
        private val ICON_UUID = UUID.fromString("20000000-0000-4000-8000-000000000099")
        private val ICON_BYTES = Base64.getDecoder().decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=")
        private const val INTEROP_DIRECTORY_ENV = "MONICA_KEEPASS_INTEROP_DIR"
        private const val PASSWORD = "monica-android-extension-interop-password"
        private const val ANDROID_AES_FILE = "android-aes.kdbx"
        private const val ANDROID_CHACHA20_FILE = "android-chacha20.kdbx"
        private const val ANDROID_TWOFISH_FILE = "android-twofish.kdbx"
        private const val EXTENSION_AES_FILE = "extension-aes.kdbx"
        private const val EXTENSION_CHACHA20_FILE = "extension-chacha20.kdbx"
        private const val ATTACHMENT_NAME = "recovery.txt"
        private const val CARD_FRONT_NAME = "Monica_BankCard_Front.jpg"
        private const val CARD_BACK_NAME = "Monica_BankCard_Back.jpg"
        private const val CARD_RECEIPT_NAME = "receipt.pdf"
        private const val DOCUMENT_FRONT_NAME = "Monica_Document_Front.jpg"
        private const val DOCUMENT_BACK_NAME = "Monica_Document_Back.jpg"
        private const val DOCUMENT_RECEIPT_NAME = "document-receipt.pdf"
        private const val OTP_URI = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
        private const val PASSKEY_CREDENTIAL_ID = "YW5kcm9pZC1pbnRlcm9wLWNyZWRlbnRpYWw"
        private const val PRIVATE_KEY_BASE64 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkW37q4De5OLmElVzGV+eVyxKWzUYTgiSmQGGNnkVvqKhRANCAATo31tQ78NEbm2ja6k1Omi1xPfSUGS3V74fv6x7WzvFrNxBDYm+FGmQVEiECyXmpcFTNeV0D/WFBONp8oJJZPn0"
        private const val PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----\n$PRIVATE_KEY_BASE64\n-----END PRIVATE KEY-----"
        private const val PASSKEY_PAYLOAD = "{\"credentialId\":\"$PASSKEY_CREDENTIAL_ID\",\"rpId\":\"github.com\",\"rpName\":\"GitHub\",\"userId\":\"github-user-handle\",\"userName\":\"octocat\",\"userDisplayName\":\"Octocat\",\"publicKeyAlgorithm\":-7,\"publicKey\":\"fixture-public-key\",\"privateKeyAlias\":\"$PRIVATE_KEY_BASE64\",\"createdAt\":1782259200000,\"lastUsedAt\":1782259800000,\"useCount\":3,\"iconUrl\":null,\"isDiscoverable\":true,\"isUserVerificationRequired\":true,\"transports\":\"internal\",\"aaguid\":\"00000000-0000-0000-0000-000000000000\",\"signCount\":4,\"notes\":\"passkey notes\",\"passkeyMode\":\"KEEPASS_COMPAT\"}"

        private val ATTACHMENT_BYTES = "recovery attachment from Monica Android".toByteArray(Charsets.UTF_8)
        private val CARD_FRONT_BYTES = "android bank card front photo".toByteArray(Charsets.UTF_8)
        private val CARD_BACK_BYTES = "android bank card back photo".toByteArray(Charsets.UTF_8)
        private val CARD_FRONT_REPLACED_BYTES = "extension replaced bank card front photo".toByteArray(Charsets.UTF_8)
        private val CARD_RECEIPT_BYTES = byteArrayOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37)
        private val DOCUMENT_FRONT_BYTES = "android document front photo".toByteArray(Charsets.UTF_8)
        private val DOCUMENT_BACK_BYTES = "android document back photo".toByteArray(Charsets.UTF_8)
        private val DOCUMENT_FRONT_REPLACED_BYTES = "extension replaced document front photo".toByteArray(Charsets.UTF_8)
        private val DOCUMENT_RECEIPT_BYTES = byteArrayOf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a)
        private const val DOCUMENT_DATA = "{\"documentType\":\"PASSPORT\",\"documentNumber\":\"P99887766\",\"fullName\":\"Android Document Holder\",\"firstName\":\"Android\",\"middleName\":\"\",\"lastName\":\"Document\",\"expiryDate\":\"2030-12-31\"}"
        private val META_TIME = Instant.parse("2026-06-24T00:00:00Z")
        private val INTEROP_GROUP_UUID = UUID.fromString("10000000-0000-4000-8000-000000000001")
        private val NESTED_GROUP_UUID = UUID.fromString("10000000-0000-4000-8000-000000000002")
        private val LOGIN_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000001")
        private val HISTORY_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000002")
        private val PASSKEY_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000003")
        private val FUTURE_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000004")
        private val CARD_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000005")
        private val DOCUMENT_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000006")
        private val SSH_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000007")
        private const val SSH_PRIVATE_TEXT = "\n-----BEGIN OPENSSH PRIVATE KEY-----\r\nsynthetic-private\r\n-----END OPENSSH PRIVATE KEY-----\n"
        private const val SSH_COMMENT_TEXT = " \tAndroid comment\r\n "
        private const val SSH_EDITED_COMMENT = " \tExtension comment\r\n "
        private const val SSH_RETURNED_COMMENT = " \tAndroid returned\r\n "
        private const val XML_PLAIN_TEXT = " \tAndroid plain text\nsecond line\t "
        private val GROUP_TIMES = timeData("2026-06-24T00:00:00Z", 4)
        private val NESTED_GROUP_TIMES = timeData("2026-06-24T00:05:00Z", 2)
        private val LOGIN_TIMES = timeData("2026-06-24T00:10:00Z", 7, expires = true)
        private val HISTORY_TIMES = timeData("2026-06-23T23:50:00Z", 1)
        private val PASSKEY_TIMES = timeData("2026-06-24T00:20:00Z", 3)
        private val FUTURE_TIMES = timeData("2026-06-24T00:30:00Z", 5)

        private fun timeData(
            instant: String,
            usageCount: Int,
            expires: Boolean = false
        ): TimeData {
            val base = Instant.parse(instant)
            return TimeData(
                creationTime = base,
                lastAccessTime = base.plusSeconds(60),
                lastModificationTime = base.plusSeconds(120),
                locationChanged = base.plusSeconds(180),
                expiryTime = if (expires) base.plusSeconds(86_400) else null,
                expires = expires,
                usageCount = usageCount
            )
        }
    }
}
