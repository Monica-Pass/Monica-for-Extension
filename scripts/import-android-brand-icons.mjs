import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const source = new URL('../../Monica-main/Monica for Android/app/src/main/assets/stratum_icons/', import.meta.url);
const output = new URL('../public/brand-icons/', import.meta.url);
await mkdir(output, { recursive: true });
const catalog = {}, files = [];
for (const directory of ['icons', 'extraicons']) for (const name of (await readdir(new URL(directory+'/',source))).sort()) {
  if (!/^[a-z0-9_.-]+\.png$/i.test(name)) continue;
  const slug = name.replace(/(_dark)?\.png$/, '').toLowerCase(), dark = name.endsWith('_dark.png');
  const bytes = await readFile(new URL(`${directory}/${name}`,source));
  const file = `${directory}-${name}`;
  await writeFile(new URL(file,output),bytes);
  catalog[slug] ||= { slug, label: slug.replace(/[_-]/g,' ') };
  catalog[slug][dark ? 'dark' : 'light'] ||= file;
  files.push({source:`${directory}/${name}`,file,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await writeFile(new URL('../src/core/brand-icon-catalog.json',import.meta.url),JSON.stringify(Object.values(catalog).sort((a,b)=>a.slug.localeCompare(b.slug)),null,2)+'\n');
await writeFile(new URL('../docs/brand-icons-provenance.json',import.meta.url),JSON.stringify({source:'Android bundled Stratum Auth app v1.4.0 icons/extraicons',upstream:'https://github.com/stratumauth/app/tree/v1.4.0',license:'GPL-3.0',files},null,2)+'\n');
console.log(JSON.stringify({icons:Object.keys(catalog).length,files:files.length}));
