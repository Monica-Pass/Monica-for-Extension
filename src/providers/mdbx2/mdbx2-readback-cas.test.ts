import { describe, expect, it } from "vitest";
import { createLoginItem, type LoginItem, type ProviderAccount } from "../../core/model";
import { SecureVaultService } from "../../security/secure-vault-service";
import { MemoryVaultStorage } from "../../security/vault-storage";
import { MemoryVaultSessionStore } from "../../security/vault-session";
import { Mdbx2Provider, type Mdbx2RuntimeClient } from "./mdbx2-provider";
import { encodeMdbx2Object } from "./mdbx2-item-codec";
import type { Mdbx2ObjectMutationInput, Mdbx2ObjectRecord, Mdbx2ObjectUpsertInput } from "./native-contract";

const collectionId = "22222222-2222-4222-8222-222222222222";
const account: ProviderAccount = { id: "synthetic-native", kind: "mdbx2", name: "Synthetic native", enabled: true, isDefaultSaveTarget: false, config: { vaultHandle: "11111111-1111-4111-8111-111111111111" } };
const nativeTime = "2026-08-02T00:00:00.000Z";

class ReadbackRuntime implements Mdbx2RuntimeClient {
  records = new Map<string, Mdbx2ObjectRecord>();
  writes = 0;
  async vaultStatus() { return { vaultHandle: account.config.vaultHandle as string, open: true, available: true }; }
  async listCollections(_handle: string, input: { deleted?: boolean } = {}) {
    return { items: input.deleted ? [] : [{ collectionId, title: ".monica-root", favorite: false, archived: false, attachmentCount: 0, headCommitId: "root", deleted: false, updatedAt: nativeTime }] };
  }
  async listObjects(_handle: string, _collection: string, input: { deleted?: boolean } = {}) {
    return { items: input.deleted ? [] : [...this.records.values()].map(record => ({ ...record, headCommitId: record.headCommitId!, updatedAt: nativeTime })) };
  }
  async revealObject(_handle: string, id: string) { return structuredClone(this.records.get(id)!); }
  async upsertObject(_handle: string, _operationId: string, input: Mdbx2ObjectUpsertInput) {
    const existing = [...this.records.values()].find(record => input.logicalObjectId === `native:${record.objectId}` || JSON.parse(record.payloadJson).monica_entry_id === input.logicalObjectId);
    const objectId = existing?.objectId || crypto.randomUUID();
    const commitId = `synthetic-commit-${++this.writes}`;
    this.records.set(objectId, { objectId, collectionId: input.collectionId || collectionId, objectTypeId: input.objectTypeId, title: input.title, payloadJson: input.payloadJson, payloadSchemaVersion: 1, deleted: false, headCommitId: commitId });
    return { objectId, collectionId: input.collectionId || collectionId, objectTypeId: input.objectTypeId, logicalObjectId: input.logicalObjectId, commitId, alreadyCommitted: false };
  }
  async mutateObjects(handle: string, scope: string, mutations: Mdbx2ObjectMutationInput[]) {
    const items = [];
    for (const mutation of mutations) {
      if (mutation.kind !== "upsert") throw new Error("Synthetic test only writes objects");
      items.push({ ...await this.upsertObject(handle, scope, mutation), kind: "upsert" as const, changed: true });
    }
    const commitId = `synthetic-commit-${this.writes}`;
    for (const item of items) this.records.get(item.objectId)!.headCommitId = commitId;
    return { changed: true, operationId: scope, commitId, alreadyCommitted: false, items };
  }
  async deleteObject(): Promise<never> { throw new Error("Synthetic test does not delete"); }
  async resolveObjectOperation() { return { known: false as const, committed: false as const }; }
}

