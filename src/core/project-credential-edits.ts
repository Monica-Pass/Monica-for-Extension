import type { LoginItem } from './model';
import { passwordGroupKey } from './password-groups';
import { readProjectCredential } from './project-credentials';

// Android saveProjectCredentials copies commonEntry to every password row. These
// fields belong to the project; account/OTP belong to one credential group, while
// passwords, history, custom content, file ownership and remote IDs stay per row.
export const PROJECT_COMMON_FIELDS = ['title', 'notes', 'favorite', 'archivedAt', 'uris', 'uriRules',
  'appName', 'appPackageName', 'email', 'phone', 'addressLine', 'city', 'state', 'zipCode', 'country',
  'creditCardNumber', 'creditCardHolder', 'creditCardExpiry', 'creditCardCVV',
  'customIconType', 'customIconValue', 'customIconUpdatedAt', 'boundNoteId', 'boundNoteEntryId'] as const;

function reconcileProjectFields(items: LoginItem[], previous: Map<string, LoginItem>): LoginItem[] {
  const projects = new Map<string, LoginItem[]>();
  for (const item of items) {
    if (!item.passwordGroupId) continue;
    const key = passwordGroupKey(item), group = projects.get(key) || [];
    group.push(item); projects.set(key, group);
  }
  const replacements = new Map<string, LoginItem>();
  for (const rows of projects.values()) {
    // Never infer an Android project from a legacy/mixed/future set of records.
    if (rows.some(row => !readProjectCredential(row.customFields)
      || previous.has(row.id) && !readProjectCredential(previous.get(row.id)!.customFields))) continue;
    const changed = new Map<typeof PROJECT_COMMON_FIELDS[number], LoginItem>();
    for (const field of PROJECT_COMMON_FIELDS) {
      const encoded = (item: LoginItem) => JSON.stringify([Object.prototype.hasOwnProperty.call(item, field), item[field]]);
      const edited = rows.filter(row => {
        const old = previous.get(row.id);
        return old && passwordGroupKey(old) === passwordGroupKey(row) && encoded(row) !== encoded(old);
      });
      if (!edited.length) continue;
      if (new Set(edited.map(encoded)).size !== 1) throw new Error('同一密码项目的公共字段存在冲突，请重新打开项目核对。');
      changed.set(field, edited[0]);
    }
    if (!changed.size) continue;
    for (const row of rows) {
      const next = { ...row };
      for (const [field, source] of changed) {
        if (Object.prototype.hasOwnProperty.call(source, field)) Object.assign(next, { [field]: source[field] });
        else Reflect.deleteProperty(next, field);
      }
      replacements.set(row.id, next);
    }
  }
  return items.map(item => replacements.get(item.id) || item);
}

/** Reconcile shared fields only within an existing, explicitly scoped Android credential group. */
export function reconcileProjectCredentialEdits(items: LoginItem[], originals: LoginItem[]): LoginItem[] {
  const previous = new Map(originals.map(item => [item.id, item]));
  const groups = new Map<string, LoginItem[]>();
  for (const item of items) {
    const metadata = readProjectCredential(item.customFields);
    const old = previous.get(item.id);
    const oldMetadata = old && readProjectCredential(old.customFields);
    if (!metadata || !oldMetadata || !item.passwordGroupId || metadata.groupId !== oldMetadata.groupId
      || metadata.passwordId !== oldMetadata.passwordId || passwordGroupKey(item) !== passwordGroupKey(old!)) continue;
    const key = JSON.stringify([passwordGroupKey(item), metadata.groupId]);
    const group = groups.get(key) || []; group.push(item); groups.set(key, group);
  }
  const replacements = new Map<string, LoginItem>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const patch: Partial<Pick<LoginItem, 'username' | 'totpSecret'>> = {};
    for (const field of ['username', 'totpSecret'] as const) {
      const edited = group.filter(item => item[field] !== previous.get(item.id)![field]);
      if (!edited.length) continue;
      const baseline = new Set(group.map(item => previous.get(item.id)![field]));
      const values = new Set(edited.map(item => item[field]));
      if (baseline.size !== 1 || values.size !== 1) throw new Error('同一凭据组的账号或验证码存在冲突，请重新打开项目核对。');
      if (field === 'username') patch.username = edited[0].username;
      else patch.totpSecret = edited[0].totpSecret;
    }
    if (Object.keys(patch).length) for (const item of group) replacements.set(item.id, { ...item, ...patch });
  }
  const result = items.map(item => replacements.get(item.id) || item);
  const resultingGroups = new Map<string, { rows: LoginItem[]; extended: boolean }>();
  for (const item of result) {
    const metadata = readProjectCredential(item.customFields);
    if (!metadata || !item.passwordGroupId) continue;
    const key = JSON.stringify([passwordGroupKey(item), metadata.groupId]);
    const group = resultingGroups.get(key) || { rows: [], extended: false };
    const old = previous.get(item.id);
    const oldMetadata = old && readProjectCredential(old.customFields);
    group.rows.push(item);
    group.extended ||= !old || !oldMetadata || oldMetadata.groupId !== metadata.groupId
      || oldMetadata.passwordId !== metadata.passwordId || passwordGroupKey(old) !== passwordGroupKey(item);
    resultingGroups.set(key, group);
  }
  // Android creates every password in a credential group from one shared account
  // and OTP. A new row must agree with the final reconciled values before saving.
  for (const group of resultingGroups.values()) {
    if (group.extended && (new Set(group.rows.map(row => row.username)).size !== 1
      || new Set(group.rows.map(row => row.totpSecret ?? '')).size !== 1)) {
      throw new Error('同一凭据组的账号或验证码存在冲突，请重新打开项目核对。');
    }
  }
  return reconcileProjectFields(result, previous);
}
