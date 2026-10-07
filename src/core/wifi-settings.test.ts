import { describe, expect, it } from "vitest";
import { parseWifiMetadata, serializeWifiMetadata } from "./special-login";
import { changeWifiSettingKind, wifiAdvancedDetailFields, wifiSettingKind } from "./wifi-settings";

describe("Android Wi-Fi settings editing", () => {
  it("writes Android sealed-class names and removes only old variant fields", () => {
    const raw = '{"ssid":"Test","proxy":{"kind":"takagi.ru.monica.data.model.WifiProxy.Manual","host":"old","port":8080,"bypassList":"localhost","future":9007199254740993},"ip":{"kind":"takagi.ru.monica.data.model.WifiIp.Static","gateway":"192.0.2.1","future":true}}';
    const wifi = parseWifiMetadata(raw);
    changeWifiSettingKind(wifi, "proxy", "AutoConfig");
    wifi.proxy!.pacUrl = "https://example.test/proxy.pac";
    changeWifiSettingKind(wifi, "ip", "Dhcp");
    const written = serializeWifiMetadata(raw, wifi);
    expect(written).toContain('"future":9007199254740993');
    expect(JSON.parse(written)).toMatchObject({ proxy: { kind: "takagi.ru.monica.data.model.WifiProxy.AutoConfig", pacUrl: "https://example.test/proxy.pac" }, ip: { kind: "takagi.ru.monica.data.model.WifiIp.Dhcp", future: true } });
    expect(JSON.parse(written).proxy).not.toHaveProperty("host");
    expect(JSON.parse(written).ip).not.toHaveProperty("gateway");
  });
  it("does not normalize an unchanged legacy variant and surfaces unknown variants", () => {
    const raw = '{"proxy":{"kind":"Manual","host":"legacy"},"ip":{"kind":"future-ip"}}';
    const wifi = parseWifiMetadata(raw);
    changeWifiSettingKind(wifi, "proxy", "Manual");
    expect(serializeWifiMetadata(raw, wifi)).toBe(raw);
    expect(wifiSettingKind(wifi.ip, "ip")).toBe("future-ip");
    expect(() => changeWifiSettingKind(wifi, "ip", "future-ip")).toThrow();
  });
  it("discloses Android defaults and complete configured advanced fields", () => {
    const fields = wifiAdvancedDetailFields(parseWifiMetadata('{"eap":{"anonymousIdentity":"0007","domain":"example.test","caCertificate":"CA"},"proxy":{"kind":"takagi.ru.monica.data.model.WifiProxy.Manual","host":"proxy","port":0,"bypassList":"localhost"},"ip":{"kind":"takagi.ru.monica.data.model.WifiIp.Static","ipAddress":"192.0.2.7","gateway":"192.0.2.1","dns1":"192.0.2.2","dns2":"192.0.2.3"}}'));
    expect(Object.fromEntries(fields.map(f=>[f.label,f.value]))).toMatchObject({"EAP 方法":"PEAP","第二阶段认证":"MSCHAPV2","匿名身份":"0007","代理端口":"0","网络前缀长度":"24","DNS 2":"192.0.2.3"});
  });
});