async function fixture(imported = true) {
  const runtime = new ReadbackRuntime();
  const provider = new Mdbx2Provider(runtime);
  const service = new SecureVaultService(new MemoryVaultStorage(), new MemoryVaultSessionStore());
  await service.setup("synthetic readback master password", []);
  await service.upsertProvider(account);
  const members = ["PASSWORD", "API_KEY"].map((loginType, index) => ({ ...createLoginItem({ title: `Synthetic grouped ${index}`, password: "synthetic-secret", providerRefs: [{ providerId: account.id }] }), loginType, passwordGroupId: "synthetic-explicit-group", customFields: [{ name: "monica.content.order", value: '["password","otp","passkey","note"]', protected: false }] })) as LoginItem[];
  if (imported) {
    for (const member of members) await runtime.upsertObject("", "", encodeMdbx2Object(member)!);
  } else await service.savePasswordGroup(members, {});
  async function sync() {
    const snapshot = await service.listItems();
    const result = await provider.sync(account, { now: new Date().toISOString(), localItems: snapshot });
    await service.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, snapshot);
    return result;
  }
  await sync();
  async function draft() { return (await service.listItems()).filter((item): item is LoginItem => item.kind === "login"); }
  return { runtime, provider, service, sync, draft };
}

function expected(items: LoginItem[]) { return Object.fromEntries(items.map(item => [item.id, item.updatedAt])); }

describe("MDBX native readback and editor compare-and-set", () => {
  it("preserves the editor version after an update is acknowledged and read back with native timestamps", async () => {
    const { service, sync, draft, runtime } = await fixture();
    const original = await draft();
    await service.savePasswordGroup(original.map(item => ({ ...item, password: "updated secret" })), expected(original));
    await sync();
    const opened = await draft();
    const writes = runtime.writes;
    await sync();
    expect(runtime.writes).toBe(writes);
    expect((await draft()).map(item => item.updatedAt)).toEqual(opened.map(item => item.updatedAt));
    await expect(service.savePasswordGroup(opened.map(item => ({ ...item, notes: "second draft edit" })), expected(opened))).resolves.toHaveLength(2);
  });

  it("does not rewrite a new group or invalidate its draft while attaching native defaults", async () => {
    const { service, sync, draft, runtime } = await fixture(false);
    const opened = await draft();
    const writes = runtime.writes;
    const readback = await sync();
    expect(readback.conflicts).toEqual([]);
    expect(runtime.writes).toBe(writes);
    expect((await draft()).map(item => item.updatedAt)).toEqual(opened.map(item => item.updatedAt));
    await expect(service.savePasswordGroup(opened.map(item => ({ ...item, notes: "new group second edit" })), expected(opened))).resolves.toHaveLength(2);
  });

  it("still rejects a draft when remote content changes even if the native timestamp is unchanged", async () => {
    const { service, sync, draft, runtime } = await fixture();
    const opened = await draft();
    const changed = runtime.records.values().next().value!;
    changed.payloadJson = JSON.stringify({ ...JSON.parse(changed.payloadJson), password_plain: "different Android secret" });
    changed.headCommitId = "synthetic-remote-change";
    await sync();
    const beforeRejectedSave = await service.readState();
    await expect(service.savePasswordGroup(opened.map(item => ({ ...item, notes: "stale edit" })), expected(opened))).rejects.toThrow("分组成员已被修改");
    expect(await service.readState()).toEqual(beforeRejectedSave);
  });

  it("does not treat a new native revision with an unknown field edit as an acknowledgement", async () => {
    const { service, sync, draft, runtime } = await fixture();
    const opened = await draft();
    const changed = runtime.records.values().next().value!;
    changed.payloadJson = JSON.stringify({ ...JSON.parse(changed.payloadJson), future_field: { mustSurvive: true } });
    changed.headCommitId = "synthetic-unknown-field-change";
    await sync();
    const before = await service.readState();
    await expect(service.savePasswordGroup(opened.map(item => ({ ...item, notes: "old draft" })), expected(opened))).rejects.toThrow("分组成员已被修改");
    expect(await service.readState()).toEqual(before);
    expect(JSON.parse(changed.payloadJson).future_field).toEqual({ mustSurvive: true });
  });
});
