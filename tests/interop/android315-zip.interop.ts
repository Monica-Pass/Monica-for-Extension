import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { expect, it } from "vitest";
import { parseLosslessJson } from "../../src/core/lossless-json";
import { decryptAndroidBackup, encryptAndroidBackup } from "../../src/providers/webdav/android-backup-crypto";
import { listAndroidPortableAttachments, readAndroidBackup, readAndroidPortableAttachment, writeAndroidBackup } from "../../src/providers/webdav/android-backup-codec";

const root = process.env.MONICA_315_APP_FIXTURE ? resolve(process.env.MONICA_315_APP_FIXTURE) : undefined;
const available = Boolean(root && existsSync(join(root, "android.zip")));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const password = "synthetic archive password";

it.skipIf(!available)("actual Android app encrypted ZIP → extension codec/title edits → encrypted ZIP for targeted Android restore", async () => {
  if (!root) throw new Error("Explicit fixture directory required; no synthetic fallback");
  const originalBytes = await readFile(join(root, "android.zip"));
  const evidence: Record<string, unknown> = { layer: "actual Android app ZIP / extension codec; not Edge UI", inputSha256: hash(originalBytes), status: "failed" };
  try {
    const exported = JSON.parse(await readFile(join(root, "export-evidence.json"), "utf8"));
    expect(exported.status, "Android export provenance must pass before codec acceptance").toBe("passed");
    for (const key of ["androidSourcesUnchanged", "testSourcesUnchanged", "installedApplicationUnchanged", "installedTestApkUnchanged", "deviceBootUnchanged"]) expect(exported[key], key).toBe(true);
    expect(hash(originalBytes)).toBe(exported.outputs.find((file: { name: string }) => file.name === "android.zip").sha256);
    evidence.exportEvidenceSha256 = hash(await readFile(join(root, "export-evidence.json")));
    await expect(decryptAndroidBackup(originalBytes, "incorrect synthetic password")).rejects.toThrow();
    const plain = await decryptAndroidBackup(originalBytes, password);
    const document = readAndroidBackup(plain, "android315-zip", { allowPortableAttachments: true, allowPortablePasskeys: true });
    evidence.members = Object.keys(document.entries);
    evidence.decodedKinds = document.items.map(item => ({ kind: item.kind, title: item.title }));
    evidence.warnings = document.warnings;
    expect(document.items).toHaveLength(20);
    const independent = document.items.filter(item => item.kind === "login" && item.title.endsWith("-independent"));
    expect(independent).toHaveLength(2);
    expect(new Set(independent.map(item => item.id)).size).toBe(2);
    const group = document.items.filter(item => item.kind === "login" && item.title.endsWith("-group"));
    expect(group).toHaveLength(3);
    expect(new Set(group.map(item => item.kind === "login" && item.passwordGroupId)).size).toBe(1);
    const wallet = group.find(item => item.kind === "login" && item.customFields.some(field => field.name === "monica.content.wallet.bank_card"));
    expect(wallet).toBeDefined();
    if (!wallet || wallet.kind !== "login") throw new Error("Missing full wallet login");
    const content = (name: string) => wallet.customFields.find(field => field.name === name)?.value;
    expect(content("monica.content.order")).toContain("FUTURE");
    expect(content("monica.content.future.metadata")).toContain("9007199254740993");
    const card = JSON.parse(content("monica.content.wallet.bank_card")!) as { data: Record<string, unknown>; assets: unknown[] };
    expect(card.data).toMatchObject({ cardNumber: "0000424242424242", pin: "0007", iban: "GB00SYNTHETIC001", accountNumber: "000002", cardFace: { imageAttachmentName: "wallet-cardface-315" } });
    expect(card.assets).toHaveLength(1);
    const note = JSON.parse(content("monica.content.wallet.note")!) as { data: Record<string, unknown>; assets: unknown[] };
    expect(note.data).toMatchObject({ content: "# 完整笔记\n\n  preserve spaces  \n🔑", isMarkdown: true });
    expect(note.assets).toHaveLength(1);
    const counters = document.items.filter(item => item.kind === "totp" && item.otpType === "HOTP");
    expect(counters).toHaveLength(1);
    expect(counters[0].kind === "totp" && String(counters[0].counter)).toBe("9007199254740993");

    const attachments: Array<Record<string, unknown>> = [];
    evidence.attachmentManifest = parseLosslessJson(strFromU8(document.entries["attachments_portable/attachments_portable.json"]));
    evidence.recordIds = [...document.records.values()].map(record => ({ path: record.path, id: record.raw.id }));
    for (const item of document.items) for (const attachment of listAndroidPortableAttachments(document, item)) {
      const bytes = await readAndroidPortableAttachment(document, attachment);
      expect(bytes.byteLength).toBe(attachment.sizeBytes);
      expect(hash(bytes)).toBe(attachment.sha256Hex);
      attachments.push({ itemId: item.id, fileName: attachment.fileName, sizeBytes: bytes.byteLength, sha256: hash(bytes) });
    }
    evidence.attachments = attachments;
    expect(attachments.length).toBeGreaterThanOrEqual(3);
    const changed = document.items.map(item => item.kind === "opaque" ? item : { ...item, title: `${item.title} · Extension ZIP315` });
    const written = writeAndroidBackup(document, changed, "android315-zip", { allowPortableAttachments: true, allowPortablePasskeys: true });
    const after = unzipSync(written);
    expect(Object.keys(after).sort()).toEqual(Object.keys(document.entries).sort());
    const records = new Map([...document.records.values()].map(record => [record.path, record]));
    for (const [path, before] of Object.entries(document.entries)) {
      const record = records.get(path);
      if (!record || record.item.kind === "opaque") expect(hash(after[path]), `Non-edited ZIP member changed: ${path}`).toBe(hash(before));
      else {
        const beforeRaw = parseLosslessJson(strFromU8(before)) as Record<string, unknown>;
        const afterRaw = parseLosslessJson(strFromU8(after[path])) as Record<string, unknown>;
        expect(afterRaw.title).toBe(`${record.item.title} · Extension ZIP315`);
        afterRaw.title = beforeRaw.title;
        expect(canonical(afterRaw), `Title edit rewrote unedited fields: ${path}`).toBe(canonical(beforeRaw));
      }
    }
    const encrypted = await encryptAndroidBackup(written, password);
    expect(hash(await decryptAndroidBackup(encrypted, password))).toBe(hash(written));
    await writeFile(join(root, "extension.zip"), encrypted);
    evidence.status = "passed";
    evidence.recordCount = document.items.length;
    evidence.attachments = attachments;
    evidence.warnings = document.warnings;
    evidence.outputSha256 = hash(encrypted);
    evidence.checks = ["20 actual Android records decoded", "independent IDs and explicit three-member group", "large HOTP counter", "full card/note wallet and future content order", "all attachments authenticated", "all non-title fields and nonrecord ZIP members unchanged", "wrong-password rejected", "output encryption roundtrip"];
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    expect(hash(await readFile(join(root, "android.zip")))).toBe(hash(originalBytes));
    await writeFile(join(root, "zip-codec-evidence.json"), JSON.stringify(evidence, null, 2));
  }
});

function canonical(value: unknown): string {
  const isRaw = (JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON;
  return JSON.stringify(value, (_key, child) => child && typeof child === "object" && !Array.isArray(child) && !isRaw?.(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
}
