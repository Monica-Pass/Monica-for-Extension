<script setup lang="ts">
import {computed} from 'vue';
import {createLoginItem,type VaultItem,type ProviderAccount} from '../core/model';
import type {LoginForm} from '../manager/login-form';
import {withLoginDraftSource} from '../manager/login-source-scope';
import {ssoAccountCandidates,ssoLogicalId} from '../core/sso-links';
import {materialSelectTag,materialOptionTag} from '../lib/material-controls';
import {tr} from '../i18n';
const props=defineProps<{form:LoginForm;owner?:VaultItem;items:VaultItem[];providers:ProviderAccount[]}>();
const source=computed(()=>props.providers.find(p=>p.id===props.form.providerId));
const supported=computed(()=>source.value && ['local','mdbx2','keepass','bitwarden'].includes(source.value.kind));
const owner=computed(()=>props.owner?.kind==='login'?props.owner:withLoginDraftSource({...createLoginItem({title:''}),id:'sso-draft',providerRefs:source.value?.kind==='local'?[]:[{providerId:props.form.providerId}]},source.value));
const choices=computed(()=>ssoAccountCandidates(owner.value,props.items));
const missing=computed(()=>Boolean(props.form.ssoRefLogicalId&&!choices.value.some(i=>ssoLogicalId(i)===props.form.ssoRefLogicalId)));
function choose(value:string){props.form.ssoRefLogicalId=value;props.form.ssoRefEntryId='';props.form.ssoRefEdited=true;}
</script>
<template>
  <div class="sso-account-picker field-wide">
    <m3e-form-field v-if="supported" v-field-label variant="filled"><label slot="label">{{ tr('关联账号') }}</label><component :is="materialSelectTag" @input="choose(($event.target as HTMLElement & {value:string}).value)">
      <component :is="materialOptionTag" value="" :selected.prop="!form.ssoRefLogicalId">{{ form.ssoRefEntryId && !form.ssoRefEdited ? tr('当前关联（尚未找到）') : tr('不关联账号') }}</component>
      <component v-if="missing" :is="materialOptionTag" :value="form.ssoRefLogicalId" :selected.prop="true">{{ tr('当前关联（尚未找到）') }}</component>
      <component v-for="item in choices" :key="item.id" :is="materialOptionTag" :value="ssoLogicalId(item)" :selected.prop="form.ssoRefLogicalId===ssoLogicalId(item)">{{ item.title }}{{ item.username ? ` · ${item.username}` : '' }}</component>
    </component></m3e-form-field>
    <m3e-button v-if="supported && (form.ssoRefLogicalId || form.ssoRefEntryId)" type="button" variant="text" @click="choose('')">{{ tr('解除账号关联') }}</m3e-button>
    <p v-if="!supported" class="editor-hint">{{ tr('此来源暂不支持修改账号关联，原有关联已保留。') }}</p>
  </div>
</template>
<style scoped>.sso-account-picker {display:grid;gap:8px;min-width:0;}m3e-button{justify-self:start;}</style>
