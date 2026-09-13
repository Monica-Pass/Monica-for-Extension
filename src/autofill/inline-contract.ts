export interface InlineLoginSuggestion {
  id: string;
  title: string;
  username: string;
  hasTotp: boolean;
  allowLockedAutofill: boolean;
}

export interface InlineAutofillResult {
  sessionId: string;
  enabled: boolean;
  status: "uninitialized" | "locked" | "unlocked";
  candidates: InlineLoginSuggestion[];
  total: number;
}

export const INLINE_SUGGESTION_LIMIT = 20;

export function assertInlineSessionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("自动填充菜单已失效，请重新选择输入框。");
  }
}
