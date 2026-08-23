import { describe, expect, it, vi } from "vitest";
import type { ProviderAccount } from "../../core/model";
import { bitwardenAccountsForSync, syncBitwardenAccountsIsolated } from "./bitwarden-multi-account-sync";

function account(id: string, input: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id, kind: "bitwarden", name: id, enabled: true, isDefaultSaveTarget: false, config: { authenticated: true }, ...input };
}

describe("Bitwarden multi-account sync", () => {
  it("selects only enabled authenticated Bitwarden accounts in stable order", () => {
    expect(bitwardenAccountsForSync([
      account("first"),
      account("disabled", { enabled: false }),
      account("signed-out", { config: { authenticated: false } }),
      account("webdav", { kind: "monica-webdav" }),
      account("second", { isDefaultSaveTarget: true })
    ]).map((entry) => entry.id)).toEqual(["second", "first"]);
  });

  it("continues with later accounts after one account fails without returning its error", async () => {
    const synchronize = vi.fn(async (entry: ProviderAccount) => {
      if (entry.id === "first") throw new Error("private server detail");
      return { conflicts: 2, warnings: ["bounded warning"] };
    });

    const result = await syncBitwardenAccountsIsolated([account("first"), account("second")], synchronize);
    expect(synchronize.mock.calls.map(([entry]) => entry.id)).toEqual(["first", "second"]);
    expect(result).toEqual([
      { providerId: "first", ok: false, conflicts: 0, warnings: 0 },
      { providerId: "second", ok: true, conflicts: 2, warnings: 1 }
    ]);
    expect(JSON.stringify(result)).not.toContain("private server detail");
  });
});
