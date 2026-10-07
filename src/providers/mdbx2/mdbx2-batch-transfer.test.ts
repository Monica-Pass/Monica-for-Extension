import { describe, expect, it } from "vitest";
import type { LoginItem, PasskeyItem, TotpItem, VaultItem } from "../../core/model";
import {
  normalizeMdbx2TransferItem,
  planMdbx2BatchTransfer,
  resolveMdbx2CollectionPath,
  sourceCategoryPath
} from "./mdbx2-batch-transfer";

const baseLogin = (): LoginItem => ({
  id: "source-login",
  kind: "login",
  title: "Example",
  favorite: true,
  notes: "keep this",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  categoryId: 7,
  categoryName: "Work",
  sortOrder: 9,
  archivedAt: "2026-01-03T00:00:00.000Z",
  keepassDatabaseId: 4,
  keepassGroupPath: "Work/Cloud%2FAccounts",
  keepassEntryUuid: "entry",
  keepassGroupUuid: "group",
  replicaGroupId: "password:source",
  providerRefs: [{ providerId: "keepass", remoteId: "entry" }],
  username: "alice",
  password: "secret",
  uris: ["https://example.com"],
  uriRules: [{ uri: "https://example.com", matchType: "exact" }],
  customFields: [],
  boundTotpItemId: "totp-1",
  loginType: "PASSWORD"
});

