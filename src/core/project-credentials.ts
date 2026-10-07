import type { SecureCustomField } from './model';
import { parseLosslessJson } from './lossless-json';

/** Android ProjectCredentialGroup metadata; secrets remain on the login records. */
export const PROJECT_CREDENTIAL_FIELD = 'monica.content.credential';
export interface ProjectCredentialMetadata {
  projectId?: string;
  groupId: string;
  passwordId: string;
  label: string;
  primary: boolean;
  groupOrder: number;
  passwordOrder: number;
}
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** Read only: never serialize this projection over the original custom field. */
export function readProjectCredential(fields: SecureCustomField[]): ProjectCredentialMetadata | undefined {
  const matches = fields.filter(field => field.name === PROJECT_CREDENTIAL_FIELD);
  if (matches.length !== 1) return undefined;
  try {
    const raw = JSON.parse(matches[0].value);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return undefined;
    if (typeof raw.groupId !== 'string' || !uuid.test(raw.groupId)
      || typeof raw.passwordId !== 'string' || !uuid.test(raw.passwordId)
      || raw.projectId != null && (typeof raw.projectId !== 'string' || !uuid.test(raw.projectId))
      || typeof raw.label !== 'string' || typeof raw.primary !== 'boolean'
      || !Number.isInteger(raw.groupOrder) || raw.groupOrder < 0 || raw.groupOrder > 2147483647
      || !Number.isInteger(raw.passwordOrder) || raw.passwordOrder < 0 || raw.passwordOrder > 2147483647) return undefined;
    return { projectId: raw.projectId ?? undefined, groupId: raw.groupId, passwordId: raw.passwordId,
      label: raw.label, primary: raw.primary, groupOrder: raw.groupOrder, passwordOrder: raw.passwordOrder };
  } catch { return undefined; }
}

/** Android copies retain credential identities within a newly scoped project (Metadata.forProject). */
export function rebaseProjectCredentialFields(fields: SecureCustomField[], projectId: string): SecureCustomField[] {
  if (!fields.some(field => field.name === PROJECT_CREDENTIAL_FIELD)) return fields;
  const metadata = readProjectCredential(fields);
  if (!metadata || !uuid.test(projectId)) throw new Error('无法更新凭据项目标识，请先检查原始元数据。');
  if (metadata.projectId === projectId) return fields;
  return fields.map(field => field.name !== PROJECT_CREDENTIAL_FIELD ? field : {
    ...field, value: JSON.stringify({ ...(parseLosslessJson(field.value) as Record<string, unknown>), projectId })
  });
}
