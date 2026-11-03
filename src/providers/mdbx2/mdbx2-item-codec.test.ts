import { describe, expect, it } from "vitest";
import type { CardItem, LoginItem, PasskeyItem, SecureNoteItem, TotpItem, VaultItem } from "../../core/model";
import type { Mdbx2ObjectRecord } from "./native-contract";
import { decodeMdbx2Object, encodeMdbx2Object, mdbx2LogicalObjectId } from "./mdbx2-item-codec";

const META = { headCommitId: "commit-1", updatedAt: "2026-08-02T00:00:00Z" };
const P256_PKCS8 = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsloK6aKNvj0CZMYdBdSZs+AUAsFy1t66q4tq5SvyeJahRANCAASlCTbHlIcaKQ2lzoEFhtjkLEO++f3cYq6FMYG7eH3BmuLQPz71FAtWq4z+tIb7oequwhUJL3xos1nA8jFqpkDs";

describe("MDBX2 Android item codec", () => {
  it("decodes stable note links and preserves or explicitly replaces them independently of Room IDs", () => {
    const payload = { kind: "password", monica_entry_id: "password:42", bound_note_entry_id: "note:stable", bound_note_room_id: 17, future: { keep: true } };
    const record: Mdbx2ObjectRecord = { objectId: "native-login", collectionId: "vault", objectTypeId: "login", title: "Linked", payloadSchemaVersion: 1, deleted: false, payloadJson: JSON.stringify(payload) };
    const decoded = decodeMdbx2Object(record, META, "source");
    expect(decoded.item).toMatchObject({ boundNoteEntryId: "note:stable", boundNoteId: 17 });
    const original = decoded.item as LoginItem;
    const write = (patch: Partial<LoginItem>) => JSON.parse(encodeMdbx2Object({ ...original, ...patch }, decoded.payload, original)!.payloadJson);
    expect(write({ title: "Renamed" })).toEqual(payload);
    expect(write({ boundNoteEntryId: "note:replacement", boundNoteId: undefined })).toMatchObject({ bound_note_entry_id: "note:replacement", bound_note_room_id: null, future: { keep: true } });
    expect(write({ boundNoteEntryId: undefined, boundNoteId: undefined })).toMatchObject({ bound_note_entry_id: null, bound_note_room_id: null });
    for (const source of [undefined, null, "", 123, { future: true }]) {
      const raw = { ...payload, bound_note_entry_id: source };
      const item = decodeMdbx2Object({ ...record, payloadJson: JSON.stringify(raw) }, META, "source");
      expect(item.item?.boundNoteEntryId).toBeUndefined();
      expect(JSON.parse(encodeMdbx2Object({ ...item.item!, title: "Changed" }, item.payload, item.item)!.payloadJson)).toEqual(JSON.parse(JSON.stringify(raw)));
    }
  });
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

  it("reads independent MDBX login url and totp_seed into website and authenticator fields", () => {
    const record: Mdbx2ObjectRecord = {
      objectId: "11111111-1111-4111-8111-111111111111",
      collectionId: "22222222-2222-4222-8222-222222222222",
      objectTypeId: "login",
      title: "Gmail",
      payloadSchemaVersion: 1,
      deleted: false,
      payloadJson: JSON.stringify({
        username: "tester.monica@example.com",
        password: "secret",
        url: "https://accounts.google.com",
        totp_seed: "otpauth://totp/Gmail:tester.monica@example.com?secret=JBSWY3DPEHPK3PXP"
      })
    };
    const decoded = decodeMdbx2Object(record, META, "mdbx-provider");
    expect(decoded.item).toMatchObject({
      kind: "login",
      username: "tester.monica@example.com",
      uris: ["https://accounts.google.com"],
      totpSecret: "otpauth://totp/Gmail:tester.monica@example.com?secret=JBSWY3DPEHPK3PXP"
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
    expect(encoded).toMatchObject({ objectTypeId: "steam-mafile", logicalObjectId: `native:${record.objectId}`, expectedHeadCommitId: META.headCommitId });
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
        private_key_alias: P256_PKCS8,
        sign_count: 2,
        backup_eligible: false,
        backup_state: false
      })
    };
    const item = decodeMdbx2Object(record, META, "mdbx-provider").item as PasskeyItem;
    expect(item).toMatchObject({ sourceMode: "browser-local", privateKeyPkcs8: P256_PKCS8, signCount: 2 });
    expect(item).toMatchObject({ backupEligible: false, backupState: false });
    const written = encodeMdbx2Object({ ...item, signCount: 0 })!;
    expect(JSON.parse(written.payloadJson)).toMatchObject({ sign_count: 0, backup_eligible: false, backup_state: false, private_key_alias: P256_PKCS8 });

    const metadataOnly = decodeMdbx2Object({ ...record, payloadJson: record.payloadJson.replace(P256_PKCS8, "monica-passkey-key-ref-v1:device-only") }, META, "mdbx-provider").item as PasskeyItem;
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
    expect(decoded.item).toMatchObject({ kind: "opaque", nativeType: "future.secret/v9", payloadSchemaVersion: 9 });
    expect(decoded.payload).toEqual({ monica_entry_id: "future:1", opaque: true });
    expect(decoded.unsupportedReason).toContain("future.secret/v9");
  });

  it('preserves current Android Passkey preferences and metadata without changing its identity/key/counter', () => {
    const payload = { kind: 'passkey', monica_entry_id: 'passkey:AQID', credential_id: 'AQID', private_key_alias: P256_PKCS8, public_key_algorithm: -7,
      is_discoverable: false, is_user_verification_required: false, created_at: 1700000000000, last_used_at: 1710000000000,
      use_count: 19, icon_url: 'https://example.test/icon', sign_count: 0, future: { keep: true } };
    const record: Mdbx2ObjectRecord = { objectId: 'metadata', collectionId: 'vault', objectTypeId: 'passkey', title: 'Synthetic',
      payloadSchemaVersion: 1, deleted: false, payloadJson: JSON.stringify(payload) };
    const decoded = decodeMdbx2Object(record, META, 'mdbx-provider'), item = decoded.item as PasskeyItem;
    expect(item).toMatchObject({ discoverable: false, userVerificationRequired: false, createdAt: new Date(payload.created_at).toISOString(),
      lastUsedAt: new Date(payload.last_used_at).toISOString(), useCount: 19, iconUrl: payload.icon_url, signCount: 0, privateKeyPkcs8: P256_PKCS8 });
    expect(JSON.parse(encodeMdbx2Object({ ...item, title: 'Renamed' }, decoded.payload, item)!.payloadJson)).toEqual(payload);
    const edited = JSON.parse(encodeMdbx2Object({ ...item, discoverable: true, userVerificationRequired: true, iconUrl: undefined }, decoded.payload, item)!.payloadJson);
    expect(edited).toEqual({ ...payload, is_discoverable: true, is_user_verification_required: true, icon_url: null });
    const copied = JSON.parse(encodeMdbx2Object(item)!.payloadJson);
    expect(copied).toMatchObject({ is_discoverable: false, is_user_verification_required: false, created_at: payload.created_at,
      last_used_at: payload.last_used_at, use_count: 19, sign_count: 0, private_key_alias: P256_PKCS8 });
    const cleared = JSON.parse(encodeMdbx2Object({ ...item, lastUsedAt: undefined, useCount: undefined }, decoded.payload, item)!.payloadJson);
    expect(cleared).toEqual({ ...payload, last_used_at: null, use_count: null });
    for (const patch of [{ createdAt: 'invalid' }, { lastUsedAt: 'invalid' }, { useCount: -1 }, { useCount: 0x80000000 }])
      expect(encodeMdbx2Object({ ...item, ...patch })).toBeUndefined();
  });

  it.each([{ is_discoverable: 'false' }, { is_user_verification_required: 0 }, { created_at: 8.64e15 + 1 },
    { last_used_at: -1 }, { use_count: 1.5 }, { use_count: 0x80000000 }, { icon_url: { unknown: true } }])('retains unfamiliar Passkey metadata without replacing its policy with defaults %#', patch => {
      const payload = { kind: 'passkey', credential_id: 'AQID', private_key_alias: P256_PKCS8, ...patch };
      const result = decodeMdbx2Object({ objectId: 'metadata', collectionId: 'vault', objectTypeId: 'passkey', title: 'Synthetic',
        payloadSchemaVersion: 1, deleted: false, payloadJson: JSON.stringify(payload) }, META, 'source');
      expect(result.item?.kind).toBe('opaque'); expect(JSON.stringify(result.payload)).toBe(JSON.stringify(payload));
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
