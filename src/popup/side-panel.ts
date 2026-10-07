/** Do not await a tab/window query here: Edge requires the active click gesture. */
export function openVaultSidePanel(api: Pick<typeof chrome.sidePanel, "open">, windowId: number | null): Promise<void> {
  if (windowId === null || !Number.isSafeInteger(windowId) || windowId < 0) return Promise.reject(new Error("无法读取当前窗口，请重新打开 Monica 弹窗。"));
  return api.open({ windowId });
}
