import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// These Android return runners accept a standalone database, never a ZIP renamed
// to .mdbx. Complete archives have a separate real Edge/Android acceptance flow.
export async function saveStandaloneMdbxDownload(download, destination) {
  assert.equal(await download.failure(), null);
  assert.match(download.suggestedFilename(), /\.mdbx$/i, 'This return fixture requires an embedded-only MDBX download');
  const temporary = await download.path();
  assert.ok(temporary);
  const bytes = await readFile(temporary);
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0', 'Do not disguise a complete ZIP as a standalone MDBX');
  await download.saveAs(destination);
  return bytes;
}
