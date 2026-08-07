import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import { buildKeePassFixture, keePassCredentials } from "./keepass-fixture";
import { KeePassRemoteRebaseConflictError, rebaseKeePassDatabase } from "./keepass-remote-rebase";

const PASSWORD = "rebase fixture password";

describe("KeePass field-aware remote rebase", () => {
  it("keeps an unrelated remote field while applying the local field change", async () => {
    const bytes = await buildKeePassFixture({
      password: PASSWORD,
      entries: [{ title: "Base title", fields: { UserName: "base-user" }, protectedFields: { Password: "base-password" } }]
    });
    const [base, working, remote] = await loadCopies(bytes);
    const baseEntry = base.getDefaultGroup().entries[0];
    const workingEntry = working.getDefaultGroup().entries[0];
    const remoteEntry = remote.getDefaultGroup().entries[0];
    workingEntry.fields.set("Title", "Local title");
    remoteEntry.fields.set("UserName", "Remote user");

    rebaseKeePassDatabase(base, working, remote);

    expect(remoteEntry.fields.get("Title")).toBe("Local title");
    expect(remoteEntry.fields.get("UserName")).toBe("Remote user");
    expect(remoteEntry.fields.get("Password")).toBeInstanceOf(kdbxweb.ProtectedValue);
  });

  it("fails closed when both replicas change the same field", async () => {
    const bytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Base title" }] });
    const [base, working, remote] = await loadCopies(bytes);
    working.getDefaultGroup().entries[0].fields.set("Title", "Local title");
    remote.getDefaultGroup().entries[0].fields.set("Title", "Remote title");

    try {
      rebaseKeePassDatabase(base, working, remote);
      throw new Error("expected a rebase conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(KeePassRemoteRebaseConflictError);
      expect((error as KeePassRemoteRebaseConflictError).conflicts).toEqual([
        expect.objectContaining({ kind: "field", fieldNames: ["Title"] })
      ]);
    }
  });

  it("treats the protected flag as part of the field base value", async () => {
    const bytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Entry", protectedFields: { Password: "same" } }] });
    const [base, working, remote] = await loadCopies(bytes);
    working.getDefaultGroup().entries[0].fields.set("Password", "same");

    rebaseKeePassDatabase(base, working, remote);

    expect(remote.getDefaultGroup().entries[0].fields.get("Password")).toBe("same");
    expect(remote.getDefaultGroup().entries[0].fields.get("Password")).not.toBeInstanceOf(kdbxweb.ProtectedValue);
  });

  it("fails closed when both replicas move an entry to different groups", async () => {
    const bytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Entry", group: "Base" }] });
    const [base, working, remote] = await loadCopies(bytes);
    const workingGroup = working.createGroup(working.getDefaultGroup(), "Local");
    const remoteGroup = remote.createGroup(remote.getDefaultGroup(), "Remote");
    working.move(working.getDefaultGroup().groups.find((group) => group.name === "Base")!.entries[0], workingGroup);
    remote.move(remote.getDefaultGroup().groups.find((group) => group.name === "Base")!.entries[0], remoteGroup);

    try {
      rebaseKeePassDatabase(base, working, remote);
      throw new Error("expected a structural conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(KeePassRemoteRebaseConflictError);
      expect((error as KeePassRemoteRebaseConflictError).conflicts).toEqual([
        expect.objectContaining({ kind: "entry-structure" })
      ]);
    }
  });

  it("merges independent attachment names and copies the local binary into the remote pool", async () => {
    const bytes = await buildKeePassFixture({
      password: PASSWORD,
      entries: [{ title: "Entry", binaries: { "base.txt": new Uint8Array([1]) } }]
    });
    const [base, working, remote] = await loadCopies(bytes);
    const workingEntry = working.getDefaultGroup().entries[0];
    const remoteEntry = remote.getDefaultGroup().entries[0];
    workingEntry.binaries.set("local.txt", await working.createBinary(new Uint8Array([2]).buffer));
    remoteEntry.binaries.set("remote.txt", await remote.createBinary(new Uint8Array([3]).buffer));

    rebaseKeePassDatabase(base, working, remote);

    expect([...remoteEntry.binaries.keys()].sort()).toEqual(["base.txt", "local.txt", "remote.txt"]);
    const saved = new Uint8Array(await remote.save());
    const reopened = await kdbxweb.Kdbx.load(saved.buffer, keePassCredentials(PASSWORD));
    expect([...reopened.getDefaultGroup().entries[0].binaries.keys()].sort()).toEqual(["base.txt", "local.txt", "remote.txt"]);
  });

  it("preserves a remote unknown field during a local managed-field removal", async () => {
    const bytes = await buildKeePassFixture({ password: PASSWORD, entries: [{ title: "Entry", fields: { "MonicaLocalId": "7" } }] });
    const [base, working, remote] = await loadCopies(bytes);
    working.getDefaultGroup().entries[0].fields.delete("MonicaLocalId");
    remote.getDefaultGroup().entries[0].fields.set("PluginState", "remote-state");

    rebaseKeePassDatabase(base, working, remote);

    expect(remote.getDefaultGroup().entries[0].fields.has("MonicaLocalId")).toBe(false);
    expect(remote.getDefaultGroup().entries[0].fields.get("PluginState")).toBe("remote-state");
  });
});

async function loadCopies(bytes: Uint8Array): Promise<[kdbxweb.Kdbx, kdbxweb.Kdbx, kdbxweb.Kdbx]> {
  const load = () => kdbxweb.Kdbx.load(bytes.slice().buffer, keePassCredentials(PASSWORD));
  return [await load(), await load(), await load()];
}
