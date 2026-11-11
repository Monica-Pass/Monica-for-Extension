import { access, readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const docsDir = fileURLToPath(new URL("../docs/", import.meta.url));
const indexPath = resolve(docsDir, "README.md");

async function listIndexedDocuments(): Promise<Set<string>> {
  // Local ignored design notes are not published documentation. Keep enforcing
  // coverage for tracked legacy notes and new, non-ignored documents alike.
  const ignored = new Set(execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "docs/"],
    { cwd: resolve(docsDir, ".."), encoding: "utf8", windowsHide: true }).split("\0").filter(Boolean));
  const entries = await readdir(docsDir, { recursive: true, withFileTypes: true });
  const files = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const rel = relative(docsDir, resolve(entry.parentPath, entry.name)).replace(/\\/g, "/");
    if (ignored.has(`docs/${rel}`)) continue;
    if (rel !== "README.md") files.add(rel);
  }
  return files;
}

function indexLinks(body: string): Set<string> {
  const links = new Set<string>();
  for (const match of body.matchAll(/\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
    if (!/^(https?:|mailto:)/.test(match[1])) links.add(match[1]);
  }
  return links;
}

describe("docs index coverage", () => {
  it("registers every markdown document under docs/ exactly once-reachable", async () => {
    const body = await readFile(indexPath, "utf8");
    const markdownLinks = new Set([...indexLinks(body)].filter((link) => link.endsWith(".md")));
    const actual = await listIndexedDocuments();
    const missing = [...actual].filter((file) => !markdownLinks.has(file)).sort();
    const phantom = [...markdownLinks].filter((link) => !actual.has(link)).sort();
    expect(missing, "documents present under docs/ but missing from docs/README.md").toEqual([]);
    expect(phantom, "docs/README.md links pointing at documents that do not exist").toEqual([]);
  });

  it("declares the document total and each group count accurately", async () => {
    const body = await readFile(indexPath, "utf8");
    const headers = [...body.matchAll(/^## (.+?)（(\d+)）$/gm)];
    expect(headers.length, "themed group headers with counts").toBeGreaterThan(0);
    const declaredTotal = Number(body.match(/全部 (\d+) 篇文档/)?.[1] ?? Number.NaN);
    const summed = headers.reduce((total, header) => total + Number(header[2]), 0);
    expect(declaredTotal, "the headline total must match the sum of group counts").toBe(summed);
    for (const header of headers) {
      const start = (header.index ?? 0) + header[0].length;
      const nextHeader = body.slice(start).search(/^## /m);
      const section = body.slice(start, nextHeader === -1 ? undefined : start + nextHeader);
      const entries = [...section.matchAll(/^- \[/gm)].length;
      expect(entries, `entry count declared by group "${header[1]}"`).toBe(Number(header[2]));
    }
  });

  it("resolves every relative link target in the index", async () => {
    const body = await readFile(indexPath, "utf8");
    for (const link of indexLinks(body)) {
      await expect(access(resolve(docsDir, link)), `index link ${link}`).resolves.toBeUndefined();
    }
  });
});
