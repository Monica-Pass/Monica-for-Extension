import { describe, expect, it } from "vitest";
import type { LoginItem } from "../../core/model";
import { decodeMdbx2Object, encodeMdbx2Object } from "./mdbx2-item-codec";

const metadata = { headCommitId: "commit-1", updatedAt: "2026-10-05T00:00:00Z" };
function decode(payload: Record<string, unknown>) {
  return decodeMdbx2Object({ objectId: "native-password", collectionId: "vault", objectTypeId: "login",
    title: "Synthetic", deleted: false, payloadSchemaVersion: 1, payloadJson: JSON.stringify(payload) }, metadata, "source");
}
const legacy = { kind: "password", monica_entry_id: "password:123", password_plain: "MDK|synthetic legacy content", future: { keep: true } };

describe("Android MDBX password encoding contract", () => {
  it.each(["ordinary password", "MDK|literal user password", "V2|literal", "C2|literal", ""])("marks a newly written password as plaintext: %s", password => {
    const item = decode(legacy).item as LoginItem;
    const payload = JSON.parse(encodeMdbx2Object({ ...item, password })!.payloadJson);
    expect(payload).toMatchObject({ password_plain: password, monica_password_encoding: "plaintext-v1" });
  });

  it.each([undefined, null, "", "plaintext-v1"])("preserves unrelated legacy edits and encoding %s exactly", marker => {
    const payload = { ...legacy, monica_password_encoding: marker };
    const source = decode(payload), original = source.item as LoginItem;
    const written = JSON.parse(encodeMdbx2Object({ ...original, title: "Renamed" }, source.payload, original)!.payloadJson);
    expect(written).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(source.item).toMatchObject({ kind: "login", password: legacy.password_plain });
  });

  it.each([undefined, null, "", "plaintext-v1"])("marks an explicitly changed password after preservation, encoding %s", marker => {
    const source = decode({ ...legacy, monica_password_encoding: marker }), original = source.item as LoginItem;
    for (const password of ["MDK|literal changed password", ""]) {
      const written = JSON.parse(encodeMdbx2Object({ ...original, password }, source.payload, original)!.payloadJson);
      expect(written).toEqual({ ...legacy, password_plain: password, monica_password_encoding: "plaintext-v1" });
    }
  });

  it("writes the marker when replacing the legacy password alias", () => {
    const source = decode({ password: "old", future: true }), original = source.item as LoginItem;
    const written = JSON.parse(encodeMdbx2Object({ ...original, password: "new" }, source.payload, original)!.payloadJson);
    expect(written).toEqual({ password: "old", password_plain: "new", monica_entry_id: "native:native-password", monica_password_encoding: "plaintext-v1", future: true });
  });

  it.each(["encrypted-v2", 2, false, { version: 2 }])("keeps unknown encoding %s read-only and rejects a forced write", marker => {
    const payload = { ...legacy, monica_password_encoding: marker };
    const source = decode(payload);
    expect(source.item?.kind).toBe("opaque");
    expect(source.payload).toEqual(payload);
    const known = decode(legacy).item as LoginItem;
    expect(() => encodeMdbx2Object({ ...known, password: "changed" }, payload, known)).toThrow(/编码/);
  });
});
