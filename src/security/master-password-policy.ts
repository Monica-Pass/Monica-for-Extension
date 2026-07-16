export const MIN_MASTER_PASSWORD_LENGTH = 4;
export const MAX_MASTER_PASSWORD_LENGTH = 1_024;

export function validateMasterPassword(value: string): void {
  if (value.length < MIN_MASTER_PASSWORD_LENGTH) throw new Error(`主密码至少需要 ${MIN_MASTER_PASSWORD_LENGTH} 个字符。`);
  if (value.length > MAX_MASTER_PASSWORD_LENGTH) throw new Error(`主密码不能超过 ${MAX_MASTER_PASSWORD_LENGTH} 个字符。`);
}
