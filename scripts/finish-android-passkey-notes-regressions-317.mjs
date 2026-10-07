import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
for (const [label, variant] of [['main', 'Monica for Android'], ['fdroid', 'fdroid']]) {
  const project = path.join(root, 'Monica-main', variant);
  const file = path.join(project, 'app/src/main/java/takagi/ru/monica/bitwarden/mapper/PasskeyMapper.kt');
  const current = await readFile(file, 'utf8');
  const baseline = (await readFile(path.join(root, 'monica-extension/.tmp/android-passkey-fixes-317/original', label, 'bitwarden/mapper/PasskeyMapper.kt'), 'utf8')).replaceAll('\r\n', '\n');
  const start = baseline.indexOf('    private fun buildPasskeyNotes(');
  const end = baseline.indexOf('    /**\n     * 从 URI', start);
  if (start < 0 || end < 0 || !current.includes('notes = item.notes')) throw new Error('Unexpected mapper state');
  const legacy = baseline.slice(start, end).replace('buildPasskeyNotes(', 'buildLegacyReferenceNotes(')
    .replace('        val userNotes = item.notes\n            .substringBefore("---")\n            .trim()', '        val userNotes = item.notes')
    .replace('userNotes.isNotBlank()', 'userNotes.isNotEmpty()');
  const updated = current.replaceAll('\r\n', '\n').replace('notes = item.notes',
    'notes = if (fido2Credentials.isNullOrEmpty()) buildLegacyReferenceNotes(item) else item.notes')
    .replace('    /**\n     * 从 URI', '    // Non-exportable legacy references still need their recovery metadata.\n' + legacy + '    /**\n     * 从 URI');
  await writeFile(file, current.includes('\r\n') ? updated.replaceAll('\n', '\r\n') : updated);
  await writeFile(path.join(project, 'app/src/test/java/takagi/ru/monica/bitwarden/mapper/PasskeyMapperInteropTest.kt'), `package takagi.ru.monica.bitwarden.mapper

import java.security.KeyPairGenerator
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import takagi.ru.monica.bitwarden.api.CipherApiResponse
import takagi.ru.monica.data.PasskeyEntry
import takagi.ru.monica.passkey.PasskeyCredentialIdCodec

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class PasskeyMapperInteropTest {
    private val mapper = PasskeyMapper()
    private val registeredId = "sPRk4p1Z8GKaHlkk_iwpSRZ5B9HeqPZNWg5optdhDfI"
    private fun row(key: String, algorithm: Int = -7, notes: String = "") = PasskeyEntry(
        credentialId = registeredId, rpId = "example.com", rpName = "Example", userId = "dXNlcg",
        userName = "account", userDisplayName = "Account", privateKeyAlias = key, publicKey = "",
        publicKeyAlgorithm = algorithm, notes = notes, signCount = 0xffffffffL)

    @Test fun ecAndRsaPrivateKeysIdsCountersAndNotesSurviveRepeatedNativeMapping() {
        for ((algorithm, cose, signatureName) in listOf(Triple("EC", -7, "SHA256withECDSA"), Triple("RSA", -257, "SHA256withRSA"))) {
            val generator = KeyPairGenerator.getInstance(algorithm)
            generator.initialize(if (algorithm == "EC") 256 else 2048)
            val original = generator.generateKeyPair()
            for (notes in listOf("", "  ", "before---after", " 中文\\r\\n---\\r\\nnotes ")) {
                var item = row(Base64.getEncoder().encodeToString(original.private.encoded), cose, notes)
                repeat(3) {
                    val request = mapper.toCreateRequest(item, null)
                    assertEquals(notes, request.notes)
                    assertEquals("4294967295", request.login!!.fido2Credentials!!.single().counter)
                    item = mapper.fromCipherResponse(CipherApiResponse(id = "synthetic", name = request.name,
                        notes = request.notes, login = request.login), 1)
                    assertEquals(notes, item.notes)
                    assertEquals(registeredId, PasskeyCredentialIdCodec.toWebAuthnId(item.credentialId))
                    assertArrayEquals(original.private.encoded, Base64.getDecoder().decode(item.privateKeyAlias))
                    assertEquals(0xffffffffL, item.signCount)
                }
                val restored = KeyFactory.getInstance(algorithm).generatePrivate(PKCS8EncodedKeySpec(Base64.getDecoder().decode(item.privateKeyAlias)))
                val message = "registered key regression".toByteArray()
                val signature = Signature.getInstance(signatureName).run { initSign(restored); update(message); sign() }
                assertTrue(Signature.getInstance(signatureName).run { initVerify(original.public); update(message); verify(signature) })
            }
        }
    }

    @Test fun nonExportableLegacyReferenceRetainsRecoveryMetadataAndExactUserNotes() {
        val item = row("old-device-keystore-alias", notes = "  existing---note\\n ")
        val request = mapper.toCreateRequest(item, null)
        assertNull(request.login!!.fido2Credentials)
        val returned = mapper.fromCipherResponse(CipherApiResponse(id = "legacy", name = request.name,
            notes = request.notes, login = request.login), 1)
        assertEquals(item.credentialId, returned.credentialId)
        assertEquals(item.userId, returned.userId)
        assertEquals(item.notes, returned.notes)
        assertEquals("REFERENCE", returned.syncStatus)
    }
}
`);
}
console.log('Preserved legacy reference metadata and added EC/RSA/notes mapper round trips');
