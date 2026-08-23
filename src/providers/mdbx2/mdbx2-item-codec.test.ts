import { describe, expect, it } from "vitest";
import type { CardItem, LoginItem, PasskeyItem, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";
import type { Mdbx2ObjectRecord } from "./native-contract";
import { decodeMdbx2Object, encodeMdbx2Object, mdbx2LogicalObjectId } from "./mdbx2-item-codec";

const META = { headCommitId: "commit-1", updatedAt: "2026-08-02T00:00:00Z" };

describe("MDBX2 Android item codec", () => {
  it("uses the current Android logical ID prefixes for every shared item kind", () => {
    const cases: Array<[VaultItem["kind"], string]> = [
      ["login", "password"],
      ["secure-note", "note"],
      ["totp", "totp"],
      ["card", "card"],
      ["identity", "document-ref"],
      ["billing-address", "billing-address"],
      ["payment-account", "payment-account"]
    ];
    for (const [kind, prefix] of cases) {
      const local = stubItem(kind, "local-item");
      expect(mdbx2LogicalObjectId(local), kind).toBe(`${prefix}:local-item`);
      expect(mdbx2LogicalObjectId({ ...local, replicaGroupId: `${prefix}:android-id` }), kind).toBe(`${prefix}:android-id`);
      expect(mdbx2LogicalObjectId({ ...local, replicaGroupId: "wrong:android-id" }), kind).toBe(`${prefix}:local-item`);
    }
  });

  it("decodes Android login payloads and preserves unknown fields on write", () => {
    const record: Mdbx2ObjectRecord = {
      objectId: "11111111-1111-4111-8111-111111111111",
      collectionId: "22222222-2222-4222-8222-222222222222",
      objectTypeId: "login",
      title: "Example",
      payloadSchemaVersion: 1,
      deleted: false,
      payloadJson: JSON.stringify({
        kind: "password",
        monica_entry_id: "password:42",
        website: "https://example.test",
        username: "demo",
        password_plain: "secret",
        login_type: "PASSWORD",
        custom_fields: [{ title: "Tenant", value: "acme", is_protected: false, future_field: "keep" }],
        future_android_field: { version: 3 }
      })
    };
    const decoded = decodeMdbx2Object(record, META, "mdbx-provider");
    expect(decoded.item).toMatchObject({
      kind: "login",
      title: "Example",
      username: "demo",
      password: "secret",
      uris: ["https://example.test"],
      replicaGroupId: "password:42",
      mdbxFolderId: record.collectionId,
      customFields: [{ name: "Tenant", value: "acme", protected: false }]
    });
    const changed = { ...(decoded.item as LoginItem), password: "new-secret" };
    const encoded = encodeMdbx2Object(changed, decoded.payload, decoded.item)!;
    expect(JSON.parse(encoded.payloadJson)).toMatchObject({
      monica_entry_id: "password:42",
      password_plain: "new-secret",
      custom_fields: [{ title: "Tenant", value: "acme", is_protected: false, future_field: "keep" }],
      future_android_field: { version: 3 }
    });
  });

  it("preserves unknown nested Android wallet fields when one mapped value changes", () => {
    const record: Mdbx2ObjectRecord = {
      objectId: "11111111-1111-4111-8111-111111111111",
      collectionId: "22222222-2222-4222-8222-222222222222",
      objectTypeId: "card",
      title: "Travel",
      payloadSchemaVersion: 1,
      deleted: false,
      payloadJson: JSON.stringify({
        kind: "bank_card",
        monica_entry_id: "card:7",
        item_data: JSON.stringify({
          cardholderName: "Demo",
          cardNumber: "4111111111111111",
          expiryMonth: "12",
          expiryYear: "2030",
          cvv: "123",
          future_wallet_field: { version: 4 }
        })
      })
    };
    const decoded = decodeMdbx2Object(record, META, "mdbx-provider");
    const changed = { ...(decoded.item as CardItem), number: "5555555555554444" };
    const encoded = encodeMdbx2Object(changed, decoded.payload, decoded.item)!;
    const payload = JSON.parse(encoded.payloadJson) as { item_data: string };
    expect(JSON.parse(payload.item_data)).toMatchObject({
      cardNumber: "5555555555554444",
      future_wallet_field: { version: 4 }
    });
  });

  it("round-trips Android note custom fields while preserving future item data", () => {
    const record: Mdbx2ObjectRecord = {
      objectId: "11111111-1111-4111-8111-111111111111",
      collectionId: "22222222-2222-4222-8222-222222222222",
      objectTypeId: "note",
      title: "Recovery",
      payloadSchemaVersion: 1,
      deleted: false,
      payloadJson: JSON.stringify({
        kind: "note",
        monica_entry_id: "note:9",
        item_data: JSON.stringify({
          content: "private body",
          isMarkdown: true,
          customFields: [{ label: "Recovery code", value: "ABCD", type: "HIDDEN" }],
          future_note_field: { preserve: true }
        })
      })
    };
    const decoded = decodeMdbx2Object(record, META, "mdbx-provider");
    const note = decoded.item as SecureNoteItem;
    expect(note.customFields).toEqual([{ name: "Recovery code", value: "ABCD", protected: true, fieldType: "HIDDEN" }]);

    const encoded = encodeMdbx2Object({
      ...note,
      customFields: [{ name: "Recovery code", value: "WXYZ", protected: true, fieldType: "HIDDEN" }]
    }, decoded.payload, decoded.item)!;
    const payload = JSON.parse(encoded.payloadJson) as { item_data: string };
    expect(JSON.parse(payload.item_data)).toEqual({
      content: "private body",
      isMarkdown: true,
      customFields: [{ label: "Recovery code", value: "WXYZ", type: "HIDDEN" }],
      future_note_field: { preserve: true }
    });
  });

  it("maps Android steam-mafile Objects to usable Steam records and writes them back losslessly", () => {
    const maFile = JSON.stringify({
      account_name: "alice",
      steamid: "76561198000000000",
      shared_secret: "MTIzNDU2Nzg=",
      identity_secret: "identity",
      future_mafile_field: { keep: true }
    });
    const record: Mdbx2ObjectRecord = {
      objectId: "11111111-1111-4111-8111-111111111111",
      collectionId: "22222222-2222-4222-8222-222222222222",
      objectTypeId: "steam-mafile",
      title: "Alice",
      payloadSchemaVersion: 1,
      deleted: false,
      payloadJson: JSON.stringify({
        kind: "steam_mafile",
        monica_entry_id: "steam-mafile:76561198000000000",
        steamid: "76561198000000000",
        account_name: "alice",
        mafile_json: maFile,
        future_payload_field: 9
      })
    };
    const decoded = decodeMdbx2Object(record, META, "mdbx-provider");
    expect(decoded.item).toMatchObject({
      kind: "totp",
      otpType: "STEAM",
      accountName: "alice",
      steamId: "76561198000000000",
      steamIdentitySecret: "identity",
      replicaGroupId: "steam-mafile:76561198000000000"
    });
    const changed = { ...(decoded.item as TotpItem), accountName: "alice-new" };
    const encoded = encodeMdbx2Object(changed, decoded.payload, decoded.item)!;
    const payload = JSON.parse(encoded.payloadJson) as Record<string, unknown>;
    expect(encoded).toMatchObject({ objectTypeId: "steam-mafile", logicalObjectId: "steam-mafile:76561198000000000" });
    expect(payload).toMatchObject({ account_name: "alice-new", future_payload_field: 9 });
    expect(JSON.parse(String(payload.mafile_json))).toMatchObject({ account_name: "alice-new", future_mafile_field: { keep: true } });
  });

  it("marks an MDBX2 passkey usable only when portable private key material is present", () => {
    const record: Mdbx2ObjectRecord = {
      objectId: "11111111-1111-4111-8111-111111111111",
      collectionId: "22222222-2222-4222-8222-222222222222",
      objectTypeId: "passkey",
      title: "Example Passkey",
      payloadSchemaVersion: 1,
      deleted: false,
      payloadJson: JSON.stringify({
        kind: "passkey",
        monica_entry_id: "passkey:credential",
        credential_id: "credential",
        rp_id: "example.test",
        rp_name: "Example",
        user_id: "dXNlcg",
        user_name: "demo",
        user_display_name: "Demo",
        public_key_algorithm: -7,
        public_key: "public",
        private_key_alias: "private-pkcs8",
        sign_count: 2
      })
    };
    const item = decodeMdbx2Object(record, META, "mdbx-provider").item as PasskeyItem;
    expect(item).toMatchObject({ sourceMode: "browser-local", privateKeyPkcs8: "private-pkcs8", signCount: 2 });

    const metadataOnly = decodeMdbx2Object({ ...record, payloadJson: record.payloadJson.replace("private-pkcs8", "") }, META, "mdbx-provider").item as PasskeyItem;
    expect(metadataOnly).toMatchObject({ sourceMode: "android-metadata-only", privateKeyPkcs8: undefined });
  });

  it("preserves future Object types without pretending they are usable", () => {
    const decoded = decodeMdbx2Object({
      objectId: "11111111-1111-4111-8111-111111111111",
      collectionId: "22222222-2222-4222-8222-222222222222",
      objectTypeId: "future.secret/v9",
      title: "Future",
      payloadJson: JSON.stringify({ monica_entry_id: "future:1", opaque: true }),
      payloadSchemaVersion: 9,
      deleted: false
    }, META, "mdbx-provider");
    expect(decoded.item).toBeUndefined();
    expect(decoded.payload).toEqual({ monica_entry_id: "future:1", opaque: true });
    expect(decoded.unsupportedReason).toContain("future.secret/v9");
  });
});

function stubItem(kind: VaultItem["kind"], id: string): VaultItem {
  return {
    id,
    kind,
    title: kind,
    favorite: false,
    notes: "",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    providerRefs: []
  } as unknown as VaultItem;
}
