import { isContentMetadata } from '../core/password-content';
import { isCredentialMetadata } from '../core/credential-fields';
import type { SecureCustomField } from '../core/model';

export type AutofillCustomField = Pick<SecureCustomField, 'name' | 'value' | 'fieldType' | 'type'>;

/** These carriers belong to the password project's editor, never to website forms. */
export function websiteCustomFields<T extends { name: string; value: string }>(fields: readonly T[]): T[] {
  return fields.filter(field => !isContentMetadata(field.name) && !isCredentialMetadata(field.name));
}

/** Retain control semantics without exposing the source envelope or unrelated metadata. */
export function websiteAutofillFields(fields: readonly SecureCustomField[]): AutofillCustomField[] {
  return websiteCustomFields(fields).map(({ name, value, fieldType, type }) => ({ name, value,
    ...(fieldType ? { fieldType } : type ? { type } : {}) }));
}
