import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const english = JSON.parse(await readFile(resolve(root, 'src/i18n/ui-en.json'), 'utf8'));
for (const locale of ['ja', 'ko', 'de', 'es', 'ru', 'vi']) {
  const path = resolve(root, `public/locales/ui-${locale}.json`);
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  const missing = Object.keys(english).filter(key => !(key in catalog));
  for (const key of missing) catalog[key] = english[key];
  // Existing translations are never rewritten by this key-only synchronization.
  if (missing.length) await writeFile(path, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`${locale}: ${missing.length} new keys use the English fallback`);
}
