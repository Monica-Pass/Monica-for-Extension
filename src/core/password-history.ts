import type { LoginItem } from './model';

/** Password-only history, independent of provider whole-entry version history. */
export function capturePasswordHistory(previous: LoginItem, next: LoginItem, changedAt: string): LoginItem {
  const history = previous.passwordHistory;
  next = { ...next, passwordHistoryIncomplete: previous.passwordHistoryIncomplete };
  // The saved row owns its history. An older editor snapshot must not replace it.
  if (previous.password === next.password || !previous.password.trim()) return { ...next, passwordHistory: history };
  let latest = history?.[0];
  for (const row of history || []) if (!latest || Date.parse(row.lastUsedAt) > Date.parse(latest.lastUsedAt)) latest = row;
  if (latest?.password === previous.password) return { ...next, passwordHistory: history };
  // Do not truncate imported histories: Android's local ten-entry retention is
  // not a portable-format limit, and an edit must not discard imported values.
  return { ...next, passwordHistory: [{ password: previous.password, lastUsedAt: changedAt }, ...(history || [])] };
}

/** These backends have no Android password-history carrier; retain the local overlay. */
export function preserveLocalPasswordHistory(local: LoginItem, remote: LoginItem): LoginItem {
  return local.passwordHistory === undefined ? remote : { ...remote, passwordHistory: local.passwordHistory, passwordHistoryIncomplete: local.passwordHistoryIncomplete };
}

export function assertPortablePasswordHistory(item: LoginItem): void {
  if (item.passwordHistoryIncomplete) throw new Error('部分密码历史无法读取，不能完整转移到此密码源，请保留原密码源。');
}
