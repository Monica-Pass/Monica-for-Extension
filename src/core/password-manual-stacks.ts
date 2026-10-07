import type { LoginItem, SecureCustomField } from "./model";

export const MANUAL_STACK_FIELD = "__monica_manual_stack_group";
export const NEVER_STACK_FIELD = "__monica_no_stack";
export const PASSWORD_STACK_ACTIONS = ["stack", "never", "auto"] as const;
export type PasswordStackAction = typeof PASSWORD_STACK_ACTIONS[number];
export type PasswordStackSetting = { kind: "auto" | "never" | "invalid" } | { kind: "manual"; groupId: string };

export function isPasswordStackMetadata(name: string): boolean {
  return name === MANUAL_STACK_FIELD || name === NEVER_STACK_FIELD;
}

/** Android's existing custom-field contract; display grouping is separate from passwordGroupId. */
export function readPasswordStackSetting(fields: SecureCustomField[]): PasswordStackSetting {
  const manual = fields.filter(field => field.name === MANUAL_STACK_FIELD);
  const never = fields.filter(field => field.name === NEVER_STACK_FIELD);
  if (manual.length > 1 || never.length > 1 || [...manual, ...never].some(field => field.protected
    || field.fieldType && field.fieldType !== "TEXT" || field.type && field.type !== "text")) return { kind: "invalid" };
  // Android treats every value other than "0" as enabled, including the empty string.
  if (never.length && never[0].value !== "0") return { kind: "never" };
  return manual[0]?.value.trim() ? { kind: "manual", groupId: manual[0].value } : { kind: "auto" };
}

/** Never split an explicit project because one member carries an imported display override. */
export function passwordProjectStackSetting(project: LoginItem[]): PasswordStackSetting {
  const settings = project.map(item => readPasswordStackSetting(item.customFields));
  if (settings.some(value => value.kind === "invalid")) return { kind: "invalid" };
  if (settings.some(value => value.kind === "never")) return { kind: "never" };
  const groups = [...new Set(settings.flatMap(value => value.kind === "manual" ? [value.groupId] : []))];
  return groups.length > 1 ? { kind: "invalid" } : groups.length ? { kind: "manual", groupId: groups[0] } : { kind: "auto" };
}

export function putPasswordStackSetting(fields: SecureCustomField[], action: PasswordStackAction, groupId?: string): SecureCustomField[] {
  if (!PASSWORD_STACK_ACTIONS.includes(action)) throw new Error("堆叠操作无效。");
  if (readPasswordStackSetting(fields).kind === "invalid") throw new Error("堆叠字段格式不受支持，已保留原始字段。");
  if (action === "stack" && (!groupId || !groupId.trim())) throw new Error("手动堆叠标识不能为空。");
  const name = action === "stack" ? MANUAL_STACK_FIELD : NEVER_STACK_FIELD;
  const value = action === "stack" ? groupId! : "1";
  let written = false;
  const result: SecureCustomField[] = [];
  for (const field of fields) {
    if (!isPasswordStackMetadata(field.name)) result.push(field);
    else if (action !== "auto" && field.name === name) {
      result.push(field.value === value ? field : { ...field, value });
      written = true;
    }
  }
  if (action !== "auto" && !written) result.push({ name, value, protected: false });
  return result.length === fields.length && result.every((field, index) => field === fields[index]) ? fields : result;
}
