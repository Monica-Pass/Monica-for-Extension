<script setup lang="ts">
import { computed, ref } from "vue";
import { tr } from "../i18n";
import { BILLING_ADDRESS_FIELDS, editBillingAddressField, readBillingAddress, type BillingAddressField } from "../core/billing-address";
const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const address = computed(() => readBillingAddress(props.modelValue));
const error = ref("");
function edit(key: BillingAddressField, event: Event) {
  try { emit("update:modelValue", editBillingAddressField(props.modelValue, key, (event.target as HTMLInputElement).value)); error.value = ""; }
  catch (cause) { error.value = String(cause); }
}
</script>
<template>
  <section class="billing-address-fields field-wide" :aria-label="tr('账单地址')">
    <h4>{{ tr('账单地址') }}</h4>
    <div v-if="address.editable" class="address-grid">
      <m3e-form-field v-for="(label,key) in BILLING_ADDRESS_FIELDS" :key="key" v-field-label variant="filled" hide-required-marker class="field">
        <label slot="label">{{tr(label)}}</label><input :value="address.fields[key]" @input="edit(key,$event)" autocomplete="off" />
      </m3e-form-field>
    </div>
    <p v-else>{{tr('此地址使用原始文本或未知格式；未编辑时保持原样。')}}</p>
    <m3e-expansion-panel :open="!address.editable"><span slot="header">{{tr('原始格式与附加信息')}}</span>
      <m3e-form-field v-field-label variant="filled" hide-required-marker class="field"><label slot="label">{{tr('账单地址 JSON')}}</label><textarea :value="modelValue" @input="emit('update:modelValue',($event.target as HTMLTextAreaElement).value)" rows="3" /></m3e-form-field>
    </m3e-expansion-panel>
    <p v-if="error" role="alert">{{error}}</p>
  </section>
</template>
<style scoped>.billing-address-fields{min-width:0}.address-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:12px}.billing-address-fields h4{font-weight:500;margin:12px 0}.billing-address-fields m3e-expansion-panel{margin-top:12px}.billing-address-fields textarea{width:100%}</style>
