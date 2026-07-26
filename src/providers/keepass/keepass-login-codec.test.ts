import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import {
  buildKeePassLoginFields,
  buildKeePassLoginPatch,
  isKeePassEmptyEntry,
  isKeePassTemplateEntry,
  keePassEntryHasTotpFields,
  keePassFieldText,
  keePassPreservedFieldNames,
  readKeePassCustomFields,
  readKeePassLoginFields,
  resolveKeePassEntryPassword,
  type KeePassEntryFieldValue
} from "./keepass-login-codec";
import { applyKeePassFieldPatch } from "./keepass-field-patch";
import type { LoginItem } from "../../core/model";

/** Assertion semantics translated from Android `KeePassKdbxService.kt` password-entry paths. */
function fields(entries: Record<string, string | kdbxweb.ProtectedValue>): Map<string, KeePassEntryFieldValue> {
  return new Map(Object.entries(entries));
}

function secret(value: string): kdbxweb.ProtectedValue {
  return kdbxweb.ProtectedValue.fromString(value);
}

function login(overrides: Partial<LoginItem> = {}): LoginItem {
  return {
    id: "item-1",
    kind: "login",
    title: "GitHub",
    favorite: false,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    providerRefs: [],
    username: "alice",
    password: "hunter2",
    uris: ["https://github.com"],
    customFields: [],
    ...overrides
  } as LoginItem;
}

describe("readKeePassLoginFields", () => {
  it("reads the standard fields through their aliases", () => {
    const projection = readKeePassLoginFields(fields({ Name: "Router", Login: "admin", pwd: secret("s3cret"), Website: "http://192.168.1.1", Comment: "备注" }));

    expect(projection).toMatchObject({ title: "Router", username: "admin", password: "s3cret", url: "http://192.168.1.1", notes: "备注" });
  });

  it("classifies an entry with a bare SSID as Wi-Fi even without MonicaLoginType", () => {
    const projection = readKeePassLoginFields(fields({ Title: "Home", SSID: "MyNetwork", Password: secret("wifi-pass") }));

    expect(projection.loginType).toBe("WIFI");
    expect(JSON.parse(projection.wifiMetadata!)).toEqual({ ssid: "MyNetwork" });
  });

  it("prefers the stored MonicaWifiData over a reconstructed one", () => {
    const stored = JSON.stringify({ ssid: "MyNetwork", security: "WPA2" });
    const projection = readKeePassLoginFields(fields({ Title: "Home", MonicaLoginType: "WIFI", SSID: "MyNetwork", MonicaWifiData: stored }));

    expect(projection.wifiMetadata).toBe(stored);
  });

  it("classifies SSO from the provider field alone", () => {
    expect(readKeePassLoginFields(fields({ Title: "Corp", "SSO Provider": "Okta" })).loginType).toBe("SSO");
  });

  it("leaves an ordinary entry as PASSWORD", () => {
    expect(readKeePassLoginFields(fields({ Title: "GitHub", UserName: "alice" })).loginType).toBe("PASSWORD");
  });

  it("collects the SSH fields into a single JSON blob", () => {
    const projection = readKeePassLoginFields(
      fields({ Title: "server", MonicaLoginType: "SSH_KEY", MonicaSshAlgorithm: "ed25519", MonicaSshKeySize: "256", MonicaSshPrivateKey: secret("PRIVATE") })
    );

    expect(projection.loginType).toBe("SSH_KEY");
    expect(JSON.parse(projection.sshKeyData!)).toMatchObject({ algorithm: "ed25519", keySize: 256, privateKeyOpenSsh: "PRIVATE", format: "OPENSSH" });
  });

  it("leaves sshKeyData undefined when the entry has no SSH fields", () => {
    expect(readKeePassLoginFields(fields({ Title: "GitHub" })).sshKeyData).toBeUndefined();
  });
});

