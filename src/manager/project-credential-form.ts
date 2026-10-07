import { parseLosslessJson } from '../core/lossless-json';
import type { LoginForm } from './login-form';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from '../core/project-credentials';
import type { SecureCustomField } from '../core/model';
import { contentOrder, orderedContentTokens, withContentOrder } from '../core/password-content';

export function projectCredentialFormGroups(form: LoginForm) {
  const rows = [{ index: -1, username: form.username, password: form.password, otp: form.totpSecret,
    metadata: readProjectCredential(form.customFields) }, ...form.groupMembers.map((row, index) => ({
      index, username: row.username, password: row.password,
      otp: row.totpSecret !== undefined ? row.totpSecret : row.original?.totpSecret ?? '',
      metadata: readProjectCredential(row.customFields ?? row.original?.customFields ?? [])
    }))];
  if (!form.passwordGroupId || rows.some(row => !row.metadata)
    || new Set(rows.map(row => row.metadata?.passwordId)).size !== rows.length) return undefined;
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = groups.get(row.metadata!.groupId) || []; group.push(row); groups.set(row.metadata!.groupId, group);
  }
  if ([...groups.values()].some(rows => new Set(rows.map(row => row.username)).size !== 1
    || new Set(rows.map(row => row.otp)).size !== 1
    || new Set(rows.map(row => JSON.stringify([row.metadata!.label, row.metadata!.primary, row.metadata!.groupOrder]))).size !== 1)) return undefined;
  return [...groups.entries()].map(([id, rows]) => {
    rows.sort((a, b) => a.metadata!.passwordOrder - b.metadata!.passwordOrder);
    return { id, label: rows[0].metadata!.label, primary: rows[0].metadata!.primary, order: rows[0].metadata!.groupOrder, rows };
  }).sort((a, b) => Number(b.primary) - Number(a.primary) || a.order - b.order);
}

/** Compute on drafts only; opening an editor never materializes missing order fields. */
export function projectCredentialContentTokens(form: LoginForm): string[] {
  const groups = projectCredentialFormGroups(form);
  const primary = new Set(groups?.filter(group => group.primary).map(group => `CREDENTIAL:${group.id}`));
  return [...new Set([...orderedContentTokens(form.customFields),
    ...(groups?.filter(group => !group.primary).map(group => `CREDENTIAL:${group.id}`) ?? [])])].filter(token => !primary.has(token));
}

function patchMetadata(fields: SecureCustomField[], patch: Record<string, unknown>): SecureCustomField[] {
  return fields.map(field => {
    if (field.name !== PROJECT_CREDENTIAL_FIELD) return field;
    const raw = parseLosslessJson(field.value) as Record<string, unknown>;
    if (Object.entries(patch).every(([key, value]) => raw[key] === value)) return field;
    return { ...field, value: JSON.stringify({ ...raw, ...patch }) };
  });
}

/** Android saves extra groups in content order and always keeps the primary group first. */
export function updateProjectContentFields(form: LoginForm, fields: SecureCustomField[]): void {
  const next = { ...form, customFields: fields };
  const groups = projectCredentialFormGroups(next);
  if (groups && JSON.stringify(contentOrder(fields)) !== JSON.stringify(contentOrder(form.customFields))) {
    const tokens = projectCredentialContentTokens(next);
    const ordered = [...groups].sort((a, b) => Number(b.primary) - Number(a.primary)
      || tokens.indexOf(`CREDENTIAL:${a.id}`) - tokens.indexOf(`CREDENTIAL:${b.id}`));
    const updates = ordered.flatMap((group, groupOrder) => group.rows.map(row => {
      const member = row.index === -1 ? undefined : form.groupMembers[row.index];
      const original = row.index === -1 ? fields : member!.customFields ?? member!.original!.customFields;
      // Each row can become the selected record after sorting. Carry the project
      // order to all rows, preserving their field attributes and unknown tokens.
      return { index: row.index, fields: patchMetadata(withContentOrder(original, contentOrder(fields)), { groupOrder }) };
    }));
    for (const update of updates) {
      if (update.index === -1) fields = update.fields;
      else form.groupMembers[update.index].customFields = update.fields;
    }
  }
  form.customFields = fields;
}

