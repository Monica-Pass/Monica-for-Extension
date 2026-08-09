import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const pageNames = ["index.html", "popup.html"];

for (const pageName of pageNames) await verifyPage(pageName);
console.log(`Verified ${pageNames.length} extension pages: no module preloads and every local asset reference exists.`);

async function verifyPage(pageName) {
  const html = await readFile(resolve(dist, pageName), "utf8");
  const linkTags = html.match(/<link\b[^>]*>/gi) || [];
  assert(!linkTags.some((tag) => /\brel\s*=\s*["']modulepreload["']/i.test(tag)), `${pageName} contains a modulepreload link that Chromium extension pages cannot reliably reuse across worlds.`);

  const references = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  for (const reference of references) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(reference)) continue;
    const cleanReference = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
    assert(cleanReference && !cleanReference.includes("\0"), `${pageName} contains an invalid local asset reference: ${reference}`);
    const target = resolve(dist, dirname(pageName), cleanReference);
    const relativeTarget = relative(dist, target);
    assert(relativeTarget && !relativeTarget.startsWith(`..${sep}`) && relativeTarget !== ".." && !isAbsolute(relativeTarget), `${pageName} contains an asset reference outside dist: ${reference}`);
    const targetStat = await stat(target).catch(() => null);
    assert(targetStat?.isFile(), `${pageName} references a missing local asset: ${reference}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
