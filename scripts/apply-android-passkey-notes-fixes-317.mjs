import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const replace = (text, from, to) => {
  if (text.split(from).length !== 2) throw new Error(`Expected one match: ${from.slice(0, 100)}`);
  return text.replace(from, to);
};
const codec = `package takagi.ru.monica.bitwarden.mapper

/** New native FIDO2 ciphers carry notes verbatim. Only recognize our complete old footer. */
internal object PasskeyNotesCodec {
    private val fields = listOf("credentialId", "rpId", "rpName", "userId", "userDisplayName",
        "publicKeyAlgorithm", "signCount", "createdAt", "lastUsedAt")

    fun decode(notes: String?): String {
        val raw = notes ?: return ""
        for (newline in listOf("\\n", "\\r\\n")) {
            val header = newline + "🔐 This is a Passkey entry synced from Monica" + newline +
                "ℹ️ Private key availability depends on client capability." + newline + newline +
                "---" + newline + "[Monica Passkey Metadata]" + newline
            val start = raw.lastIndexOf(header)
            if (start < 0) continue
            val tail = raw.substring(start + header.length).removeSuffix(newline).split(newline)
            if (tail.size != fields.size || fields.indices.any { !tail[it].startsWith(fields[it] + ": ") }) continue
            if (tail[0].substringAfter(": ").isBlank() || tail[1].substringAfter(": ").isBlank()) continue
            if ((5..8).any { tail[it].substringAfter(": ").toLongOrNull() == null }) continue
            return raw.substring(0, start).removeSuffix(newline)
        }
        return raw
    }
}
`;
for (const [label, variant] of [['main', 'Monica for Android'], ['fdroid', 'fdroid']]) {
  const base = path.join(root, 'Monica-main', variant, 'app/src/main/java/takagi/ru/monica');
  const edit = async (file, update) => {
    const target = path.join(base, file), old = await readFile(target, 'utf8');
    const saved = path.join(root, 'monica-extension/.tmp/android-passkey-fixes-317/original', label, file);
    await mkdir(path.dirname(saved), { recursive: true });
    // Additional source baseline: never overwrite the pre-edit copy.
    try { await copyFile(target, saved, 1); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const next = update(old.replaceAll('\r\n', '\n'));
    await writeFile(target, old.includes('\r\n') ? next.replaceAll('\n', '\r\n') : next);
  };
  await writeFile(path.join(base, 'bitwarden/mapper/PasskeyNotesCodec.kt'), codec);
  await edit('bitwarden/mapper/PasskeyMapper.kt', s => {
    s = replace(s, '        val counter = item.signCount\n            .coerceIn(0L, Int.MAX_VALUE.toLong())\n            .toString()', `        require(item.signCount in 0L..0xffffffffL) { "Invalid WebAuthn signature counter" }
        val counter = item.signCount.toString()`);
    s = replace(s, 'notes = buildPasskeyNotes(item)', 'notes = item.notes');
    s = replace(s, 'notes = cipher.notes?.substringBefore("---")?.trim() ?: ""', 'notes = PasskeyNotesCodec.decode(cipher.notes)');
    const start = s.indexOf('    /**\n     * 构建 Passkey 笔记');
    const end = s.indexOf('    /**\n     * 从 URI', start);
    if (start < 0 || end < 0) throw new Error('Missing old notes builder');
    return s.slice(0, start) + s.slice(end);
  });
  await edit('bitwarden/service/CipherSyncProcessor.kt', s => {
    s = replace(s, '        val notes = extractPasskeyUserNotes(decryptString(cipher.notes, symmetricKey))', `        val decryptedNotes = decryptString(cipher.notes, symmetricKey)
        require(cipher.notes.isNullOrEmpty() || decryptedNotes != null) { "Unable to decrypt passkey notes" }
        val notes = extractPasskeyUserNotes(decryptedNotes)`);
    const start = s.indexOf('        val decryptedNotes ='), end = s.indexOf('    // ========== 辅助方法', start);
    s = s.slice(0, start) + s.slice(start, end).replaceAll('notes = notes.ifBlank { existing.notes }', 'notes = notes') + s.slice(end);
    return replace(s, `        if (notes.isNullOrBlank()) return ""
        return notes.substringBefore("---").trim()`, '        return takagi.ru.monica.bitwarden.mapper.PasskeyNotesCodec.decode(notes)');
  });
}
console.log('Applied exact native notes and legacy full-footer compatibility to both variants');