/** Reorder password identities, not row contents or attachment ownership. */
export function moveProjectCredentialPassword(form: LoginForm, groupId: string, passwordId: string, targetId: string, after = false): void {
  const group = projectCredentialFormGroups(form)?.find(group => group.id === groupId);
  if (!group) throw new Error('无法编辑凭据组，请重新打开项目。');
  const rows = [...group.rows];
  const source = rows.findIndex(row => row.metadata!.passwordId === passwordId);
  if (source < 0 || !rows.some(row => row.metadata!.passwordId === targetId)) throw new Error('无法编辑凭据组，请重新打开项目。');
  if (passwordId === targetId) return;
  const [row] = rows.splice(source, 1);
  rows.splice(rows.findIndex(row => row.metadata!.passwordId === targetId) + Number(after), 0, row);
  if (rows.every((row, index) => row === group.rows[index])) return;
  const updates = rows.map((row, passwordOrder) => {
    const member = row.index === -1 ? undefined : form.groupMembers[row.index];
    return { index: row.index, fields: patchMetadata(row.index === -1 ? form.customFields : member!.customFields ?? member!.original!.customFields, { passwordOrder }) };
  });
  for (const update of updates) {
    if (update.index === -1) form.customFields = update.fields;
    else form.groupMembers[update.index].customFields = update.fields;
  }
}
export function setProjectCredentialFormValue(form: LoginForm, indexes: number[], field: 'username' | 'password' | 'totpSecret', value: string) {
  for (const index of indexes) {
    if (index === -1) form[field] = value;
    else form.groupMembers[index][field] = value;
  }
}

/** Add a new password identity; existing metadata and source snapshots remain untouched. */
export function addProjectCredentialPassword(form: LoginForm, groupId: string) {
  const groups = projectCredentialFormGroups(form);
  const group = groups?.find(group => group.id === groupId);
  if (!group || form.groupMembers.length >= 99) throw new Error('无法添加密码，请检查凭据组或项目数量。');
  const first = group.rows[0]; const metadata = first.metadata!;
  const passwordOrder = Math.max(...group.rows.map(row => row.metadata!.passwordOrder)) + 1;
  if (passwordOrder > 2147483647) throw new Error('无法添加密码，请检查凭据组或项目数量。');
  const id = crypto.randomUUID();
  form.groupMembers.push({ id, username: first.username, password: '', totpSecret: first.otp,
    customFields: [{ name: PROJECT_CREDENTIAL_FIELD, protected: false, value: JSON.stringify({
      version: 1, ...metadata, passwordId: crypto.randomUUID(), passwordOrder
    }) }] });
  return id;
}

export function addProjectCredentialGroup(form: LoginForm) {
  const groups = projectCredentialFormGroups(form);
  if (!groups?.length || form.groupMembers.length >= 99) throw new Error('无法添加凭据组，请检查项目内容或数量。');
  const order = Math.max(...groups.map(group => group.order)) + 1;
  if (order > 2147483647) throw new Error('无法添加凭据组，请检查项目内容或数量。');
  const groupId = crypto.randomUUID();
  form.groupMembers.push({ id: crypto.randomUUID(), username: '', password: '', totpSecret: '', customFields: [{
    name: PROJECT_CREDENTIAL_FIELD, protected: false, value: JSON.stringify({ version: 1,
      projectId: groups[0].rows[0].metadata!.projectId, groupId, passwordId: crypto.randomUUID(),
      label: '', primary: false, groupOrder: order, passwordOrder: 0 })
  }] });
  return groupId;
}

/** Opt a new, not-yet-persisted single-password draft into Android project grouping. */
export function startProjectCredentialGroups(form: LoginForm) {
  if (form.passwordGroupId || form.groupMembers.length || form.customFields.some(field => field.name === PROJECT_CREDENTIAL_FIELD))
    throw new Error('无法添加凭据组，请检查项目内容或数量。');
  const projectId = crypto.randomUUID();
  const primary = { name: PROJECT_CREDENTIAL_FIELD, protected: false, value: JSON.stringify({ version: 1, projectId,
    groupId: crypto.randomUUID(), passwordId: crypto.randomUUID(), label: '', primary: true, groupOrder: 0, passwordOrder: 0 }) };
  form.passwordGroupId = projectId;
  form.customFields = [...form.customFields, primary];
  return addProjectCredentialGroup(form);
}

export function setProjectCredentialGroupLabel(form: LoginForm, groupId: string, label: string) {
  const group = projectCredentialFormGroups(form)?.find(group => group.id === groupId);
  if (!group) throw new Error('无法编辑凭据组，请重新打开项目。');
  const updates = group.rows.map(row => {
    const member = row.index === -1 ? undefined : form.groupMembers[row.index];
    const fields = row.index === -1 ? form.customFields : member!.customFields ?? member!.original!.customFields;
    return { index: row.index, fields: fields.map(field => {
      if (field.name !== PROJECT_CREDENTIAL_FIELD || row.metadata!.label === label) return field;
      const raw = parseLosslessJson(field.value) as Record<string, unknown>;
      return { ...field, value: JSON.stringify({ ...raw, label }) };
    }) };
  });
  for (const update of updates) {
    if (update.index === -1) form.customFields = update.fields;
    else form.groupMembers[update.index].customFields = update.fields;
  }
}