describe("resolveKeePassEntryPassword", () => {
  it("uses the standard Password field when it holds a real value", () => {
    expect(resolveKeePassEntryPassword(fields({ Password: secret("hunter2") }))).toBe("hunter2");
  });

  it("ignores a Password field that just repeats the label", () => {
    expect(resolveKeePassEntryPassword(fields({ Password: secret("password"), 密码: secret("真密码") }))).toBe("真密码");
  });

  it("promotes an unknown protected field when there is no password anywhere else", () => {
    expect(resolveKeePassEntryPassword(fields({ Title: "Bank", "Login PIN": secret("4821") }))).toBe("4821");
  });

  it("never promotes an unprotected custom field, which is data rather than a secret", () => {
    expect(resolveKeePassEntryPassword(fields({ Title: "Bank", "Recovery code": "ABCD-EFGH" }))).toBe("");
  });

  it("never promotes a known field such as a TOTP seed", () => {
    expect(resolveKeePassEntryPassword(fields({ Title: "Bank", "TOTP Seed": secret("JBSWY3DPEHPK3PXP") }))).toBe("");
  });
});

describe("buildKeePassLoginFields", () => {
  it("always writes the five standard fields, with Password protected", () => {
    const written = buildKeePassLoginFields({ item: login({ notes: "", uris: [] }) });

    expect([...written.keys()]).toEqual(["Title", "UserName", "Password", "URL", "Notes"]);
    expect(written.get("URL")).toBe("");
    expect(written.get("Password")).toBeInstanceOf(kdbxweb.ProtectedValue);
  });

  it("omits an optional field instead of writing an empty string, so it does not look deleted", () => {
    const written = buildKeePassLoginFields({ item: login({ email: "", appName: "  " }) });

    expect(written.has("Email")).toBe(false);
    expect(written.has("App Name")).toBe(false);
  });

  it("does not write MonicaLoginType for an ordinary password entry", () => {
    expect(buildKeePassLoginFields({ item: login({ loginType: "PASSWORD" }) }).has("MonicaLoginType")).toBe(false);
  });

  it("writes the SSO projection only for an SSO entry", () => {
    const written = buildKeePassLoginFields({ item: login({ loginType: "SSO", ssoProvider: "Okta", ssoRefEntryId: 42 }) });

    expect(written.get("MonicaLoginType")).toBe("SSO");
    expect(written.get("SSO Provider")).toBe("Okta");
    expect(written.get("MonicaSsoRefEntryId")).toBe("42");
  });

  it("falls back to the title for the SSID when the Wi-Fi metadata has none", () => {
    const written = buildKeePassLoginFields({ item: login({ title: "Home网络", loginType: "WIFI", wifiMetadata: "" }) });

    expect(written.get("SSID")).toBe("Home网络");
    expect(written.has("MonicaWifiData")).toBe(false);
  });

  it("protects the card number, CVV and SSH private key but not their labels", () => {
    const written = buildKeePassLoginFields({
      item: login({ loginType: "SSH_KEY", sshKeyData: JSON.stringify({ algorithm: "rsa", keySize: 4096, privateKeyOpenSsh: "KEY", publicKeyOpenSsh: "PUB" }) })
    });

    expect(written.get("MonicaSshPrivateKey")).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(written.get("MonicaSshPublicKey")).toBe("PUB");
    expect(written.get("MonicaSshKeySize")).toBe("4096");
  });

  it("skips a custom field whose name collides with a field already written", () => {
    const written = buildKeePassLoginFields({
      item: login({ customFields: [{ name: "email", value: "shadow@example.com", protected: false }], email: "real@example.com" })
    });

    expect(written.get("Email")).toBe("real@example.com");
    expect(written.has("email")).toBe(false);
  });

  it("skips a plugin field so an _etm_ template is never overwritten by a custom field", () => {
    const written = buildKeePassLoginFields({ item: login({ customFields: [{ name: "_etm_title_0", value: "x", protected: false }] }) });

    expect(written.has("_etm_title_0")).toBe(false);
  });

  it("writes MonicaLocalId only when Android assigned one", () => {
    expect(buildKeePassLoginFields({ item: login() }).has("MonicaLocalId")).toBe(false);
    expect(buildKeePassLoginFields({ item: login(), monicaLocalId: 7 }).get("MonicaLocalId")).toBe("7");
  });
});

