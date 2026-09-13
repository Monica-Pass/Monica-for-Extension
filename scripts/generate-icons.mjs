import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Keep the original brand artwork as the master. UI typography must not redraw it.
const logo = (await readFile(resolve(root, "public/icons/logo-256.png"))).toString("base64");
const outputIndex = process.argv.indexOf("--output-dir");
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error("--output-dir requires a directory.");
const output = outputIndex === -1 ? resolve(root, "public/icons") : resolve(process.argv[outputIndex + 1]);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chromium", headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 32, 48, 128]) {
    const png = await page.evaluate(async ({ logo, size }) => {
      const original = new Image();
      original.src = `data:image/png;base64,${logo}`;
      await original.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Unable to create the icon canvas.");
      context.imageSmoothingQuality = "high";
      const scale = Math.min(size / original.naturalWidth, size / original.naturalHeight);
      const width = original.naturalWidth * scale;
      const height = original.naturalHeight * scale;
      context.drawImage(original, (size - width) / 2, (size - height) / 2, width, height);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { logo, size });
    await writeFile(resolve(output, `icon-${size}.png`), Buffer.from(png, "base64"));
  }
} finally { await browser.close(); }
console.log(`Generated four Monica toolbar icons from the original logo in ${output}.`);
