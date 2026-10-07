import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../../Monica-main');
const tests = {
'passkey/PasskeyCredentialIdCodecTest.kt': `package takagi.ru.monica.passkey

import java.util.Base64
import org.junit.Assert.*
import org.junit.Test

class PasskeyCredentialIdCodecTest {
    @Test fun originalBytesSurviveAllSupportedCarriers() {
        for (length in listOf(1, 2, 3, 16, 32, 64, 128)) {
            val bytes = ByteArray(length) { (it * 17 + 251).toByte() }
            val url = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
            val forms = mutableListOf(url, Base64.getEncoder().encodeToString(bytes), "b64.$url")
            if (length == 16) forms += requireNotNull(PasskeyCredentialIdCodec.normalize(url))
            for (form in forms) {
                assertEquals(url, PasskeyCredentialIdCodec.toWebAuthnId(form))
                val exported = requireNotNull(PasskeyCredentialIdCodec.toBitwardenCredentialId(form))
                assertEquals(url, PasskeyCredentialIdCodec.toWebAuthnId(exported))
                assertEquals(length != 16, exported.startsWith("b64."))
                assertArrayEquals(bytes, Base64.getUrlDecoder().decode(PasskeyCredentialIdCodec.toWebAuthnId(exported)))
            }
        }
    }

    @Test fun actualEdgeRegisteredIdIsNotReinterpretedAsPrefixBytes() {
        val id = "sPRk4p1Z8GKaHlkk_iwpSRZ5B9HeqPZNWg5optdhDfI"
        assertEquals(id, PasskeyCredentialIdCodec.toWebAuthnId("b64.$id"))
        assertEquals("b64.$id", PasskeyCredentialIdCodec.toBitwardenCredentialId(id))
        val alreadyCorrupted = "b64sPRk4p1Z8GKaHlkk_iwpSRZ5B9HeqPZNWg5optdhDfA"
        assertEquals(alreadyCorrupted, PasskeyCredentialIdCodec.toWebAuthnId(alreadyCorrupted))
    }

    @Test fun malformedLegacyTextIsPreservedAndCannotAuthorizeARequest() {
        for (id in listOf("b64.", "b64..AA", "bw_ref_cipher", "a", "AB", "AA=", "AA===", "AAAA=", "A A", "1-1-1-1-1", "AA+_")) {
            assertEquals(id, PasskeyCredentialIdCodec.normalize(id))
            assertEquals(id, PasskeyCredentialIdCodec.toWebAuthnId(id))
            assertEquals(id, PasskeyCredentialIdCodec.toBitwardenCredentialId(id))
            assertFalse(id, PasskeyCredentialIdCodec.isValid(id))
        }
        assertNull(PasskeyCredentialIdCodec.normalize(" "))
    }

    @Test fun uuidRepresentationRetainsNetworkByteOrder() {
        val uuid = "00112233-4455-6677-8899-aabbccddeeff"
        assertEquals("ABEiM0RVZneImaq7zN3u_w", PasskeyCredentialIdCodec.toWebAuthnId(uuid))
        assertEquals(uuid, PasskeyCredentialIdCodec.normalize("b64.ABEiM0RVZneImaq7zN3u_w"))
    }
}
`,
'passkey/PasskeyGetRequestPolicyTest.kt': `package takagi.ru.monica.passkey

import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import takagi.ru.monica.data.PasskeyEntry

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class PasskeyGetRequestPolicyTest {
    private val id = "sPRk4p1Z8GKaHlkk_iwpSRZ5B9HeqPZNWg5optdhDfI"
    private fun request(allow: String = "") = """{"rpId":"example.com","challenge":"Y2hhbGxlbmdl"$allow}"""
    private fun row() = PasskeyEntry(credentialId = "b64.$id", rpId = "example.com",
        rpName = "Example", userId = "dXNlcg", userName = "account", userDisplayName = "Account",
        publicKey = "unchanged-public-key", privateKeyAlias = "unchanged-private-key", notes = "private note")

    @Test fun allowedOldNonDiscoverableCredentialStillWorks() {
        val policy = PasskeyGetRequestPolicy.parse(request(""", "allowCredentials":[{"type":"public-key","id":"$id"}]"""))
        assertTrue(policy.allows(row().copy(isDiscoverable = false)))
        assertFalse(policy.allows(row().copy(credentialId = "AA")))
        assertFalse(policy.allows(row().copy(rpId = "evil.example.com")))
    }

    @Test fun absentAndEmptyAllowListsKeepExistingRpDiscoveryCompatibility() {
        for (allow in listOf("", """, "allowCredentials":[]""")) {
            val policy = PasskeyGetRequestPolicy.parse(request(allow))
            assertTrue(policy.allows(row()))
            assertFalse(policy.allows(row().copy(rpId = "other.test")))
        }
    }

    @Test fun unknownAllowListNeverFallsBackToAnotherCredential() {
        val policy = PasskeyGetRequestPolicy.parse(request(""", "allowCredentials":[{"type":"public-key","id":"AA"}]"""))
        repeat(3) { assertFalse(policy.allows(row())) }
    }

    @Test fun malformedNonemptyAllowListsAreRejectedRatherThanBecomingDiscovery() {
        for (value in listOf("null", "{}", "false", "[null]", "[{}]", """[{"type":"password","id":"AA"}]""",
            """[{"type":"public-key","id":"b64..AA"}]""", """[{"type":"public-key","id":23}]""",
            """[{"type":"public-key","id":"AA"},{}]""")) {
            assertThrows(IllegalArgumentException::class.java) { PasskeyGetRequestPolicy.parse(request(""", "allowCredentials":$value""")) }
        }
    }

    @Test fun finalPlatformRequestMustMatchCeremonyAndIndependentlyAllowSelection() {
        val original = PasskeyGetRequestPolicy.parse(request())
        assertFalse(original.isSameCeremony(PasskeyGetRequestPolicy.parse(request().replace("Y2hhbGxlbmdl", "bmV3"))))
        assertFalse(original.isSameCeremony(PasskeyGetRequestPolicy.parse(request().replace("example.com", "other.test"))))
        val restricted = PasskeyGetRequestPolicy.parse(request(""", "allowCredentials":[{"type":"public-key","id":"AA"}]"""))
        assertTrue(original.isSameCeremony(restricted))
        assertFalse(restricted.allows(row()))
    }

    @Test fun authenticationTitleKeepsNotesPrivateAndManagementTitleUnchanged() {
        val passkey = row()
        assertEquals("Account", passkey.authenticationTitle())
        assertEquals("private note", passkey.displayTitle())
        assertEquals("account", passkey.copy(userDisplayName = "").authenticationTitle())
        assertEquals("Example", passkey.copy(userDisplayName = "", userName = "").authenticationTitle())
    }
}
`,
'bitwarden/mapper/PasskeyNotesCodecTest.kt': `package takagi.ru.monica.bitwarden.mapper

import org.junit.Assert.*
import org.junit.Test

class PasskeyNotesCodecTest {
    @Test fun ordinaryNotesAreExactIncludingSeparatorsWhitespaceAndExplicitClear() {
        for (notes in listOf("", "  ", "first---second", " before\\r\\n---\\r\\nafter ", "[Monica Passkey Metadata]\\nmy own text", "中文\\n🔐 private")) {
            var returned = notes
            repeat(5) { returned = PasskeyNotesCodec.decode(returned) }
            assertEquals(notes, returned)
        }
        assertEquals("", PasskeyNotesCodec.decode(null))
    }

    @Test fun completeHistoricalFooterIsRecognizedWithoutEatingOrdinarySeparators() {
        val footer = "\\n🔐 This is a Passkey entry synced from Monica\\n" +
            "ℹ️ Private key availability depends on client capability.\\n\\n---\\n[Monica Passkey Metadata]\\n" +
            "credentialId: AA\\nrpId: example.com\\nrpName: Example\\nuserId: dXNlcg\\nuserDisplayName: User\\n" +
            "publicKeyAlgorithm: -7\\nsignCount: 0\\ncreatedAt: 1\\nlastUsedAt: 2\\n"
        assertEquals("", PasskeyNotesCodec.decode(footer))
        assertEquals("first---second", PasskeyNotesCodec.decode("first---second\\n" + footer))
        assertEquals(footer + "extra user content", PasskeyNotesCodec.decode(footer + "extra user content"))
        assertEquals(footer.replace("signCount: 0", "signCount: invalid"), PasskeyNotesCodec.decode(footer.replace("signCount: 0", "signCount: invalid")))
    }
}
`
};
for (const variant of ['Monica for Android', 'fdroid']) {
  for (const [file, text] of Object.entries(tests)) {
    const target = path.join(root, variant, 'app/src/test/java/takagi/ru/monica', file);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, text);
  }
  const guard = path.join(root, variant, 'app/src/test/java/takagi/ru/monica/passkey/PasskeyRemarkAndNavigationGuardTest.kt');
  const before = await readFile(guard, 'utf8');
  await writeFile(guard, before.replace('fun credentialSelectorUsesRemarkFirstTitle()', 'fun credentialSelectorUsesAccountTitleWithoutNotes()')
    .replace('provider.contains("passkey.displayTitle()")', 'provider.contains("passkey.authenticationTitle()")')
    .replace('authActivity.contains("title = passkey.displayTitle()")', 'authActivity.contains("title = passkey.authenticationTitle()")'));
}
console.log('Wrote old-format and strict-request regression tests in both variants');
