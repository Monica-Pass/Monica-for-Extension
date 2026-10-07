import type { LoginItem, SecureCustomField } from './model';
import { passwordProjectGroups } from './password-project-view';
import { CONTENT_ORDER } from './password-content';
import { PROJECT_CREDENTIAL_FIELD, readProjectCredential } from './project-credentials';
import { parseLosslessJson } from './lossless-json';

export interface PasswordProjectRemovalPlan {
  retained: LoginItem[];
  removed: LoginItem[];
  ownerTransfer?: { sourceItemId: string; targetItemId: string };
}

function patch(fields: SecureCustomField[], values: Record<string, unknown>): SecureCustomField[] {
  return fields.map(field => {
    if (field.name !== PROJECT_CREDENTIAL_FIELD) return field;
    const raw = parseLosslessJson(field.value) as Record<string, unknown>;
    return Object.entries(values).every(([key, value]) => raw[key] === value) ? field
      : { ...field, value: JSON.stringify({ ...raw, ...values }) };
  });
}

/** Preserve the old owner's shared content alongside the new owner's own data. */
function transferFields(source: SecureCustomField[], target: SecureCustomField[]): SecureCustomField[] {
  const result = [...target];
  const counts = new Map<string, number>();
  for (const field of source) {
    if (field.name === PROJECT_CREDENTIAL_FIELD || field.name === CONTENT_ORDER) continue;
    const encoded = JSON.stringify(field), count = (counts.get(encoded) ?? 0) + 1;
    counts.set(encoded, count);
    if (result.filter(candidate => JSON.stringify(candidate) === encoded).length >= count) continue;
    // Duplicating a content manifest would make both copies unreadable. Keep the
    // original project intact so the collision can be resolved explicitly.
    if (field.name.startsWith('monica.') && result.some(candidate => candidate.name === field.name))
      throw new Error('共享内容与保留密码的字段冲突，原密码尚未移除。');
    result.push(field);
  }
  const sourceOrder = source.filter(field => field.name === CONTENT_ORDER);
  const targetOrder = result.filter(field => field.name === CONTENT_ORDER);
  if (sourceOrder.length > 1 || targetOrder.length > 1) throw new Error('内容排序字段重复，请先处理原始数据。');
  if (sourceOrder.length) {
    const previous = targetOrder[0];
    if (previous && Object.keys(sourceOrder[0]).some(key => key !== 'value' && key !== 'protected'
      && Object.prototype.hasOwnProperty.call(previous, key)
      && JSON.stringify(previous[key as keyof SecureCustomField]) !== JSON.stringify(sourceOrder[0][key as keyof SecureCustomField])))
      throw new Error('共享内容与保留密码的字段冲突，原密码尚未移除。');
    const tokens = [...new Set([...sourceOrder[0].value.split(','), ...(previous?.value.split(',') ?? [])])].filter(Boolean);
    const merged = { ...sourceOrder[0], ...previous, value: tokens.join(','), protected: !!previous?.protected || sourceOrder[0].protected };
    if (previous) result[result.indexOf(previous)] = merged;
    else result.push(merged);
  }
  return result;
}

/** Plan explicit removals after complete snapshot validation and shared-field reconciliation. */
export function planPasswordProjectRemoval(drafts: LoginItem[], originals: LoginItem[], removedItemIds: string[]): PasswordProjectRemovalPlan {
  if (!Array.isArray(removedItemIds) || !removedItemIds.length || new Set(removedItemIds).size !== removedItemIds.length
    || removedItemIds.some(id => typeof id !== 'string' || !drafts.some(row => row.id === id)))
    throw new Error('移除范围无效，原密码尚未移除。');
  const groups = passwordProjectGroups(drafts);
  const originalGroups = originals.length ? passwordProjectGroups(originals) : [];
  if (!groups || !originalGroups || groups.filter(group => group.primary).length !== 1)
    throw new Error('凭据元数据存在冲突或不受支持，原密码尚未移除。');
  const removedIds = new Set(removedItemIds);
  const remainingGroups = groups.map(group => ({ ...group, rows: group.rows.filter(row => !removedIds.has(row.item.id)) })).filter(group => group.rows.length);
  if (!remainingGroups.length) throw new Error('密码项目至少保留一条密码。');
  const removedGroups = new Set(groups.filter(group => !remainingGroups.some(candidate => candidate.id === group.id)).map(group => `CREDENTIAL:${group.id}`));
  let retained = remainingGroups.flatMap((group, groupOrder) => group.rows.map(({ item }, passwordOrder) => ({ ...item,
    customFields: patch(item.customFields, { primary: groupOrder === 0, groupOrder, passwordOrder })
  })));
  const previousOwner = originalGroups[0]?.rows[0]?.item;
  const draftOwnerId = previousOwner?.id ?? groups[0].rows[0].item.id;
  const source = removedIds.has(draftOwnerId) ? drafts.find(item => item.id === draftOwnerId) : undefined;
  let ownerTransfer: PasswordProjectRemovalPlan['ownerTransfer'];
  if (source) {
    const owner = { ...retained[0], customFields: transferFields(source.customFields, retained[0].customFields) };
    // These project assets are not passwords/OTP/history. Different opaque
    // bindings cannot be merged by picking one and discarding the other.
    if (source.passkeyBindings) {
      if (owner.passkeyBindings && owner.passkeyBindings !== source.passkeyBindings)
        throw new Error('共享内容与保留密码的字段冲突，原密码尚未移除。');
      owner.passkeyBindings = source.passkeyBindings;
    }
    if (source.imagePaths?.length) owner.imagePaths = [...new Set([...(owner.imagePaths ?? []), ...source.imagePaths])];
    retained = [owner, ...retained.slice(1)];
    if (previousOwner) ownerTransfer = { sourceItemId: source.id, targetItemId: owner.id };
  }
  retained = retained.map(item => ({ ...item, customFields: item.customFields.map(field => {
    if (field.name !== CONTENT_ORDER) return field;
    const tokens = field.value.split(',').filter(token => !removedGroups.has(token));
    return tokens.join(',') === field.value ? field : { ...field, value: tokens.join(',') };
  }) }));
  // A retained row always keeps its password identity, protection and unknown JSON.
  if (retained.some(item => readProjectCredential(item.customFields)?.passwordId !== readProjectCredential(drafts.find(row => row.id === item.id)!.customFields)?.passwordId))
    throw new Error('凭据元数据存在冲突或不受支持，原密码尚未移除。');
  return { retained, removed: originals.filter(item => removedIds.has(item.id)), ownerTransfer };
}
