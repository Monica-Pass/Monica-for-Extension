import { describe, expect, it } from "vitest";
import type { LoginItem, TotpItem } from "../../core/model";
import { generateHotp, parseTotpParameters } from "../../core/totp";
import { advanceHotpCounter } from "../../core/login-otp";
import { decodeMdbx2Object, encodeMdbx2Object } from "./mdbx2-item-codec";
import type { Mdbx2ObjectRecord } from "./native-contract";

const meta = { headCommitId: "synthetic-revision", updatedAt: "2026-09-30T00:00:00.000Z" };
function object(payloadJson: string, objectTypeId = "login"): Mdbx2ObjectRecord {
  return { objectId: "11111111-1111-4111-8111-111111111111", collectionId: "22222222-2222-4222-8222-222222222222", objectTypeId, title: "Synthetic", payloadJson, payloadSchemaVersion: 1, deleted: false };
}

describe("Android 1.0.315 lossless regressions", () => {
  it.each([undefined, null, ""])("preserves absent or empty Wi-Fi metadata %j on unrelated edits", value => {
    const payload = { kind: "password", login_type: "WIFI", wifi_metadata: value };
    const decoded = decodeMdbx2Object(object(JSON.stringify(payload)), meta, "fixture");
    expect(decoded.item?.kind).toBe("login");
    const written = encodeMdbx2Object({ ...decoded.item as LoginItem, notes: "Changed" }, decoded.payload, decoded.item)!;
    expect(JSON.parse(written.payloadJson)).toMatchObject(JSON.parse(JSON.stringify(payload)));
    if (value === undefined) expect(JSON.parse(written.payloadJson)).not.toHaveProperty("wifi_metadata");
  });

  it("writes newly created Wi-Fi metadata in the canonical Android field and reopens it", () => {
    const seed = decodeMdbx2Object(object('{"kind":"password","login_type":"WIFI"}'), meta, "fixture").item as LoginItem;
    const wifiMetadata = '{"ssid":"New network","security":"WPA3","hiddenNetwork":false,"eap":null}';
    const written = encodeMdbx2Object({ ...seed, wifiMetadata })!;
    expect(JSON.parse(written.payloadJson).wifi_metadata).toBe(wifiMetadata);
    const reopened = decodeMdbx2Object(object(written.payloadJson), meta, "fixture");
    expect(reopened.item).toMatchObject({ loginType: "WIFI", wifiMetadata });
  });

  it.each(["wifi_metadata", "wifiMetadata"])("reads full Android Wi-Fi %s and preserves nested values on a password edit", key => {
    const wifi = '{"ssid":"Enterprise","security":"WPA2_ENTERPRISE","hiddenNetwork":true,"eap":{"method":"TLS","domain":"example.test"},"proxy":{"kind":"takagi.ru.monica.data.model.WifiProxy.Manual","host":"proxy.test","port":8080},"ip":{"kind":"takagi.ru.monica.data.model.WifiIp.Static","ipAddress":"192.0.2.15","networkPrefixLength":24},"future":9007199254740993}';
    const decoded = decodeMdbx2Object(object(JSON.stringify({ kind: "password", login_type: "WIFI", password_plain: "old", [key]: wifi })), meta, "fixture");
    expect(decoded.item).toMatchObject({ kind: "login", wifiMetadata: wifi });
    const edited = encodeMdbx2Object({ ...decoded.item as LoginItem, password: "new" }, decoded.payload, decoded.item)!;
    expect(JSON.parse(edited.payloadJson)[key]).toBe(wifi);
    const changedWifi = wifi.replace('"Enterprise"', '"New network"');
    const updated = encodeMdbx2Object({ ...decoded.item as LoginItem, wifiMetadata: changedWifi }, decoded.payload, decoded.item)!;
    expect(JSON.parse(updated.payloadJson).wifi_metadata).toBe(changedWifi);
  });

  it("reads legacy Wi-Fi objects losslessly and leaves their raw shape on unrelated edits", () => {
    const decoded = decodeMdbx2Object(object('{"kind":"password","login_type":"WIFI","wifi_metadata":{"ssid":"Legacy","future":9007199254740993}}'), meta, "fixture");
    expect((decoded.item as LoginItem).wifiMetadata).toBe('{"ssid":"Legacy","future":9007199254740993}');
    const updated = encodeMdbx2Object({ ...decoded.item as LoginItem, notes: "Updated note" }, decoded.payload, decoded.item)!;
    expect(updated.payloadJson).toContain('"wifi_metadata":{"ssid":"Legacy","future":9007199254740993}');
  });

  it.each([false, 42, []])("protects unsupported Wi-Fi metadata shape %j instead of silently emptying it", value => {
    const decoded = decodeMdbx2Object(object(JSON.stringify({ kind: "password", login_type: "WIFI", wifi_metadata: value })), meta, "fixture");
    expect(decoded.item?.kind).toBe("opaque");
  });

  it.each([undefined, null])("preserves Steam source shapes and %s logical identity on a title-only edit", (identity) => {
    const payload = { monica_entry_id: identity, steamid: null, account_name: null, mafile_json: '{"account_name":"synthetic","shared_secret":"AQIDBA==","steamid":76561198000000001,"future":9007199254740993}' };
    const decoded = decodeMdbx2Object(object(JSON.stringify(payload), "steam-mafile"), meta, "fixture");
    expect(decoded.item?.kind).toBe("totp");
    const written = encodeMdbx2Object({ ...decoded.item!, title: "Edited title" }, decoded.payload, decoded.item)!;
    expect(written.logicalObjectId).toBe("native:11111111-1111-4111-8111-111111111111");
    expect(JSON.parse(written.payloadJson)).toEqual(JSON.parse(JSON.stringify(payload)));
  });

  it.each(["steam_mafile", "STEAM-MAFILE", " steam-mafile"])("keeps unfamiliar native type %s visible and readonly", (nativeType) => {
    const payload = { mafile_json: '{"account_name":"synthetic","shared_secret":"AQIDBA=="}' };
    const decoded = decodeMdbx2Object(object(JSON.stringify(payload), nativeType), meta, "fixture");
    expect(decoded.item).toMatchObject({ kind: "opaque", nativeType, originalPayload: JSON.stringify(payload) });
    expect(() => encodeMdbx2Object(decoded.item!, decoded.payload, decoded.item)).toThrow("仅可读取");
  });

  it("keeps Android SecureItem Steam authenticators as native totp despite maFile metadata", () => {
    const payload = { kind: "totp", monica_entry_id: "totp:synthetic-steam", item_data: JSON.stringify({ secret: "JBSWY3DPEHPK3PXP", otpType: "STEAM", steamRawJson: '{"steamid":"0007"}', future: null }) };
    const decoded = decodeMdbx2Object(object(JSON.stringify(payload), "totp"), meta, "fixture");
    expect(decoded.item?.kind).toBe("totp");
    const written = encodeMdbx2Object({ ...decoded.item!, title: "New title" }, decoded.payload, decoded.item)!;
    expect(written.objectTypeId).toBe("totp");
    expect(JSON.parse(written.payloadJson)).toEqual(payload);
  });

  it("preserves large integers, precise decimals and literal serde marker keys on a password edit", () => {
    const payload = '{"kind":"password","monica_entry_id":"password:42","password_plain":"old","future":{"counter":9007199254740993,"decimal":1.234567890123456789,"$serde_json::private::Number":"literal","nil":null,"empty":"","no":false}}';
    const decoded = decodeMdbx2Object(object(payload), meta, "fixture");
    const written = encodeMdbx2Object({ ...decoded.item as LoginItem, password: "new" }, decoded.payload, decoded.item)!;
    expect(written.payloadJson).toContain('"counter":9007199254740993');
    expect(written.payloadJson).toContain('"decimal":1.234567890123456789');
    expect(JSON.parse(written.payloadJson).future).toMatchObject({ "$serde_json::private::Number": "literal", nil: null, empty: "", no: false });
  });

  it("retains exact nested numbers when editing one secure item field", () => {
    const decoded = decodeMdbx2Object(object(JSON.stringify({ kind: "note", item_data: '{"content":"body","future":{"counter":9007199254740993,"ratio":0.1234567890123456789}}' }), "note"), meta, "fixture");
    if (decoded.item?.kind !== "secure-note") throw new Error("Expected note");
    const written = encodeMdbx2Object({ ...decoded.item, content: "edited" }, decoded.payload, decoded.item)!;
    expect(JSON.parse(written.payloadJson).item_data).toContain('"counter":9007199254740993');
    expect(JSON.parse(written.payloadJson).item_data).toContain('"ratio":0.1234567890123456789');
  });

  it("does not clear explicit null or alter websites on an unrelated edit", () => {
    const payload = { kind: "password", password_plain: "", password: "legacy", website: "https://example.invalid/a;b?x=1,2\nhttps://second.invalid", app_name: null, passkey_bindings: null };
    const decoded = decodeMdbx2Object(object(JSON.stringify(payload)), meta, "fixture");
    expect((decoded.item as LoginItem).password).toBe("");
    const written = encodeMdbx2Object({ ...decoded.item as LoginItem, notes: "changed" }, decoded.payload, decoded.item)!;
    expect(JSON.parse(written.payloadJson)).toMatchObject(payload);
  });

  it("reads a HOTP counter above Number.MAX_SAFE_INTEGER and advances it exactly", () => {
    const decoded = decodeMdbx2Object(object(JSON.stringify({ kind: "totp", item_data: '{"secret":"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ","otpType":"HOTP","counter":9007199254740993}' }), "totp"), meta, "fixture");
    const item = decoded.item as TotpItem;
    expect(String(item.counter)).toBe("9007199254740993");
    const next = advanceHotpCounter(item)! as TotpItem;
    expect(String(next.counter)).toBe("9007199254740994");
    expect(JSON.parse(encodeMdbx2Object(next, decoded.payload, item)!.payloadJson).item_data).toContain('"counter":9007199254740994');
  });

  it("preserves full-range HOTP URIs and produces RFC HMAC for exact counter bytes", async () => {
    const parameters = parseTotpParameters("otpauth://hotp/Test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&counter=9007199254740993");
    expect(String(parameters.counter)).toBe("9007199254740993");
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, 9007199254740993n);
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("12345678901234567890"), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const signed = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
    const offset = signed[19] & 15;
    const expected = String((new DataView(signed.buffer).getUint32(offset) & 0x7fffffff) % 1000000).padStart(6, "0");
    expect(await generateHotp(parameters)).toBe(expected);
  });
});