describe("MDBX2 batch transfer planner", () => {
  it.each(['copy', 'move'] as const)('refuses %s with history when only a pending target reference exists', action => {
    const source = { ...baseLogin(), boundTotpItemId: undefined, providerRefs: [{ providerId: 'target' }],
      passwordHistory: [{ password: 'synthetic old', lastUsedAt: '1970-01-01T00:00:00.000Z' }] };
    const plan = planMdbx2BatchTransfer([source], { action, targetProviderId: 'target', preserveCategories: false });
    expect(plan.blockedCount).toBe(1);
    expect(plan.items[0].targetItem).toBeUndefined();
    expect(plan.items[0].blockedReason).toContain('密码历史');
  });

  it('allows a history-free copy but blocks duplicating a native object with local history', () => {
    const source = { ...baseLogin(), boundTotpItemId: undefined, providerRefs: [{ providerId: 'target', remoteId: 'object' }], passwordHistory: [] };
    expect(planMdbx2BatchTransfer([source], { action: 'copy', targetProviderId: 'target', preserveCategories: false }).blockedCount).toBe(0);
    const withHistory = { ...source, passwordHistory: [{ password: 'synthetic old', lastUsedAt: '1970-01-01T00:00:00.000Z' }] };
    expect(planMdbx2BatchTransfer([withHistory], { action: 'copy', targetProviderId: 'target', preserveCategories: false }).blockedCount).toBe(1);
    expect(planMdbx2BatchTransfer([withHistory], { action: 'move', targetProviderId: 'target', preserveCategories: false }).blockedCount).toBe(0);
  });

  it("retains unresolved legacy and cyclic SSO links instead of silently unlinking copies", () => {
    const source={...baseLogin(),boundTotpItemId:undefined,ssoRefEntryId:42};
    expect(planMdbx2BatchTransfer([source],{action:'copy',preserveCategories:false}).blockedCount).toBe(1);
    const cyclic={...source,ssoRefEntryId:undefined,ssoRefLogicalId:source.replicaGroupId};
    expect(planMdbx2BatchTransfer([cyclic],{action:'copy',preserveCategories:false}).blockedCount).toBe(1);
    expect(source.ssoRefEntryId).toBe(42);
  });
  it("does not silently discard a stable note link without a legacy Room ID", () => {
    const source = { ...baseLogin(), boundTotpItemId: undefined, boundNoteEntryId: "note:stable" };
    for (const action of ["copy", "move"] as const) {
      const plan = planMdbx2BatchTransfer([source], { action, targetCollectionId: "target", preserveCategories: false });
      expect(plan.blockedCount).toBe(1);
      expect(plan.items[0].targetItem).toBeUndefined();
      expect(source.boundNoteEntryId).toBe("note:stable");
    }
  });
  it("resets Android copy bindings and creates a fresh identity", () => {
    const source = baseLogin();
    const copied = normalizeMdbx2TransferItem(source, {
      action: "copy",
      targetCollectionId: "target",
      now: "2026-08-06T00:00:00.000Z",
      targetItemId: "copied-login"
    });

    expect(copied).toMatchObject({
      id: "copied-login",
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
      mdbxFolderId: "target",
      favorite: true,
      notes: "keep this"
    });
    expect(copied.providerRefs).toEqual([]);
    expect(copied.replicaGroupId).toBeUndefined();
    expect(copied.keepassDatabaseId).toBeUndefined();
    expect(copied.categoryId).toBeUndefined();
    expect(copied.archivedAt).toBe(source.archivedAt);
    expect(copied.sortOrder).toBe(0);
    expect((copied as LoginItem).boundTotpItemId).toBeUndefined();
  });

  it("keeps move identity and replica group while detaching source bindings", () => {
    const source = { ...baseLogin(), boundTotpItemId: undefined };
    const moved = normalizeMdbx2TransferItem(source, {
      action: "move",
      targetCollectionId: "target",
      now: "2026-08-06T00:00:00.000Z"
    });
    expect(moved.id).toBe(source.id);
    expect(moved.replicaGroupId).toBe(source.replicaGroupId);
    expect(moved.createdAt).toBe(source.createdAt);
    expect(moved.updatedAt).toBe("2026-08-06T00:00:00.000Z");
    expect(moved.providerRefs).toEqual([]);
  });

  it("decodes KeePass path segments without treating an escaped slash as a separator", () => {
    const result = sourceCategoryPath(baseLogin());
    expect(result).toEqual({ segments: ["Work", "Cloud/Accounts"], complete: true });
  });

  it("resolves MDBX paths from root to leaf and stops safely on cycles", () => {
    const collections = [
      { collectionId: "work", title: "Work", groupId: undefined, deleted: false },
      { collectionId: "cloud", title: "Cloud", groupId: "work", deleted: false },
      { collectionId: "mail", title: "Mail", groupId: "cloud", deleted: false }
    ] as any;
    expect(resolveMdbx2CollectionPath("mail", collections)).toEqual({ segments: ["Work", "Cloud", "Mail"], complete: true });
    expect(resolveMdbx2CollectionPath("one", [
      { collectionId: "one", title: "One", groupId: "two", deleted: false },
      { collectionId: "two", title: "Two", groupId: "one", deleted: false }
    ] as any)).toEqual({ segments: ["Two", "One"], complete: false });
    expect(resolveMdbx2CollectionPath("root-id", [
      { collectionId: "root-id", title: ".monica-root", groupId: undefined, deleted: false }
    ] as any)).toEqual({ segments: [], complete: true });
  });

  it("uses category names for local records and can suppress preservation", () => {
    const categorized = { ...baseLogin(), keepassGroupPath: undefined, categoryName: "Personal / Mail", boundTotpItemId: undefined };
    expect(sourceCategoryPath(categorized)).toEqual({ segments: ["Personal", "Mail"], complete: true });
    const source = { ...categorized, categoryName: undefined };
    expect(sourceCategoryPath(source, { categoryNames: { "7": "Personal" } })).toEqual({ segments: ["Personal"], complete: true });
    const plan = planMdbx2BatchTransfer([source], {
      action: "copy",
      preserveCategories: false,
      targetCollectionId: "root",
      idFactory: () => "copy-1"
    });
    expect(plan.items[0].targetPath).toEqual([]);
    expect(plan.items[0].targetItem?.id).toBe("copy-1");
  });

  it("blocks detached transfer of a bound record instead of silently breaking the link", () => {
    const totp: TotpItem = {
      id: "totp-1",
      kind: "totp",
      title: "Code",
      favorite: false,
      notes: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      providerRefs: [],
      secret: "secret",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      boundPasswordId: 9
    };
    const plan = planMdbx2BatchTransfer([totp], { action: "copy", preserveCategories: true });
    expect(plan.blockedCount).toBe(1);
    expect(plan.items[0].targetItem).toBeUndefined();
    expect(plan.warnings.join(" ")).toContain("绑定登录项");
  });

  it("keeps a selected login and TOTP binding through target logical IDs", () => {
    const login = baseLogin();
    const totp: TotpItem = {
      id: "totp-1",
      kind: "totp",
      title: "Code",
      favorite: false,
      notes: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      providerRefs: [],
      secret: "secret",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      boundPasswordId: 9
    };
    const ids = new Map([[login.id, "copy-login"], [totp.id, "copy-totp"]]);
    const plan = planMdbx2BatchTransfer([login, totp], {
      action: "copy",
      preserveCategories: true,
      idFactory: (item) => ids.get(item.id)!
    });

    expect(plan.blockedCount).toBe(0);
    expect((plan.items[0].targetItem as LoginItem).boundTotpItemId).toBe("copy-totp");
    expect((plan.items[1].targetItem as TotpItem).boundPasswordId).toBeUndefined();
    expect(plan.items[1].payloadPatch).toMatchObject({
      room_id: null,
      bitwarden_mode: false,
      keepass_mode: false,
      bound_password_entry_id: "password:copy-login"
    });
  });

  it("treats a usable Passkey copy as a move and blocks metadata-only credentials", () => {
    const usable: PasskeyItem = {
      id: "passkey-1",
      kind: "passkey",
      title: "Example passkey",
      favorite: false,
      notes: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      providerRefs: [],
      credentialId: "credential",
      rpId: "example.com",
      rpName: "Example",
      userHandle: "user",
      userName: "alice",
      userDisplayName: "Alice",
      algorithm: -7,
      publicKey: "public",
      privateKeyPkcs8: "private",
      signCount: 0,
      discoverable: true,
      sourceMode: "browser-local"
    };
    const plan = planMdbx2BatchTransfer([usable], { action: "copy", preserveCategories: false });
    expect(plan.items[0]).toMatchObject({ effectiveAction: "move", targetItem: { id: usable.id } });
    expect(plan.warnings.join(" ")).toContain("按移动处理");

    const blocked = planMdbx2BatchTransfer([{ ...usable, sourceMode: "android-metadata-only", privateKeyPkcs8: undefined }], {
      action: "move",
      preserveCategories: false
    });
    expect(blocked.items[0].blockedReason).toContain("只有元数据");
  });

  it("rejects empty and duplicate selections", () => {
    expect(() => planMdbx2BatchTransfer([], { action: "copy", preserveCategories: false })).toThrow("至少一个");
    const item = { ...baseLogin(), boundTotpItemId: undefined };
    expect(() => planMdbx2BatchTransfer([item, item], { action: "copy", preserveCategories: false })).toThrow("重复 ID");
  });
});

