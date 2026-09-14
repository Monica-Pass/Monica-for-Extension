export const AUTO_SYNC_PREFERENCES_KEY = "monica.sync.preferences.v1";

/** Device preference, deliberately separate from Android/Bitwarden vault formats. */
export async function readAutomaticSyncEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(AUTO_SYNC_PREFERENCES_KEY);
  const preference = result[AUTO_SYNC_PREFERENCES_KEY] as { enabled?: unknown } | undefined;
  return preference?.enabled !== false;
}

export async function writeAutomaticSyncEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [AUTO_SYNC_PREFERENCES_KEY]: { enabled } });
}
