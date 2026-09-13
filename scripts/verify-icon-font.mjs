import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const inventory = JSON.parse(await readFile(path.join(root, 'scripts/icon-font-inventory.json'), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
for (const [file, expected] of [['node_modules/material-symbols/material-symbols-outlined.woff2', inventory.sourceSha256], ['public/fonts/monica-symbols.woff2', inventory.fontSha256]]) {
  if (hash(await readFile(path.join(root, file))) !== expected) throw new Error('Icon font changed; regenerate its subset and inventory: ' + file);
}
const available = new Set(inventory.availableSymbols);
const included = new Set(inventory.symbols);
const missing = new Set();
for (const file of await readdir(path.join(root, 'src'), { recursive: true })) {
  if (!/\.(ts|vue)$/.test(file) || file.endsWith('.test.ts')) continue;
  const source = await readFile(path.join(root, 'src', file), 'utf8');
  for (const [, name] of source.matchAll(/["']([a-z][a-z0-9_]*)["']/g)) if (available.has(name) && !included.has(name)) missing.add(name);
}
if (missing.size) throw new Error('New icons need font regeneration: ' + [...missing].join(', '));
console.log(`Verified ${included.size} bundled icons and source/font checksums.`);
