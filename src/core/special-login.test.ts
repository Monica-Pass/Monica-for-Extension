import { describe, expect, it } from "vitest";
import { buildWifiQrPayload, parseSshKeyMetadata, parseWifiMetadata, serializeSshKeyMetadata, serializeWifiMetadata } from "./special-login";

describe("Android special login records", () => {
  it("preserves future Wi-Fi fields while editing browser fields", () => {
    const raw = '{"ssid":"Old","security":"WPA3","future":{"keep":true},"proxy":{"kind":"Manual","host":"proxy"}}';
    const parsed = parseWifiMetadata(raw);
    const output = JSON.parse(serializeWifiMetadata(raw, { ...parsed, ssid: "Monica;Lab", hiddenNetwork: true }));
    expect(output).toMatchObject({ ssid: "Monica;Lab", hiddenNetwork: true, security: "WPA3", future: { keep: true }, proxy: { kind: "Manual", host: "proxy" } });
    expect(buildWifiQrPayload({ ...parsed, ssid: "Monica;Lab", hiddenNetwork: true }, "secret", "joy")).toBe("WIFI:T:WPA;S:Monica\\;Lab;P:secret;I:joy;H:true;;");
  });

  it("keeps untouched Wi-Fi metadata byte-identical", () => {
    const raw = '{"future":7,"ssid":"Lab","security":"WPA3","proxy":{"kind":"None"}}';
    expect(serializeWifiMetadata(raw, parseWifiMetadata(raw))).toBe(raw);
  });

  it("preserves future SSH fields and Android OpenSSH names", () => {
    const raw = '{"algorithm":"ED25519","keySize":256,"publicKeyOpenSsh":"ssh-ed25519 AAAA","future":7}';
    const parsed = parseSshKeyMetadata(raw);
    const output = JSON.parse(serializeSshKeyMetadata(raw, { ...parsed, comment: "joy@monica" }));
    expect(output).toMatchObject({ algorithm: "ED25519", keySize: 256, publicKeyOpenSsh: "ssh-ed25519 AAAA", comment: "joy@monica", future: 7, format: "OPENSSH" });
  });

  it("keeps untouched SSH metadata byte-identical", () => {
    const raw = '{"future":true,"algorithm":"RSA","keySize":4096,"publicKeyOpenSsh":"ssh-rsa AAAA","privateKeyOpenSsh":"private","fingerprintSha256":"SHA256:x","comment":"","format":"OPENSSH"}';
    expect(serializeSshKeyMetadata(raw, parseSshKeyMetadata(raw))).toBe(raw);
  });
});
