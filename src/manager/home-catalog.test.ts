import { describe, expect, it } from "vitest";
import { createLoginItem, type ProviderAccount, type VaultItem } from "../core/model";
import { buildHomeCatalog, homeSourceIds, itemHomeFolders, matchesHomeFolder, matchesHomeSource, suggestedHomeItems } from "./home-catalog";
import { homeItemSummary } from "./item-metadata";

const providers: ProviderAccount[] = [
  { id: "local-uuid", kind: "local", name: "Local", enabled: true, isDefaultSaveTarget: true, config: {} },
  { id: "a", kind: "monica-webdav", name: "Work", enabled: true, isDefaultSaveTarget: false, config: {} },
  { id: "b", kind: "monica-webdav", name: "Personal", enabled: true, isDefaultSaveTarget: false, config: {} }
];
const item = (id: string, sourceId?: string): VaultItem => ({ ...createLoginItem({ title: id, providerRefs: sourceId ? [{ providerId: sourceId }] : [] }), id, categoryId: 7, categoryName: "Accounts" });

describe("home catalog", () => {
  it("keeps identical folder names and IDs separate across databases", () => {
    const items = [item("a1", "a"), item("a2", "a"), item("b1", "b"), item("local")];
    const all = buildHomeCatalog(items, providers);
    expect(all.folders.map(folder => [folder.sourceId, folder.count])).toEqual([["a", 2], ["b", 1], ["local", 1]]);
    expect(new Set(all.folders.map(folder => folder.key)).size).toBe(3);
    for (const folder of all.folders) {
      const matches = items.filter(candidate => matchesHomeFolder(candidate, folder, providers));
      expect(matches).toHaveLength(folder.count);
      expect(matches.every(candidate => matchesHomeSource(candidate, folder.sourceId, providers))).toBe(true);
    }
    const scoped = buildHomeCatalog(items, providers, "a");
    expect(scoped.items.map(item => item.id)).toEqual(["a1", "a2"]);
    expect(scoped.folders).toHaveLength(1);
    expect(scoped.sourceCounts.get("b")).toBe(1);
  });

  it("normalizes real local IDs, deduplicates references, and counts each shared item once", () => {
    const local = item("local", "local-uuid");
    const shared = { ...item("shared"), providerRefs: [{ providerId: "a" }, { providerId: "a" }, { providerId: "b" }] };
    expect(homeSourceIds(local, providers)).toEqual(["local"]);
    expect(matchesHomeSource(local, "local", providers)).toBe(true);
    const catalog = buildHomeCatalog([local, shared], providers);
    expect(catalog.items).toHaveLength(2);
    expect(catalog.kinds.get("login")).toBe(2);
    expect(Object.fromEntries(catalog.sourceCounts)).toEqual({ local: 1, a: 1, b: 1 });
  });

  it("respects native folder identities, unnamed folders, and uncategorized records", () => {
    const keepass = { ...item("keepass", "a"), keepassGroupUuid: "same-id", keepassGroupPath: "Work/Accounts" };
    const mdbx = { ...item("mdbx", "a"), mdbxFolderId: "same-id" };
    const remote = { ...item("remote", "a"), providerRefs: [{ providerId: "a", remoteFolderId: "same-id" }] };
    const noName = { ...item("unnamed", "b"), categoryName: "" };
    const uncategorized = { ...item("none"), categoryId: undefined, categoryName: undefined };
    const catalog = buildHomeCatalog([keepass, mdbx, remote, noName, uncategorized], providers);
    expect(catalog.folders).toHaveLength(5);
    expect(itemHomeFolders(keepass, providers)[0]).toMatchObject({ type: "keepass", value: "same-id", label: "Work/Accounts" });
    expect(itemHomeFolders(noName, providers)[0]).toMatchObject({ type: "category", value: "id:7", label: "" });
    expect(itemHomeFolders(uncategorized, providers)[0]).toMatchObject({ type: "uncategorized", sourceId: "local" });
    expect(matchesHomeFolder(mdbx, itemHomeFolders(remote, providers)[0], providers)).toBe(false);
  });

  it("excludes archives and tombstones from every active count and recommendation", () => {
    const active = { ...item("active", "a"), favorite: true };
    const catalog = buildHomeCatalog([active, { ...item("archived", "a"), favorite: true, archivedAt: "2026-01-01" }, { ...item("deleted", "b"), deletedAt: "2026-01-01" }], providers);
    expect(catalog.items).toEqual([active]);
    expect(catalog.favorites).toEqual([active]);
    expect(catalog.sourceCounts.has("b")).toBe(false);
    expect(suggestedHomeItems(catalog.items)).toEqual([active]);
    expect(buildHomeCatalog([active], providers, "missing").items).toEqual([]);
  });

  it("selects a bounded stable recommendation set by favorite and update time", () => {
    const items = Array.from({ length: 2000 }, (_, index) => ({ ...item(`item-${index}`), favorite: index % 500 === 0, updatedAt: new Date(index * 1000).toISOString() }));
    expect(suggestedHomeItems(items).map(item => item.id)).toEqual(["item-1500", "item-1000", "item-500", "item-0", "item-1999", "item-1998"]);
    expect(suggestedHomeItems([...items].reverse())).toEqual(suggestedHomeItems(items));
    expect(buildHomeCatalog(items, providers).folders[0].count).toBe(2000);
  });

  it("never puts URI tokens, passwords, OTP secrets, or note content into card summaries", () => {
    const login = createLoginItem({ title: "Mail", username: "user", password: "password-sentinel", notes: "note-sentinel", uris: ["otpauth://totp/test?secret=secret-sentinel"] });
    expect(homeItemSummary(login)).toBe("user");
    const note: VaultItem = { ...item("note"), kind: "secure-note", content: "private-note-sentinel" };
    const otp: VaultItem = { ...item("otp"), kind: "totp", secret: "otp-secret-sentinel", digits: 6, period: 30, algorithm: "SHA1" };
    expect(homeItemSummary(note)).not.toContain(note.content);
    expect(homeItemSummary(otp)).not.toContain(otp.secret);
  });
});
