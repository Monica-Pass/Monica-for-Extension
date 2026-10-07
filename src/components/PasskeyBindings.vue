<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { addPasskeyBinding, PASSKEY_BINDING_FIELDS, patchPasskeyBinding, readPasskeyBindings, removePasskeyBinding } from "../core/passkey-bindings";
import ProtectedValue from "./ProtectedValue.vue";
const props = defineProps<{ raw: string; editable?: boolean }>();
const emit = defineEmits<{ update: [value: string] }>();
const error = ref("");
const labels = { credentialId: "凭据 ID", rpId: "网站域名（RP ID）", rpName: "网站名称", userName: "账号", userDisplayName: "显示名称" };
// Only project strings into Vue reactivity: raw JSON numbers must never be proxied.
const parsed = computed(() => { try { return { rows: readPasskeyBindings(props.raw).map(binding => Object.fromEntries(PASSKEY_BINDING_FIELDS.map(key => [key, binding[key] || ""]))), reason: "" }; } catch (cause) { return { rows: [], reason: String(cause) }; } });
const editing = ref<number>(); const draft = reactive<Record<string, string>>({});
function open(index: number) { Object.assign(draft, parsed.value.rows[index]); editing.value = index; }
function save() { if (editing.value === undefined) return; try { emit("update", patchPasskeyBinding(props.raw, editing.value, draft)); editing.value = undefined; } catch (cause) { error.value = String(cause); } }
function add() { try { emit("update", addPasskeyBinding(props.raw)); } catch (cause) { error.value = String(cause); } }
function remove(index: number) { if (!window.confirm("移除这条绑定元数据？这不会撤销网站上的 Passkey，也不会删除设备私钥。")) return; try { emit("update", removePasskeyBinding(props.raw, index)); editing.value = undefined; } catch (cause) { error.value = String(cause); } }
</script>
<template>
  <div class="passkey-bindings"><p>这里只管理绑定元数据，不创建签名凭据。Android 设备私钥不会迁出；可签名 Passkey 请由网站注册流程创建。</p>
    <p v-if="parsed.reason" role="status">{{ parsed.reason }}</p>
    <section v-for="(row,index) in parsed.rows" :key="index" class="binding-row"><h4>{{ row.rpName || row.rpId || `绑定 ${index+1}` }}</h4>
      <template v-if="editing===index"><m3e-form-field v-for="key in PASSKEY_BINDING_FIELDS" :key="key" v-field-label variant="filled"><label slot="label">{{labels[key]}}</label><input v-model="draft[key]" autocomplete="off" :type="key==='credentialId'?'password':'text'" /></m3e-form-field><m3e-button type="button" variant="text" @click="editing=undefined">取消绑定编辑</m3e-button><m3e-button type="button" variant="tonal" @click="save">保存绑定草稿</m3e-button></template>
      <template v-else><ProtectedValue v-for="key in PASSKEY_BINDING_FIELDS" :key="key" :label="labels[key]" :value="row[key]" :secret="key==='credentialId'"/><div v-if="editable"><m3e-button type="button" variant="tonal" @click="open(index)">编辑绑定元数据</m3e-button><m3e-button type="button" variant="text" @click="remove(index)">移除绑定</m3e-button></div></template>
    </section>
    <m3e-button v-if="editable && !parsed.reason" type="button" variant="text" @click="add">添加绑定元数据</m3e-button><p v-if="error" role="alert">{{error}}</p>
    <m3e-expansion-panel v-if="raw"><span slot="header">完整绑定元数据</span><ProtectedValue label="完整绑定元数据" :value="raw" secret /></m3e-expansion-panel>
  </div>
</template>
<style scoped>.passkey-bindings{display:grid;gap:12px;min-width:0}.binding-row{display:grid;gap:12px;padding:12px;border-radius:20px;background:var(--md-sys-color-surface-container)}.binding-row h4{margin:0;overflow-wrap:anywhere}.passkey-bindings p{overflow-wrap:anywhere;margin:0}</style>
