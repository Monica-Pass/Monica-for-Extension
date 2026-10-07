import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { applyBoundNoteChoice, boundNoteLogicalId, resolveBoundNote } from "../../src/core/bound-notes";
import type { LoginItem, SecureNoteItem } from "../../src/core/model";
import { decryptAndroidBackup, encryptAndroidBackup } from "../../src/providers/webdav/android-backup-crypto";
import { readAndroidBackup, writeAndroidBackup } from "../../src/providers/webdav/android-backup-codec";

// Opt-in: require an actual application export; never synthesize missing Android evidence.
const directory = process.env.MONICA_315_APP_FIXTURE;
if (!directory) throw new Error("MONICA_315_APP_FIXTURE must name the Android ZIP-note run directory");
const root = resolve(directory);
const stage = process.env.MONICA_ZIP_NOTE_STAGE || "forward";
if (!["forward", "return"].includes(stage)) throw new Error("Choose forward or return for MONICA_ZIP_NOTE_STAGE");
const password = "synthetic archive password";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const noteSnapshot = (note?: SecureNoteItem) => note ? {
  title: note.title, content: note.content, tags: note.tags, isMarkdown: note.isMarkdown,
  notes: note.notes, customFields: note.customFields
} : null;

it(`actual Android ZIP bound-note ${stage}`, async () => {
  const inputName = stage === "forward" ? "android-note.zip" : "android-note-return.zip";
  const bytes = await readFile(join(root, inputName));
  const report: Record<string, unknown> = { status: "failed", stage, inputSha256: hash(bytes), layer: "extension ZIP codec / actual Android application archives, not browser UI" };
  try {
    const device = JSON.parse(await readFile(join(root, `zip-note-${stage === "forward" ? "export" : "import"}-evidence.json`), "utf8"));
    expect(device.status).toBe("passed");
    expect(device.installedApplicationUnchanged).toBe(true);
    expect(device.androidSourcesUnchanged).toBe(true);
    expect(device.outputs.find((entry: { name: string }) => entry.name === inputName)?.sha256).toBe(hash(bytes));
    report.androidVersion = device.androidVersion;
    report.installedApkSha256 = device.installedApkSha256;
    const providerId = `zip-note-${stage}`;
    const document = readAndroidBackup(await decryptAndroidBackup(bytes, password), providerId);
    const owners = document.items.filter((item): item is LoginItem => item.kind === "login");
    const notes = document.items.filter((item): item is SecureNoteItem => item.kind === "secure-note");
    if (stage === "forward") {
      expect(owners).toHaveLength(3);
      expect(notes).toHaveLength(2);
      expect(notes[0].title).toBe(notes[1].title);
      expect(new Set(notes.map(note => document.records.get(note.id)?.raw.id)).size).toBe(2);
      const first = notes.find(note => note.content.startsWith("# First note"))!;
      const second = notes.find(note => note.content.startsWith("# Second note"))!;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first.content).toBe("# First note\n\n  中文 🔑  \n");
      expect(second.content).toBe("# Second note\n\nSame title, different ID\n");
      expect(first.tags).toEqual(["interop", "关联"]);
      expect(first.isMarkdown).toBe(true);
      for (const owner of owners) expect(resolveBoundNote(owner, document.items)?.id).toBe(first.id);
      const seed = JSON.parse(await readFile(join(root, "android-note-seed.json"), "utf8"));
      const freshNote: SecureNoteItem = { ...first, id: "zip-new-note", replicaGroupId: undefined,
        providerRefs: [{ providerId }], title: `${seed.prefix}-new-note`,
        content: "# Created in extension\n\n  保留空格 🔑  \n", tags: ["新建", "interop"] };
      const freshOwner: LoginItem = { ...owners[0], id: "zip-new-owner", replicaGroupId: undefined,
        providerRefs: [{ providerId }], title: `${seed.prefix}-new`, username: "new-user",
        password: "synthetic-new-0007", boundNoteId: undefined, boundNoteEntryId: undefined };
      let items = [...document.items, freshNote, freshOwner];
      items = items.map(item => {
        if (item.kind !== "login") return item;
        if (item.title.endsWith("-keep")) return { ...item, title: `${seed.prefix}-renamed-keep` };
        if (item.title.endsWith("-replace")) return applyBoundNoteChoice(item, boundNoteLogicalId(second), items);
        if (item.title.endsWith("-unlink")) return applyBoundNoteChoice(item, "", items);
        return applyBoundNoteChoice(item, boundNoteLogicalId(freshNote), items);
      });
      const plain = writeAndroidBackup(document, items, providerId);
      const check = readAndroidBackup(plain, "zip-note-reconnect");
      expect(check.items).toHaveLength(7);
      const expected = check.items.filter((item): item is LoginItem => item.kind === "login").map(item => {
        const note = resolveBoundNote(item, check.items);
        if (item.title.endsWith("-unlink")) expect(item.boundNoteId).toBeUndefined();
        else {
          expect(note).toBeDefined();
          expect(check.records.get(note!.id)?.raw.id).toBe(item.boundNoteId);
        }
        return { title: item.title, username: item.username, password: item.password, notes: item.notes, note: noteSnapshot(note) };
      });
      const output = await encryptAndroidBackup(plain, password);
      await writeFile(join(root, "extension-note.zip"), output);
      await writeFile(join(root, "zip-note-expected.json"), JSON.stringify(expected, null, 2));
      report.outputSha256 = hash(output);
      report.checks = ["actual Android numeric links", "same-title distinct note IDs", "unrelated rename", "replacement", "unlink", "new note and login", "reconnect resolves exported IDs"];
    } else {
      const restore = JSON.parse(await readFile(join(root, "android-note-restore.json"), "utf8"));
      const forward = JSON.parse(await readFile(join(root, "zip-note-forward-codec-evidence.json"), "utf8"));
      expect(restore.status).toBe("passed");
      expect(forward.status).toBe("passed");
      expect(device.installedApkSha256).toBe(forward.installedApkSha256);
      expect(owners).toHaveLength(4);
      expect(notes).toHaveLength(3);
      const expected = JSON.parse(await readFile(join(root, "zip-note-expected.json"), "utf8"));
      for (const entry of expected) {
        const owner = owners.find(item => item.title === entry.title)!;
        expect(owner).toBeDefined();
        expect({ username: owner.username, password: owner.password, notes: owner.notes })
          .toEqual({ username: entry.username, password: entry.password, notes: entry.notes });
        expect(noteSnapshot(resolveBoundNote(owner, document.items))).toEqual(entry.note);
      }
      const reconnect = readAndroidBackup(writeAndroidBackup(document, document.items, providerId), "third-connection");
      for (const owner of owners) {
        const after = reconnect.items.find(item => item.kind === "login" && item.title === owner.title) as LoginItem;
        expect(noteSnapshot(resolveBoundNote(after, reconnect.items))).toEqual(noteSnapshot(resolveBoundNote(owner, document.items)));
      }
      report.checks = ["actual Android restore and fresh Room IDs", "full linked-note content", "keep/replace/unlink/new survived Android ZIP export", "password values retained", "second extension reconnect"];
    }
    report.status = "passed";
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    expect(hash(await readFile(join(root, inputName)))).toBe(hash(bytes));
    await writeFile(join(root, `zip-note-${stage}-codec-evidence.json`), JSON.stringify(report, null, 2));
  }
});
