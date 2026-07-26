import { describe, expect, it } from "vitest";
import type { ProviderAccount, VaultItem } from "./model";
import { ProviderRegistry, type ProviderAdapter, type ProviderSyncResult } from "./provider";

function account(id: string, config: Record<string, unknown>): ProviderAccount {
  return { id, kind: "keepass", name: id, enabled: true, isDefaultSaveTarget: false, config };
}

class FakeKeePassAdapter implements ProviderAdapter {
  readonly kind = "keepass" as const;
  private readonly opened = new Map<string, string>();

  async testConnection(): Promise<void> {}

  async sync(target: ProviderAccount): Promise<ProviderSyncResult> {
    this.opened.set(target.id, String(target.config.file));
    return { items: [], conflicts: [], warnings: [], sourceRecords: [{ providerId: target.id, remoteId: String(target.config.file), format: "kdbx-entry", encoding: "base64", payload: "", contentHash: target.id }] };
  }

  async create(_target: ProviderAccount, item: VaultItem): Promise<VaultItem> { return item; }
  async update(_target: ProviderAccount, item: VaultItem): Promise<VaultItem> { return item; }
  async remove(): Promise<void> {}

  openedFiles(): string[] { return [...this.opened.values()]; }
}

describe("provider registry", () => {
  it("keeps one adapter per kind, so multi-file providers must multiplex on account id", async () => {
    const registry = new ProviderRegistry();
    const adapter = new FakeKeePassAdapter();
    registry.register(adapter);
    registry.register(adapter);

    const first = await registry.get("keepass").sync(account("kdbx-a", { file: "personal.kdbx" }), { now: "2026-07-26T00:00:00.000Z", localItems: [] });
    const second = await registry.get("keepass").sync(account("kdbx-b", { file: "work.kdbx" }), { now: "2026-07-26T00:00:00.000Z", localItems: [] });

    expect(adapter.openedFiles()).toEqual(["personal.kdbx", "work.kdbx"]);
    expect(first.sourceRecords?.[0].providerId).toBe("kdbx-a");
    expect(second.sourceRecords?.[0].providerId).toBe("kdbx-b");
  });

  it("names the missing kind when an adapter was never registered", () => {
    expect(() => new ProviderRegistry().get("mdbx")).toThrow("mdbx");
  });
});
