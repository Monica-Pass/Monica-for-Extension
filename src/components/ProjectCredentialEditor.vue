<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { LoginForm } from '../manager/login-form';
import { addProjectCredentialGroup, setProjectCredentialGroupLabel, addProjectCredentialPassword, projectCredentialFormGroups, setProjectCredentialFormValue, moveProjectCredentialPassword } from '../manager/project-credential-form';
import ContentOrderList from './ContentOrderList.vue';
import { projectRemovalRows, selectProjectPasswordRemoval } from '../manager/project-removal-form';
import { tr } from '../i18n';
const props = defineProps<{ form: LoginForm; canAdd: boolean; canRemoveOriginal: boolean; editing: boolean; hideAddGroup?: boolean; groupLabels: Record<string, string>; groups: NonNullable<ReturnType<typeof projectCredentialFormGroups>> }>();
const selected = computed(() => new Set(props.form.removedPasswordIds ?? []));
const removalRows = computed(() => projectRemovalRows(props.form));
const activeCount = computed(() => removalRows.value.filter(row => !row.removed).length);
type Group = NonNullable<ReturnType<typeof projectCredentialFormGroups>>[number];
const allRemoved = (group: Group) => group.rows.every(row => selected.value.has(row.metadata!.passwordId));
function removable(index: number) { return props.canRemoveOriginal || (index === -1 ? !props.editing : !props.form.groupMembers[index].original); }
function canRemoveGroup(group: Group) { return group.rows.every(row => removable(row.index)) && group.rows.filter(row => !selected.value.has(row.metadata!.passwordId)).length < activeCount.value; }
async function mark(ids: string[], remove: boolean, event: Event) {
  const button = event.currentTarget as HTMLElement;
  const section = button.closest('section');
  const row = button.closest('[data-password-row]');
  try { selectProjectPasswordRemoval(props.form, ids, remove); error.value = ''; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  await nextTick();
  if (button.isConnected) button.focus();
  else (row?.isConnected ? row.querySelector<HTMLElement>('[data-remove-password]') : section?.querySelector<HTMLElement>('[data-remove-group]'))?.focus();
}
const error = ref('');
function add(groupId: string) { try { addProjectCredentialPassword(props.form, groupId); error.value = ''; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
function addGroup() { try { addProjectCredentialGroup(props.form); error.value = ''; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
function label(groupId: string, text: string) { try { setProjectCredentialGroupLabel(props.form, groupId, text); error.value = ''; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
function move(groupId: string, token: string, target: string, after: boolean) { try { moveProjectCredentialPassword(props.form, groupId, token, target, after); error.value = ''; } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); } }
const revealed = ref(new Set<number>());
function toggle(index: number) { const next = new Set(revealed.value); if (!next.delete(index)) next.add(index); revealed.value = next; }
const value = (event: Event) => (event.target as HTMLInputElement).value;
</script>
<template>
  <div class="project-credential-groups" data-project-credential-editor>
    <section v-for="group in groups" :key="group.id" class="project-credential-group" :data-credential-group="group.id" :aria-label="groupLabels[`CREDENTIAL:${group.id}`]">
      <div class="credential-group-heading"><h3>{{ groupLabels[`CREDENTIAL:${group.id}`] }}</h3><m3e-button v-if="group.rows.every(row => removable(row.index))" type="button" variant="text" data-remove-group :disabled="!allRemoved(group) && !canRemoveGroup(group)" @click="mark(group.rows.map(row => row.metadata!.passwordId), !allRemoved(group), $event)">{{ allRemoved(group) ? tr('撤销移除整组') : tr('移除整组') }}</m3e-button></div>
      <p v-if="allRemoved(group)" class="removed-group" role="status">{{ tr('整组待移除，保存项目后生效。') }}</p>
      <template v-else>
      <m3e-expansion-panel v-if="canAdd && group.rows.length > 1 && !selected.size" class="password-order"><span slot="header">{{ tr('密码顺序') }}</span><ContentOrderList :tokens="group.rows.map(row => row.metadata!.passwordId)" :label="token => tr('密码 {0}', {0: group.rows.findIndex(row => row.metadata!.passwordId === token) + 1})" @move="(token,target,after) => move(group.id,token,target,after)" /></m3e-expansion-panel>
      <m3e-form-field class="credential-label" v-field-label variant="filled" hide-subscript="always"><label slot="label">{{ tr('凭据组名称') }}</label><input :value="group.label" autocomplete="off" @input="label(group.id, value($event))" /></m3e-form-field>
      <div class="credential-joined-fields">
        <m3e-form-field v-field-label variant="filled" hide-subscript="always" class="credential-first"><label slot="label">{{ tr('用户名') }}</label><input :value="group.rows[0].username" autocomplete="off" @input="setProjectCredentialFormValue(props.form, group.rows.map(row => row.index), 'username', value($event))" /></m3e-form-field>
        <div v-for="(row, index) in group.rows" :key="row.metadata!.passwordId" class="password-row" :data-password-row="row.metadata!.passwordId" :data-removed="selected.has(row.metadata!.passwordId)">
          <div v-if="selected.has(row.metadata!.passwordId)" class="password-row-heading"><span>{{ tr('密码 {0}', {0: index + 1}) }}<small>{{ tr('待移除 · 保存后生效') }}</small></span>
            <m3e-icon-button v-if="removable(row.index)" type="button" data-remove-password :disabled="!selected.has(row.metadata!.passwordId) && activeCount <= 1" :aria-label="selected.has(row.metadata!.passwordId) ? tr('撤销移除密码 {0}', {0: index + 1}) : tr('移除密码 {0}', {0: index + 1})" @click="mark([row.metadata!.passwordId], !selected.has(row.metadata!.passwordId), $event)"><m3e-icon :name="selected.has(row.metadata!.passwordId) ? 'undo' : 'remove_circle'" /></m3e-icon-button>
          </div>
          <m3e-form-field v-else v-field-label variant="filled" hide-subscript="always"><label slot="label">{{ tr('密码 {0}', {0: index + 1}) }}</label><input :value="row.password" :type="revealed.has(row.index) ? 'text' : 'password'" autocomplete="new-password" @input="setProjectCredentialFormValue(props.form, [row.index], 'password', value($event))" /><span slot="suffix" class="password-row-actions"><m3e-button variant="text" type="button" toggle :selected.prop="revealed.has(row.index)" @beforeinput.prevent @click="toggle(row.index)">{{ revealed.has(row.index) ? tr('隐藏') : tr('显示') }}</m3e-button><m3e-icon-button v-if="removable(row.index)" type="button" data-remove-password :disabled="activeCount <= 1" :aria-label="tr('移除密码 {0}', {0: index + 1})" @click="mark([row.metadata!.passwordId], true, $event)"><m3e-icon name="remove_circle" /></m3e-icon-button></span></m3e-form-field>
        </div>
        <m3e-form-field v-field-label variant="filled" hide-subscript="always" class="credential-last"><label slot="label">{{ tr('内嵌验证码密钥') }}</label><input :value="group.rows[0].otp" type="password" autocomplete="new-password" :placeholder="tr('Base32 或 otpauth URI')" @input="setProjectCredentialFormValue(props.form, group.rows.map(row => row.index), 'totpSecret', value($event))" /></m3e-form-field>
      </div>
      <m3e-button v-if="canAdd" class="add-password" type="button" variant="tonal" shape="rounded" :disabled="form.groupMembers.length >= 99" @click="add(group.id)"><m3e-icon slot="icon" name="add" />{{ tr('添加密码') }}</m3e-button>
      </template>
    </section>
    <m3e-button v-if="canAdd && !hideAddGroup" class="add-group" type="button" variant="tonal" :disabled="form.groupMembers.length >= 99" @click="addGroup"><m3e-icon slot="icon" name="add" />{{ tr('添加凭据组') }}</m3e-button>
    <p v-if="error" role="alert">{{ tr(error) }}</p>
  </div>
</template>
<style scoped>
.project-credential-groups { display: grid; gap: 24px; min-width: 0; }
.add-password { margin-top: 12px; width: 100%; --m3e-button-shape-round: 24px; --m3e-button-small-shape-round: 24px; --m3e-button-shape-pressed-morph: 16px; }
.credential-label { width: 100%; margin-bottom: 12px; --m3e-form-field-container-shape: 24px; }
.password-order { margin-bottom: 12px; }
.add-group { width: 100%; --m3e-button-shape-round: 24px; }
.project-credential-group { min-width: 0; }
.project-credential-group h3 { margin: 0 0 12px; font-size: 1rem; overflow-wrap: anywhere; }
.credential-group-heading, .password-row-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.credential-group-heading { margin-bottom: 12px; flex-wrap: wrap; }
.credential-group-heading h3 { margin: 0; }
.password-row { min-width: 0; background: var(--md-sys-color-surface-container-low); border-radius: 4px; }
.password-row-heading { padding: 0 4px 0 12px; min-height: 48px; }
.password-row-heading > span { min-width: 0; overflow-wrap: anywhere; }
.password-row-heading small { display: block; color: var(--md-sys-color-on-surface-variant); }
.password-row-actions { display: flex; align-items: center; }
.removed-group { padding: 16px; border-radius: 24px; background: var(--md-sys-color-surface-container-low); }
.credential-joined-fields { display: grid; gap: 4px; min-width: 0; }
.credential-joined-fields m3e-form-field { width: 100%; min-width: 0; --m3e-form-field-container-shape: 4px; }
.credential-joined-fields .credential-first { --m3e-form-field-container-shape: 24px 24px 4px 4px; }
.credential-joined-fields .credential-last { --m3e-form-field-container-shape: 4px 4px 24px 24px; }
</style>