describe("buildKeePassLoginPatch", () => {
  it("preserves a third-party field, a plugin field and a TOTP field through an edit", () => {
    const existing = fields({
      Title: "GitHub",
      UserName: "old",
      Password: secret("old"),
      "TOTP Seed": secret("JBSWY3DPEHPK3PXP"),
      _etm_template: "1",
      "KeePassXC Browser Settings": "{}"
    });

    const updated = applyKeePassFieldPatch(existing, buildKeePassLoginPatch({ item: login() }));

    expect(keePassFieldText(updated.get("TOTP Seed"))).toBe("JBSWY3DPEHPK3PXP");
    expect(updated.get("_etm_template")).toBe("1");
    expect(updated.get("KeePassXC Browser Settings")).toBe("{}");
    expect(updated.get("UserName")).toBe("alice");
  });

  it("removes a Monica-owned field the item no longer carries", () => {
    const existing = fields({ Title: "GitHub", Email: "old@example.com", "App Name": "GitHub" });

    const updated = applyKeePassFieldPatch(existing, buildKeePassLoginPatch({ item: login({ email: undefined }) }));

    expect(updated.has("Email")).toBe(false);
    expect(updated.has("App Name")).toBe(false);
  });

  it("deletes a custom field whose value was cleared rather than leaving it blank", () => {
    const existing = fields({ Title: "GitHub", "Recovery code": "ABCD" });

    const updated = applyKeePassFieldPatch(existing, buildKeePassLoginPatch({ item: login({ customFields: [{ name: "Recovery code", value: "", protected: false }] }) }));

    expect(updated.has("Recovery code")).toBe(false);
  });

  it("keeps a custom field the item still carries", () => {
    const existing = fields({ Title: "GitHub", "Recovery code": "ABCD" });

    const updated = applyKeePassFieldPatch(existing, buildKeePassLoginPatch({ item: login({ customFields: [{ name: "Recovery code", value: "WXYZ", protected: true }] }) }));

    expect(keePassFieldText(updated.get("Recovery code"))).toBe("WXYZ");
    expect(updated.get("Recovery code")).toBeInstanceOf(kdbxweb.ProtectedValue);
  });
});

describe("entry classification", () => {
  it("recognises a KeePass2Android template entry", () => {
    expect(isKeePassTemplateEntry(fields({ _etm_template: "1", Title: "Credit Card", _etm_title_0: "Number" }))).toBe(true);
  });

  it("does not treat a real entry that happens to carry a template marker as a template", () => {
    expect(isKeePassTemplateEntry(fields({ _etm_template: "1", Title: "Credit Card", UserName: "alice" }))).toBe(false);
  });

  it("treats a disabled template marker as an ordinary entry", () => {
    expect(isKeePassTemplateEntry(fields({ _etm_template: "0", Title: "Credit Card" }))).toBe(false);
  });

  it("detects an entry with nothing in any standard field", () => {
    expect(isKeePassEmptyEntry(fields({ "Some Field": "x" }))).toBe(true);
    expect(isKeePassEmptyEntry(fields({ Title: "GitHub" }))).toBe(false);
  });

  it("detects TOTP fields only when they hold a value", () => {
    expect(keePassEntryHasTotpFields(fields({ otp: secret("otpauth://totp/x?secret=A") }))).toBe(true);
    expect(keePassEntryHasTotpFields(fields({ "TOTP Seed": "  " }))).toBe(false);
  });
});

describe("readKeePassCustomFields", () => {
  it("returns exactly the unknown-role fields, keeping their protection", () => {
    const custom = readKeePassCustomFields(fields({ Title: "GitHub", "TOTP Seed": "x", "Recovery code": secret("ABCD"), Note2: "plain" }));

    expect(custom).toEqual([
      { name: "Recovery code", value: "ABCD", protected: true },
      { name: "Note2", value: "plain", protected: false }
    ]);
  });
});

describe("keePassPreservedFieldNames", () => {
  it("lists everything a browser edit must not touch", () => {
    const names = keePassPreservedFieldNames(fields({ Title: "x", Email: "x", otp: "x", _etm_template: "1", Custom: "x" }));

    expect(names).toEqual(["Title", "otp", "_etm_template", "Custom"]);
  });
});