it('rebases copied Android credential metadata to the new project and preserves it verbatim on move', () => {
  const group = '00000000-0000-0000-0000-000000000001';
  const members = [0, 1].map(index => ({ ...baseLogin(), id: `source-${index}`, boundTotpItemId: undefined, passwordGroupId: group,
    customFields: [{ name: 'monica.content.credential', protected: true, value: JSON.stringify({version:1, projectId:group,
      groupId:'00000000-0000-0000-0000-000000000002',passwordId:`00000000-0000-0000-0000-00000000001${index}`,
      label:'Account',primary:true,groupOrder:0,passwordOrder:index}).replace(/}$/, ',"future":9007199254740993}') }] }));
  const original = JSON.stringify(members);
  const copied = planMdbx2BatchTransfer(members, { action: 'copy', preserveCategories: false,
    idFactory: (_item, index) => `00000000-0000-0000-0000-00000000002${index}` });
  expect(copied.blockedCount).toBe(0);
  for (const [index, planned] of copied.items.entries()) {
    const target = planned.targetItem as LoginItem;
    const metadata = JSON.parse(target.customFields[0].value);
    expect(metadata.projectId).toBe(target.passwordGroupId);
    expect(metadata.projectId).not.toBe(group);
    expect(metadata.passwordId).toBe(JSON.parse(members[index].customFields[0].value).passwordId);
    expect(target.customFields[0].value).toContain('9007199254740993');
    expect(target.customFields[0].protected).toBe(true);
  }
  expect(new Set(copied.items.map(item => (item.targetItem as LoginItem).passwordGroupId)).size).toBe(1);
  const moved = planMdbx2BatchTransfer(members, { action: 'move', preserveCategories: false });
  expect(moved.blockedCount).toBe(0);
  for (const [index, planned] of moved.items.entries()) expect((planned.targetItem as LoginItem).customFields).toEqual(members[index].customFields);
  expect(JSON.stringify(members)).toBe(original);
});
