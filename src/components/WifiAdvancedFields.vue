<script setup lang="ts">
import { watch } from "vue";
import { tr } from "../i18n";
import { materialSelectTag, materialOptionTag } from "../lib/material-controls";
import type { WifiMetadata } from "../core/special-login";
import { changeWifiSettingKind, wifiSettingKind, wifiEapMethods, wifiPhase2Methods } from "../core/wifi-settings";
const props = defineProps<{ wifi: WifiMetadata }>();
const eventValue = (event: Event) => (event.target as HTMLInputElement).value;
const value = (group: "eap" | "proxy" | "ip", key: string, fallback = "") => String(props.wifi[group]?.[key] ?? fallback);
const update = (group: "eap" | "proxy" | "ip", key: string, event: Event, numeric = false) => {
  props.wifi[group] = { ...props.wifi[group], [key]: numeric ? Number(eventValue(event)) : eventValue(event) };
};
const proxyOptions = [{value:"None",label:"无代理"},{value:"Manual",label:"手动代理"},{value:"AutoConfig",label:"自动代理配置"}];
const ipOptions = [{value:"Dhcp",label:"DHCP"},{value:"Static",label:"静态 IP"}];
const macOptions = [{value:"DEFAULT",label:"系统默认"},{value:"RANDOMIZED",label:"随机 MAC"},{value:"DEVICE_MAC",label:"设备 MAC"}];
watch(() => props.wifi.security, security => { if (security.includes("ENTERPRISE") && props.wifi.eap == null) props.wifi.eap = { method: "PEAP", phase2: "MSCHAPV2" }; });
</script>

<template>
  <template v-if="wifi.security.includes('ENTERPRISE') || wifi.eap">
    <m3e-form-field v-field-label variant="filled" class="field"><label slot="label">{{ tr('EAP 方法') }}</label><component :is="materialSelectTag" @input="update('eap', 'method', $event)"><component :is="materialOptionTag" v-for="method in [...new Set([...wifiEapMethods, value('eap','method','PEAP')])]" :key="method" :value="method" :selected.prop="value('eap','method','PEAP') === method">{{ method }}</component></component></m3e-form-field>
    <m3e-form-field v-field-label variant="filled" class="field"><label slot="label">{{ tr('第二阶段认证') }}</label><component :is="materialSelectTag" @input="update('eap', 'phase2', $event)"><component :is="materialOptionTag" v-for="method in [...new Set([...wifiPhase2Methods, value('eap','phase2','MSCHAPV2')])]" :key="method" :value="method" :selected.prop="value('eap','phase2','MSCHAPV2') === method">{{ method }}</component></component></m3e-form-field>
    <m3e-form-field v-for="field in [['anonymousIdentity','匿名身份'],['caCertificate','CA 证书'],['domain','域名']]" :key="field[0]" v-field-label variant="filled" class="field field-wide"><label slot="label">{{ tr(field[1]) }}</label><input :value="value('eap',field[0])" @input="update('eap',field[0],$event)" autocomplete="off" /></m3e-form-field>
  </template>
  <m3e-form-field v-field-label variant="filled" class="field field-wide"><label slot="label">{{ tr('MAC 随机化') }}</label><component :is="materialSelectTag" @input="wifi.macRandomization = eventValue($event)"><component :is="materialOptionTag" v-for="option in macOptions" :key="option.value" :value="option.value" :selected.prop="(wifi.macRandomization ?? 'DEFAULT') === option.value">{{ tr(option.label) }}</component><component :is="materialOptionTag" v-if="wifi.macRandomization && !macOptions.some(o=>o.value===wifi.macRandomization)" :value="wifi.macRandomization" :selected.prop="true">{{ wifi.macRandomization }}</component></component></m3e-form-field>
  <m3e-form-field v-field-label variant="filled" class="field field-wide"><label slot="label">{{ tr('代理设置') }}</label><component :is="materialSelectTag" @input="changeWifiSettingKind(wifi,'proxy',eventValue($event))"><component :is="materialOptionTag" v-for="option in proxyOptions" :key="option.value" :value="option.value" :selected.prop="wifiSettingKind(wifi.proxy,'proxy') === option.value">{{ tr(option.label) }}</component><component :is="materialOptionTag" v-if="!proxyOptions.some(o=>o.value===wifiSettingKind(wifi.proxy,'proxy'))" :value="wifiSettingKind(wifi.proxy,'proxy')" :selected.prop="true">{{ wifiSettingKind(wifi.proxy,'proxy') }}</component></component></m3e-form-field>
  <template v-if="wifiSettingKind(wifi.proxy,'proxy') === 'Manual'">
    <m3e-form-field v-field-label variant="filled" class="field"><label slot="label">{{ tr('代理主机') }}</label><input :value="value('proxy','host')" @input="update('proxy','host',$event)" autocomplete="off" /></m3e-form-field>
    <m3e-form-field v-field-label variant="filled" class="field"><label slot="label">{{ tr('代理端口') }}</label><input type="number" min="0" max="65535" step="1" :value="value('proxy','port','0')" @input="update('proxy','port',$event,true)" /></m3e-form-field>
    <m3e-form-field v-field-label variant="filled" class="field field-wide"><label slot="label">{{ tr('绕过代理的地址') }}</label><input :value="value('proxy','bypassList')" @input="update('proxy','bypassList',$event)" autocomplete="off" /></m3e-form-field>
  </template>
  <m3e-form-field v-if="wifiSettingKind(wifi.proxy,'proxy') === 'AutoConfig'" v-field-label variant="filled" class="field field-wide"><label slot="label">{{ tr('PAC 地址') }}</label><input :value="value('proxy','pacUrl')" @input="update('proxy','pacUrl',$event)" autocomplete="off" /></m3e-form-field>
  <m3e-form-field v-field-label variant="filled" class="field field-wide"><label slot="label">{{ tr('IP 设置') }}</label><component :is="materialSelectTag" @input="changeWifiSettingKind(wifi,'ip',eventValue($event))"><component :is="materialOptionTag" v-for="option in ipOptions" :key="option.value" :value="option.value" :selected.prop="wifiSettingKind(wifi.ip,'ip') === option.value">{{ tr(option.label) }}</component><component :is="materialOptionTag" v-if="!ipOptions.some(o=>o.value===wifiSettingKind(wifi.ip,'ip'))" :value="wifiSettingKind(wifi.ip,'ip')" :selected.prop="true">{{ wifiSettingKind(wifi.ip,'ip') }}</component></component></m3e-form-field>
  <template v-if="wifiSettingKind(wifi.ip,'ip') === 'Static'">
    <m3e-form-field v-for="field in [['ipAddress','IP 地址'],['gateway','网关'],['dns1','DNS 1'],['dns2','DNS 2']]" :key="field[0]" v-field-label variant="filled" class="field"><label slot="label">{{ tr(field[1]) }}</label><input :value="value('ip',field[0])" @input="update('ip',field[0],$event)" autocomplete="off" /></m3e-form-field>
    <m3e-form-field v-field-label variant="filled" class="field"><label slot="label">{{ tr('网络前缀长度') }}</label><input type="number" min="0" max="128" step="1" :value="value('ip','networkPrefixLength','24')" @input="update('ip','networkPrefixLength',$event,true)" /></m3e-form-field>
  </template>
</template>
