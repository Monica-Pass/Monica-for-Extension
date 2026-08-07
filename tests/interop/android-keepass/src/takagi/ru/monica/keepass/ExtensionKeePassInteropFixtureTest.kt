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
import takagi.ru.monica.utils.KeePassCodecSupport
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.time.Instant
import java.util.UUID

class ExtensionKeePassInteropFixtureTest {

    @Test
    fun generateAndroidKdbxFixtures() {
        val output = interopDirectory()
        Files.createDirectories(output)
        writeFixture(output.resolve(ANDROID_AES_FILE), BaseCiphers.Aes.uuid)
        writeFixture(output.resolve(ANDROID_CHACHA20_FILE), BaseCiphers.ChaCha20.uuid)
        writeFixture(output.resolve(ANDROID_TWOFISH_FILE), TwofishCipher.uuid)
    }

    @Test
    fun verifyExtensionKdbxExports() {
        val output = interopDirectory()
        verifyExport(
            output.resolve(EXTENSION_AES_FILE),
            BaseCiphers.Aes.uuid,
            "extension-aes-user",
            "Edited by Monica Extension through AES-256"
        )
        verifyExport(
            output.resolve(EXTENSION_CHACHA20_FILE),
            BaseCiphers.ChaCha20.uuid,
            "extension-chacha20-user",
            "Edited by Monica Extension through ChaCha20"
        )
    }

    private fun writeFixture(target: Path, cipherId: UUID) {
        val credentials = credentials()
        val attachment = BinaryData.Uncompressed(
            memoryProtection = false,
            rawContent = ATTACHMENT_BYTES.copyOf()
        )
        val base = KeePassDatabase.Ver4x.create(
            rootName = "Root",
            meta = Meta(
                generator = "Monica Android interop",
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
            .modifyBinaries { binaries -> binaries + (attachment.hash to attachment) }
            .modifyParentGroup {
                copy(
                    groups = groups + Group(
                        uuid = INTEROP_GROUP_UUID,
                        name = "Android Interop",
                        notes = "group notes must stay",
                        times = GROUP_TIMES,
                        tags = listOf("android-group", "interop"),
                        entries = listOf(loginEntry(attachment), passkeyEntry()),
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
        val encoded = encode(database)
        val generated = decode(encoded, credentials())
        assertEquals("Monica Android interop", generated.content.meta.generator)
        assertEquals(cipherId, generated.header.cipherId)
        Files.write(target, encoded)
    }

    private fun verifyExport(
        source: Path,
        expectedCipherId: UUID,
        expectedUsername: String,
        expectedNotes: String
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
            database.encode(output, cipherProviders = KeePassCodecSupport.cipherProviders)
            output.toByteArray()
        }
    }

    private fun decode(bytes: ByteArray, credentials: Credentials): KeePassDatabase {
        return KeePassDatabase.decode(
            ByteArrayInputStream(bytes),
            credentials,
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
        private const val INTEROP_DIRECTORY_ENV = "MONICA_KEEPASS_INTEROP_DIR"
        private const val PASSWORD = "monica-android-extension-interop-password"
        private const val ANDROID_AES_FILE = "android-aes.kdbx"
        private const val ANDROID_CHACHA20_FILE = "android-chacha20.kdbx"
        private const val ANDROID_TWOFISH_FILE = "android-twofish.kdbx"
        private const val EXTENSION_AES_FILE = "extension-aes.kdbx"
        private const val EXTENSION_CHACHA20_FILE = "extension-chacha20.kdbx"
        private const val ATTACHMENT_NAME = "recovery.txt"
        private const val OTP_URI = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
        private const val PASSKEY_CREDENTIAL_ID = "YW5kcm9pZC1pbnRlcm9wLWNyZWRlbnRpYWw"
        private const val PRIVATE_KEY_BASE64 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgkW37q4De5OLmElVzGV+eVyxKWzUYTgiSmQGGNnkVvqKhRANCAATo31tQ78NEbm2ja6k1Omi1xPfSUGS3V74fv6x7WzvFrNxBDYm+FGmQVEiECyXmpcFTNeV0D/WFBONp8oJJZPn0"
        private const val PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----\n$PRIVATE_KEY_BASE64\n-----END PRIVATE KEY-----"
        private const val PASSKEY_PAYLOAD = "{\"credentialId\":\"$PASSKEY_CREDENTIAL_ID\",\"rpId\":\"github.com\",\"rpName\":\"GitHub\",\"userId\":\"github-user-handle\",\"userName\":\"octocat\",\"userDisplayName\":\"Octocat\",\"publicKeyAlgorithm\":-7,\"publicKey\":\"fixture-public-key\",\"privateKeyAlias\":\"$PRIVATE_KEY_BASE64\",\"createdAt\":1782259200000,\"lastUsedAt\":1782259800000,\"useCount\":3,\"iconUrl\":null,\"isDiscoverable\":true,\"isUserVerificationRequired\":true,\"transports\":\"internal\",\"aaguid\":\"00000000-0000-0000-0000-000000000000\",\"signCount\":4,\"notes\":\"passkey notes\",\"passkeyMode\":\"KEEPASS_COMPAT\"}"

        private val ATTACHMENT_BYTES = "recovery attachment from Monica Android".toByteArray(Charsets.UTF_8)
        private val META_TIME = Instant.parse("2026-06-24T00:00:00Z")
        private val INTEROP_GROUP_UUID = UUID.fromString("10000000-0000-4000-8000-000000000001")
        private val NESTED_GROUP_UUID = UUID.fromString("10000000-0000-4000-8000-000000000002")
        private val LOGIN_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000001")
        private val HISTORY_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000002")
        private val PASSKEY_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000003")
        private val FUTURE_ENTRY_UUID = UUID.fromString("20000000-0000-4000-8000-000000000004")
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
