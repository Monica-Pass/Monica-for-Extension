import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const variants = ['Monica for Android', 'fdroid'];
const replace = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error(`Expected one match: ${from.slice(0, 100)}`);
  return text.replace(from, to);
};
const codec = `package takagi.ru.monica.passkey

import java.nio.ByteBuffer
import java.util.Base64
import java.util.UUID

/** Lossless conversion between WebAuthn bytes, UUID and Bitwarden's b64. carrier. */
object PasskeyCredentialIdCodec {
    private val uuidPattern = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    private val base64Pattern = Regex("[A-Za-z0-9_+/\\\\-]+={0,2}")

    fun normalize(credentialId: String?): String? {
        val raw = credentialId?.trim().orEmpty()
        if (raw.isEmpty()) return null
        val bytes = decode(raw) ?: return raw
        return if (bytes.size == 16) {
            val buffer = ByteBuffer.wrap(bytes)
            UUID(buffer.long, buffer.long).toString()
        } else encode(bytes)
    }

    fun toWebAuthnId(credentialId: String?): String? {
        val raw = credentialId?.trim().orEmpty()
        if (raw.isEmpty()) return null
        return decode(raw)?.let(::encode) ?: raw
    }

    fun toBitwardenCredentialId(credentialId: String?): String? {
        val normalized = normalize(credentialId) ?: return null
        if (uuidPattern.matches(normalized)) return normalized
        return decode(normalized)?.let { "b64." + encode(it) } ?: normalized
    }

    fun isValid(credentialId: String): Boolean = decode(credentialId) != null

    private fun decode(raw: String): ByteArray? {
        if (uuidPattern.matches(raw)) {
            val uuid = UUID.fromString(raw)
            return ByteBuffer.allocate(16).putLong(uuid.mostSignificantBits)
                .putLong(uuid.leastSignificantBits).array()
        }
        val encoded = if (raw.startsWith("b64.", ignoreCase = true)) raw.substring(4) else raw
        if (!base64Pattern.matches(encoded)) return null
        if (encoded.any { it == '+' || it == '/' } && encoded.any { it == '-' || it == '_' }) return null
        val unpadded = encoded.trimEnd('=')
        if (unpadded.length % 4 == 1) return null
        val padding = encoded.length - unpadded.length
        if (padding > 0 && (encoded.length % 4 != 0 || padding != (4 - unpadded.length % 4) % 4)) return null
        val canonical = unpadded.replace('+', '-').replace('/', '_')
        val decoded = runCatching { Base64.getUrlDecoder().decode(canonical) }.getOrNull() ?: return null
        // Reject discarded nonzero pad bits instead of silently changing a registered ID.
        return decoded.takeIf { it.isNotEmpty() && encode(it) == canonical }
    }

    private fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
`;
const policy = `package takagi.ru.monica.passkey

import org.json.JSONArray
import org.json.JSONObject
import takagi.ru.monica.data.PasskeyEntry

/** A malformed allow-list must never turn into an unrestricted discovery request. */
internal data class PasskeyGetRequestPolicy(
    val rpId: String,
    val challenge: String,
    val allowedCredentialIds: Set<String>?,
) {
    fun allows(passkey: PasskeyEntry): Boolean =
        PasskeyRpIdNormalizer.isEquivalent(rpId, passkey.rpId) &&
            (allowedCredentialIds == null || PasskeyCredentialIdCodec.normalize(passkey.credentialId) in allowedCredentialIds)

    fun isSameCeremony(other: PasskeyGetRequestPolicy): Boolean =
        PasskeyRpIdNormalizer.isEquivalent(rpId, other.rpId) && challenge == other.challenge

    companion object {
        fun parse(requestJson: String): PasskeyGetRequestPolicy {
            val json = JSONObject(requestJson)
            val rpId = json.opt("rpId") as? String
            require(!rpId.isNullOrBlank()) { "Missing relying party ID" }
            val challenge = json.opt("challenge") as? String
            require(!challenge.isNullOrBlank()) { "Missing challenge" }
            var allowed: Set<String>? = null
            if (json.has("allowCredentials")) {
                val list = json.opt("allowCredentials") as? JSONArray
                    ?: throw IllegalArgumentException("Invalid allowCredentials")
                if (list.length() > 0) {
                    allowed = (0 until list.length()).map { index ->
                        val descriptor = list.optJSONObject(index)
                            ?: throw IllegalArgumentException("Invalid credential descriptor")
                        require(descriptor.opt("type") == "public-key") { "Invalid credential type" }
                        val id = descriptor.opt("id") as? String
                        require(id != null && PasskeyCredentialIdCodec.isValid(id)) { "Invalid credential ID" }
                        requireNotNull(PasskeyCredentialIdCodec.normalize(id))
                    }.toSet()
                }
            }
            return PasskeyGetRequestPolicy(rpId, challenge, allowed)
        }
    }
}
`;
for (const variant of variants) {
  const base = path.join(root, 'Monica-main', variant, 'app/src/main/java/takagi/ru/monica');
  const edit = async (file, update) => {
    const target = path.join(base, file);
    const old = await readFile(target, 'utf8');
    const next = update(old.replaceAll('\r\n', '\n'));
    await writeFile(target, old.includes('\r\n') ? next.replaceAll('\n', '\r\n') : next);
  };
  await writeFile(path.join(base, 'passkey/PasskeyCredentialIdCodec.kt'), codec);
  await writeFile(path.join(base, 'passkey/PasskeyGetRequestPolicy.kt'), policy);
  await edit('data/PasskeyEntry.kt', s => replace(s, '    /** Monica 展示名称', `    /** Authentication surfaces show account identity without disclosing vault notes. */
    fun authenticationTitle(): String = userDisplayName.trim()
        .ifBlank { userName.trim() }
        .ifBlank { rpName.trim() }
        .ifBlank { rpId.trim() }

    /** Monica 展示名称`));
  await edit('passkey/MonicaCredentialProviderService.kt', s => {
    const start = s.indexOf('            val json = JSONObject(requestJson)', s.indexOf('private suspend fun handleBeginGetPasskeyRequest'));
    const end = s.indexOf('            warmUpDatabase()', start);
    if (start < 0 || end < 0) throw new Error('Provider parse block missing');
    s = s.slice(0, start) + `            val request = PasskeyGetRequestPolicy.parse(requestJson)
            val rpId = request.rpId
            val allowedCredentialIds = request.allowedCredentialIds.orEmpty()

` + s.slice(end);
    const fallbackStart = s.indexOf('            // Some OEMs/request payloads');
    const fallbackEnd = s.indexOf('            // Right after app update', fallbackStart);
    s = s.slice(0, fallbackStart) + s.slice(fallbackEnd);
    s = s.replaceAll(',\n                strictAllowCredentials = true', '').replaceAll(',\n                    strictAllowCredentials = false', '');
    s = replace(s, '        allowedCredentialIds: Set<String>,\n        strictAllowCredentials: Boolean', '        allowedCredentialIds: Set<String>');
    s = replace(s, 'allowedCredentialIds.isNotEmpty() && strictAllowCredentials', 'allowedCredentialIds.isNotEmpty()');
    return replace(s, 'passkey.displayTitle()', 'passkey.authenticationTitle()');
  });
  await edit('passkey/PasskeyAuthActivity.kt', s => {
    s = replace(s, 'import androidx.activity.compose.setContent', 'import androidx.activity.compose.setContent\nimport androidx.activity.addCallback');
    s = replace(s, 'import androidx.credentials.exceptions.GetCredentialUnknownException', 'import androidx.credentials.exceptions.GetCredentialUnknownException\nimport androidx.credentials.exceptions.GetCredentialCancellationException');
    s = replace(s, '    private var passkey: PasskeyEntry? = null', `    private var resultFinished = false
    private var signingStarted = false
    private var biometricInFlight = false
    private var verificationAttempt = 0
    private var passkey: PasskeyEntry? = null`);
    s = replace(s, '        Log.i(TAG, "PasskeyAuthActivity onCreate")', `        onBackPressedDispatcher.addCallback(this) { cancelAuthentication() }
        Log.i(TAG, "PasskeyAuthActivity onCreate")`);
    const hashStart = s.indexOf('            // 获取 clientDataHash（如果提供）');
    const hashEnd = s.indexOf('\n        }', hashStart);
    s = s.slice(0, hashStart) + s.slice(hashEnd);
    s = replace(s, '        val requestJson = intent.getStringExtra', '        var requestJson = intent.getStringExtra');
    s = replace(s, '            if (passkey == null) {\n                passkey = database.passkeyDao().getPasskeyById(credentialId)', '            if (passkey == null && recordId <= 0L) {\n                passkey = database.passkeyDao().getPasskeyById(credentialId)');
    s = replace(s, '                    } ?: all.firstOrNull { normalizeCredentialId(it.credentialId) == normalizedId }', '                    }');
    s = replace(s, '        val shadowEnabled =', `        // The selected row and the final platform option must describe the same ceremony.
        // Never sign an Intent extra alone or use an unrelated option's clientDataHash.
        try {
            val original = PasskeyGetRequestPolicy.parse(requestJson)
            require(original.allows(currentPasskey)) { "Credential not allowed for this request" }
            val actualOption = providerRequest?.credentialOptions
                ?.filterIsInstance<GetPublicKeyCredentialOption>()
                ?.firstOrNull { option ->
                    runCatching {
                        val actual = PasskeyGetRequestPolicy.parse(option.requestJson)
                        original.isSameCeremony(actual) && actual.allows(currentPasskey)
                    }.getOrDefault(false)
                } ?: throw IllegalArgumentException("Missing matching platform credential request")
            requestJson = actualOption.requestJson
            pendingClientDataHash = actualOption.clientDataHash
        } catch (error: Exception) {
            val resultIntent = Intent()
            PendingIntentHandler.setGetCredentialException(resultIntent, GetCredentialUnknownException(error.message))
            setResult(Activity.RESULT_OK, resultIntent)
            resultFinished = true
            finish()
            return
        }

        val shadowEnabled =`);
    s = replace(s, `                        // 用户取消生物识别时，提供主密码验证回退
                        showMasterPasswordDialog.value = true`, '                        cancelAuthentication()');
    s = replace(s, `                    onUseMasterPassword = {
                        showMasterPasswordDialog.value = true
                    }`, '                    onUseMasterPassword = { openMasterPassword() }');
    s = replace(s, '                        onConfirm = { password ->\n                            if', '                        onConfirm = passwordConfirm@{ password ->\n                            if (resultFinished || signingStarted || isFinishing) return@passwordConfirm\n                            if');
    s = replace(s, '    private fun requestBiometricAuth(passkey: PasskeyEntry) {', `    private fun openMasterPassword() {
        if (resultFinished || signingStarted || isFinishing) return
        verificationAttempt++
        biometricInFlight = false
        biometricHelper.cancelAuthentication()
        showMasterPasswordDialog.value = true
    }

    private fun cancelAuthentication() {
        if (resultFinished || signingStarted) return
        resultFinished = true
        verificationAttempt++
        biometricInFlight = false
        showMasterPasswordDialog.value = false
        biometricHelper.cancelAuthentication()
        val resultIntent = Intent()
        PendingIntentHandler.setGetCredentialException(resultIntent, GetCredentialCancellationException())
        setResult(Activity.RESULT_OK, resultIntent)
        finish()
    }

    override fun onDestroy() {
        verificationAttempt++
        biometricHelper.cancelAuthentication()
        super.onDestroy()
    }

    private fun requestBiometricAuth(passkey: PasskeyEntry) {
        if (resultFinished || signingStarted || biometricInFlight || isFinishing) return
        biometricInFlight = true
        val attempt = ++verificationAttempt`);
    s = replace(s, `            showMasterPasswordDialog.value = true
            return`, `            biometricInFlight = false
            showMasterPasswordDialog.value = true
            return`);
    s = replace(s, '            onSuccess = {\n                repository', `            onSuccess = success@{
                if (attempt != verificationAttempt || resultFinished || signingStarted || isFinishing) return@success
                biometricInFlight = false
                repository`);
    s = replace(s, '            onError = { errorCode, errString ->\n                repository', `            onError = failure@{ errorCode, errString ->
                if (attempt != verificationAttempt || resultFinished || signingStarted || isFinishing) return@failure
                biometricInFlight = false
                repository`);
    s = replace(s, '            onCancel = {\n                repository', `            onCancel = cancelled@{
                if (attempt != verificationAttempt || resultFinished || signingStarted || isFinishing) return@cancelled
                repository`);
    s = replace(s, `                // 用户取消时，提供主密码验证回退
                showMasterPasswordDialog.value = true`, '                cancelAuthentication()');
    s = replace(s, '    ) {\n        try {\n            recordPasskeyEvent(', `    ) {
        if (resultFinished || signingStarted || isFinishing) return
        signingStarted = true
        verificationAttempt++
        biometricHelper.cancelAuthentication()
        try {
            require(PasskeyGetRequestPolicy.parse(requestJson).allows(passkey)) { "Credential not allowed" }
            val current = runBlocking { database.passkeyDao().getPasskeyByRecordId(passkey.id) }
            require(current == passkey) { "Passkey changed during authentication; select it again" }
            recordPasskeyEvent(`);
    s = replace(s, '            Log.d(TAG, "Authentication successful")', '            resultFinished = true\n            Log.d(TAG, "Authentication successful")');
    s = replace(s, '            Log.e(TAG, "Failed to authenticate with passkey", e)', '            resultFinished = true\n            Log.e(TAG, "Failed to authenticate with passkey", e)');
    return replace(s, 'title = passkey.displayTitle()', 'title = passkey.authenticationTitle()');
  });
}
console.log('Applied narrow request/ID/cancellation/title fixes to both Android variants');
