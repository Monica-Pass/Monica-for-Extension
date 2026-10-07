import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DOMParser } from '@xmldom/xmldom';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const out = join(root, '.tmp/android-cm-backends-317');
const expected = JSON.parse(await readFile(join(out, 'expected.json')));
const ready = JSON.parse(await readFile(join(out, 'ready.json')));
const auth = JSON.parse(await readFile(join(out, 'system-acceptance.json')));
assert.equal(auth.proofs.length, 3);
assert.ok(auth.proofs.every(proof => proof.rpAcceptance === 'pass'));
const db = new DatabaseSync(join(out, 'after-backends/password_database'), { readOnly: true });
const metadata = ready.records.map(record => {
  const original = expected.find(item => item.credentialId === record.credentialId);
  const row = db.prepare('SELECT is_backed_up FROM passkeys WHERE id = ?').get(record.recordId);
  return { tag: record.tag, expectedBackupState: original.backupState, importedBackupState: record.isBackedUp,
    afterAuthenticationBackupState: Boolean(row.is_backed_up), preserved: original.backupState === record.isBackedUp };
});
const bw = ready.records.find(row => row.tag === 'bitwarden');
const bwRow = db.prepare('SELECT notes, user_display_name, user_name FROM passkeys WHERE id = ?').get(bw.recordId);
db.close();
assert.ok(bwRow.notes.length > 0);
const ui = [];
for (const file of ['bitwarden-picker-ready.xml', 'bitwarden-authentication-ready.xml']) {
  const xml = await readFile(join(out, file), 'utf8');
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const texts = Array.from(doc.getElementsByTagName('node')).map(node => node.getAttribute('text'));
  ui.push({ file, fullStoredNotesShownBeforePassword: texts.includes(bwRow.notes),
    userDisplayNameShown: texts.includes(bwRow.user_display_name), userNameShown: texts.includes(bwRow.user_name) });
}
const result = { scope: 'Separate metadata and actual pre-authentication UI checks; successful signatures do not establish full parity',
  credentialAuthentication: '3/3 pass', interoperabilityComplete: false, metadata, ui };
await writeFile(join(out, 'metadata-ui-review.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (metadata.some(row => !row.preserved) || ui.some(row => row.fullStoredNotesShownBeforePassword)) process.exitCode = 1;
